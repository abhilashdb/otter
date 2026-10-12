"""Read-only Google Calendar feed for the Overview page.

Uses the connected Google account (calendar.readonly scope) to list upcoming
events on the primary calendar. Not replicated through Electric — the calendar
is external, live data, so the frontend fetches it directly and polls.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import google_client as gc
from ..db import get_session
from ..gsync import _valid_token, get_account

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@router.get("/events")
async def events(
    days: int = Query(default=1, ge=1, le=31),
    start: str | None = Query(default=None, description="Local day 'YYYY-MM-DD' to start from"),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Primary-calendar events for `days` days from `start` (default local today).
    Returns {connected, events:[{id,title,start,end,all_day,location,url}]}."""
    account = await get_account(session)
    if account is None or not account.refresh_token:
        return {"connected": False, "events": []}
    try:
        token = await _valid_token(session, account)
        await session.commit()  # persist a token refreshed inside _valid_token
    except Exception:  # noqa: BLE001 — treat any auth failure as "not connected"
        return {"connected": False, "events": []}

    # Window is [local midnight of `start`, +days). `start` lets the day view page
    # backward/forward; without it we begin at today.
    base = datetime.now().astimezone()
    if start and _DATE_RE.match(start):
        base = datetime.fromisoformat(f"{start}T00:00:00").astimezone()
    start_dt = base.replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        items = await gc.list_calendar_events(
            token, start_dt.isoformat(), (start_dt + timedelta(days=days)).isoformat(), max_results=100
        )
    except Exception:  # noqa: BLE001 — connected, but the fetch failed transiently
        return {"connected": True, "events": []}

    out: list[dict] = []
    for it in items:
        if it.get("status") == "cancelled":
            continue
        s = it.get("start") or {}
        e = it.get("end") or {}
        start_v = s.get("dateTime") or s.get("date")
        if not start_v:
            continue
        out.append(
            {
                "id": it.get("id"),
                "title": it.get("summary") or "(no title)",
                "start": start_v,
                "end": e.get("dateTime") or e.get("date"),
                "all_day": "date" in s,
                "location": it.get("location"),
                "url": it.get("htmlLink"),
            }
        )
    return {"connected": True, "events": out}
