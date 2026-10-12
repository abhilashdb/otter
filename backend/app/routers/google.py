"""Google Tasks integration API: OAuth connect flow, status, and manual sync.

The connected account + tokens live in the backend-only `google_account` table
(never replicated to the browser). Reads still come from PGlite; imported tasks
flow into Postgres and stream back via Electric like any other write.
"""
from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import google_client as gc
from ..config import settings
from ..db import get_session
from ..gsync import get_account, run_sync
from ..models import GoogleAccount

router = APIRouter(prefix="/api/google", tags=["google"])

# Short-lived OAuth state tokens (CSRF guard). In-memory is fine for a local,
# single-user app; they're consumed on callback.
_pending_states: set[str] = set()


@router.get("/status")
async def status(session: AsyncSession = Depends(get_session)) -> dict:
    account = await get_account(session)
    connected = bool(account and account.refresh_token)
    scopes = account.scopes if account else None
    # An account connected before the Gmail/Calendar scopes were added must
    # re-consent before the suggestion engine can read mail or meetings.
    needs_reconnect = connected and not all(s in (scopes or "") for s in gc.SUGGEST_SCOPES)
    return {
        "configured": settings.google_configured,
        "connected": connected,
        "email": account.email if account else None,
        "last_sync_at": account.last_sync_at.isoformat() if account and account.last_sync_at else None,
        "last_sync_error": account.last_sync_error if account else None,
        "needs_reconnect": needs_reconnect,
    }


@router.get("/oauth/start")
async def oauth_start() -> RedirectResponse:
    if not settings.google_configured:
        raise HTTPException(status_code=400, detail="Google client id/secret not configured")
    state = secrets.token_urlsafe(24)
    _pending_states.add(state)
    return RedirectResponse(gc.authorize_url(state))


@router.get("/oauth/callback")
async def oauth_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    if error or not code or not state or state not in _pending_states:
        return RedirectResponse(f"{settings.app_url}/settings?google=error")
    _pending_states.discard(state)

    tokens = await gc.exchange_code(code)
    access = tokens["access_token"]
    refresh = tokens.get("refresh_token")
    expiry = datetime.now(UTC) + timedelta(seconds=int(tokens.get("expires_in", 3600)) - 60)

    email = None
    try:
        email = (await gc.userinfo(access)).get("email")
    except Exception:  # noqa: BLE001 — email is best-effort
        pass

    account = await get_account(session)
    if account is None:
        account = GoogleAccount(id=1)
        session.add(account)
    account.email = email
    account.access_token = access
    # Google only returns a refresh_token on first consent; keep the old one otherwise.
    if refresh:
        account.refresh_token = refresh
    account.token_expiry = expiry
    account.scopes = gc.SCOPES
    account.last_sync_error = None
    await session.commit()
    return RedirectResponse(f"{settings.app_url}/settings?google=connected")


@router.post("/sync")
async def sync(session: AsyncSession = Depends(get_session)) -> dict:
    result = await run_sync(session)
    if not result.get("connected"):
        raise HTTPException(status_code=400, detail="Google not connected")
    return result


@router.post("/disconnect")
async def disconnect(session: AsyncSession = Depends(get_session)) -> dict:
    await session.execute(delete(GoogleAccount).where(GoogleAccount.id == 1))
    await session.commit()
    return {"connected": False}
