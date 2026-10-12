"""Quick-capture: a minimal endpoint for jotting a task from outside the app
(a macOS Shortcut on a global hotkey, or the CLI). Unlike the main tasks API, the
server generates the id here so the caller only has to send a title. The new task
streams into the app via Electric like any other write."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import llm
from ..capture_agent import run_capture_agent
from ..capture_enrich import PENDING_MARKER, enrich_slack_capture, find_slack_link
from ..config import settings
from ..db import get_session
from ..models import Task
from ..schemas import QuickCaptureIn, TaskOut

router = APIRouter(prefix="/api", tags=["capture"])


@router.post("/quick-capture", response_model=TaskOut)
async def quick_capture(
    payload: QuickCaptureIn,
    background: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
) -> Task:
    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")
    notes = (payload.notes or "").strip()
    # If a Slack link was pasted in and we can enrich it, do so in the background
    # (fetch the message via MCP, write a defined title + filing via FMAPI, move
    # the link to links='source'). The response returns immediately either way.
    combined = f"{title}\n{notes}"
    enrich = bool(find_slack_link(combined)) and settings.slack_configured and llm.configured()
    # Show a pending marker while enrichment runs (only when we'd otherwise have an
    # empty body) so the user can see it's working; enrichment always clears it.
    body = PENDING_MARKER if (enrich and not notes) else notes
    task = Task(
        id=uuid.uuid4(),
        title=title,
        body=body,
        status="todo",
        priority="p2",
        due_at=payload.due_at,
    )
    session.add(task)
    await session.commit()
    await session.refresh(task)
    # The task is now durably saved, so a capture is NEVER lost to a downstream
    # failure. Filing/enrichment run in the background and are fully best-effort:
    #   • a Slack link → enrich_slack_capture (fetch + file; unchanged);
    #   • otherwise → the capture agent infers a home (auto-file if confident,
    #     else a pre-filled filing suggestion in the inbox).
    # If either fails, the task simply stays exactly as captured — an unfiled
    # task still shows on Overview/Tasks and gets revisited by the filing scan.
    if enrich:
        background.add_task(enrich_slack_capture, task.id, combined)
    elif settings.capture_agent_enabled and llm.configured():
        background.add_task(run_capture_agent, task.id, title, notes)
    return task
