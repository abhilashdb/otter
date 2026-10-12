"""Task-suggestion API: scan status, trigger a scan, and accept/dismiss proposals.

The suggestion rows themselves reach the browser via Electric (the `suggestions`
table is published); these endpoints only trigger scans and mutate state.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_session
from ..schemas import SuggestionAcceptIn
from ..suggest import (
    accept_suggestion,
    dismiss_suggestion,
    is_scanning,
    start_background_scan,
    status,
)

router = APIRouter(prefix="/api/suggestions", tags=["suggestions"])


@router.get("/status")
async def get_status(session: AsyncSession = Depends(get_session)) -> dict:
    return await status(session)


@router.post("/scan", status_code=202)
async def scan() -> dict:
    """Trigger a scan in the background and return immediately — the user can
    navigate away while it runs; new suggestions stream in via Electric. Poll
    /status (`scanning`) to know when it finishes."""
    if not (settings.google_configured or settings.llm_configured or settings.slack_configured):
        raise HTTPException(
            status_code=400,
            detail="No sources configured — connect Google, or configure the LLM / Slack.",
        )
    started = start_background_scan()
    return {"scanning": True, "started": started, "already_running": is_scanning() and not started}


@router.post("/{sug_id}/accept")
async def accept(
    sug_id: uuid.UUID,
    payload: SuggestionAcceptIn,
    session: AsyncSession = Depends(get_session),
) -> dict:
    try:
        task_id = await accept_suggestion(
            session, sug_id, payload.model_dump(exclude_unset=True)
        )
    except LookupError:
        raise HTTPException(status_code=404, detail="suggestion not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return {"task_id": str(task_id)}


@router.post("/{sug_id}/dismiss")
async def dismiss(sug_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict:
    try:
        await dismiss_suggestion(session, sug_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="suggestion not found") from None
    return {"dismissed": True}
