"""Enrich a quick-captured task that contains a Slack permalink.

When someone pastes a Slack message link into quick-capture (e.g. via the macOS
Shortcut), we: pull the referenced message (with thread context) through the
Slack MCP, ask FMAPI to write a concise task title and file it into the best
area/project, and move the Slack link out of the task text into the task's
`links` as label `source`.

Runs in the background AFTER quick-capture has already created the task and
responded, so the Shortcut/CLI stays fast. Fully best-effort and guarded: any
failure (no Slack config, MCP down, FMAPI error) simply leaves the task exactly
as it was captured — it never raises into the request.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from . import llm, slack_client
from .config import settings
from .db import SessionLocal
from .models import Area, Link, Project, Task
from .suggest import _catalog, _clean_slack

log = logging.getLogger("otter.capture_enrich")

# Shown as the task body while background enrichment is in flight (Slack fetch +
# FMAPI take a few seconds); always cleared when enrichment finishes or fails, so
# the user can see something is happening and it never lingers.
PENDING_MARKER = "⟳ Enriching from the Slack link…"

# https://<workspace>.slack.com/archives/<CHANNEL>/p<16-digit-ts>[?thread_ts=…&cid=…]
_SLACK_LINK = re.compile(
    r"https://[a-z0-9][a-z0-9.\-]*\.slack\.com/archives/([A-Z0-9]+)/p(\d{10,20})(\?\S*)?",
    re.IGNORECASE,
)

_SYSTEM = (
    "You turn a Slack message the user saved into ONE actionable task for their"
    " personal task manager. Write a concise, specific imperative title (<=100"
    " chars, no trailing punctuation) capturing what the user needs to do. Then"
    " file it into the best-matching area and, optionally, a project that belongs"
    " to that area — or null when nothing clearly fits (never force a match)."
    " Areas/projects are given as {code,name,...}; refer to them by code.\n"
    'Return a JSON array with exactly one object:'
    ' {"title": "...", "area": <area code or null>, "project": <project code or null>}.'
)


def find_slack_link(text: str) -> re.Match[str] | None:
    """Cheap check used by the router to decide whether to schedule enrichment."""
    return _SLACK_LINK.search(text or "")


def _permalink_parts(m: re.Match[str]) -> tuple[str, str, str | None]:
    """(channel_id, message_ts, thread_ts|None) from a Slack archive permalink."""
    channel_id = m.group(1)
    digits = m.group(2)
    ts = f"{digits[:-6]}.{digits[-6:]}"  # p1699999999123456 → 1699999999.123456
    thread_ts = None
    tm = re.search(r"thread_ts=([0-9.]+)", m.group(3) or "")
    if tm:
        thread_ts = tm.group(1)
    return channel_id, ts, thread_ts


async def _fetch_slack_text(channel_id: str, ts: str, thread_ts: str | None) -> str:
    """Best-effort read of the referenced message. Try the thread first (gives
    parent + replies for context); fall back to the single message in-channel."""
    parent = thread_ts or ts
    async with slack_client.session() as sc:
        try:
            md = slack_client.unwrap(
                await sc.call(
                    "slack_read_thread",
                    {"channel_id": channel_id, "message_ts": parent, "limit": 20},
                )
            )
            if md.strip():
                return md
        except Exception:  # fall through to a plain channel read
            log.debug("slack_read_thread failed", exc_info=True)
        return slack_client.unwrap(
            await sc.call(
                "slack_read_channel",
                {"channel_id": channel_id, "latest": ts, "oldest": ts, "limit": 1},
            )
        )


async def enrich_slack_capture(task_id: uuid.UUID, text: str) -> None:
    """Background enrichment entry point. Safe to call unconditionally."""
    if not (settings.slack_configured and llm.configured()):
        return
    m = find_slack_link(text)
    if not m:
        return
    url = m.group(0)
    channel_id, ts, thread_ts = _permalink_parts(m)

    try:
        raw_md = await _fetch_slack_text(channel_id, ts, thread_ts)
    except Exception:
        log.warning("slack fetch failed for %s", url, exc_info=True)
        raw_md = ""

    note = _clean_slack(text.replace(url, " ").strip())
    context = _clean_slack(raw_md)[:2500] if raw_md.strip() else note

    async with SessionLocal() as session:
        task = (
            await session.execute(
                select(Task).where(Task.id == task_id, Task.deleted_at.is_(None))
            )
        ).scalars().first()
        if task is None:
            return

        title = ""
        area_id = None
        project_id = None
        # Only ask FMAPI when we actually have something to summarize.
        if context:
            areas = list(
                (await session.execute(select(Area).where(Area.deleted_at.is_(None)))).scalars()
            )
            projects = list(
                (await session.execute(select(Project).where(Project.deleted_at.is_(None)))).scalars()
            )
            catalog, area_map, proj_map = _catalog(areas, projects)
            user = json.dumps(
                {
                    "user_note": note or None,
                    "slack_message": context,
                    "areas": catalog["areas"],
                    "projects": catalog["projects"],
                },
                ensure_ascii=False,
            )
            try:
                out = llm.parse_json_array(await llm.respond(_SYSTEM, user))
            except Exception:
                log.warning("FMAPI enrichment failed for %s", url, exc_info=True)
                out = []
            prop = out[0] if out else {}
            title = str(prop.get("title") or "").strip()
            # Resolve area/project codes → ids (same rules as the suggestion engine).
            area_id = area_map.get(prop.get("area"))
            proj = proj_map.get(prop.get("project"))
            if proj:
                pid, pacode = proj
                if area_id is None:
                    area_id = area_map.get(pacode)
                if pacode is None or area_map.get(pacode) == area_id:
                    project_id = pid

        # Finalize the task in EVERY path so the pending marker never lingers:
        # use the FMAPI title if we got one, else strip the bare URL out of what
        # was captured. Treat the pending marker as empty body.
        base_body = "" if (task.body or "").strip() == PENDING_MARKER else (task.body or "")
        task.title = title or task.title.replace(url, "").strip() or "Slack: follow up"
        task.body = base_body.replace(url, "").strip()
        if area_id is not None:
            task.area_id = area_id
            task.project_id = project_id
        task.updated_at = datetime.now(UTC)

        # Move the Slack link into the task's links as 'source' (idempotent).
        exists = (
            await session.execute(
                select(Link).where(
                    Link.entity_type == "task",
                    Link.entity_id == task_id,
                    Link.url == url,
                    Link.deleted_at.is_(None),
                )
            )
        ).scalars().first()
        if exists is None:
            session.add(
                Link(
                    id=uuid.uuid4(),
                    entity_type="task",
                    entity_id=task_id,
                    label="source",
                    url=url,
                )
            )

        await session.commit()
