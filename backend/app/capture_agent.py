"""Agentic filing for quick-capture.

After a capture lands as a task, this infers the best area/project from the
user's areas/projects AND how they've already filed existing tasks (a few-shot
signal), together with a confidence score. High confidence
(≥ settings.capture_file_confidence) auto-files the task; lower confidence leaves
it unfiled and drops a pre-filled 'filing' suggestion into the Suggestions inbox
for the user to refine.

Runs in the background after quick-capture responds — best-effort, so any failure
leaves the task exactly as captured. The Slack-link enrichment path
(capture_enrich) is untouched and does its own filing; this agent handles the
non-Slack captures.
"""
from __future__ import annotations

import json
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import llm
from .config import settings
from .db import SessionLocal
from .models import Area, Project, Task
from .suggest import (
    _add_suggestion,
    _apply_filing_rules,
    _catalog,
    _clip,
    _existing_refs,
)
from .tracing import span, trace

log = logging.getLogger("otter.capture_agent")

_MAX_EXAMPLES_PER_AREA = 5
_EXAMPLE_POOL = 60  # recent filed tasks to draw few-shot examples from

_SYSTEM = (
    "You file a newly captured task into the user's areas and projects, learning"
    " from how they have already filed existing tasks (given as examples per"
    " area). Pick an area ONLY when it is a clear, specific match to what the task"
    " is about; prefer null over forcing a weak match. A project is optional and"
    " must belong to the chosen area.\n"
    "- Announcements, newsletters, FYIs and broad notices usually have no good"
    " area — return null. Never file into an area just because both are"
    " 'internal', and don't treat a topic-named area (e.g. Interviews) as a"
    " generic bucket.\n"
    "- confidence: a number in [0,1] for how sure you are of the area (1 ="
    " certain). Be honest — use < 0.7 when you are guessing or unsure.\n"
    "- Areas/projects are given as {code,name,...}; refer to them by code.\n"
    "Return ONLY a JSON array with exactly one object:"
    ' {"area": <area code or null>, "project": <project code or null>,'
    ' "confidence": <0..1>, "reason": "<short phrase>"}.'
)


def _resolve(prop: dict, area_map: dict, proj_map: dict) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    """Resolve area/project codes → ids, inferring the area from the project when
    only a project was given (same rules as the suggestion engine)."""
    area_id = area_map.get(prop.get("area"))
    project_id = None
    proj = proj_map.get(prop.get("project"))
    if proj:
        pid, pacode = proj
        if area_id is None:
            area_id = area_map.get(pacode)
        if pacode is None or area_map.get(pacode) == area_id:
            project_id = pid
    return area_id, project_id


async def _filed_examples(session: AsyncSession, area_code: dict[str, str]) -> list[dict]:
    """Few-shot signal: recent titles the user has filed, grouped by area code."""
    rows = list(
        (
            await session.execute(
                select(Task)
                .where(Task.area_id.is_not(None), Task.deleted_at.is_(None))
                .order_by(Task.created_at.desc())
                .limit(_EXAMPLE_POOL)
            )
        ).scalars()
    )
    by_area: dict[str, list[str]] = {}
    for t in rows:
        code = area_code.get(str(t.area_id))
        if not code:
            continue
        bucket = by_area.setdefault(code, [])
        if len(bucket) < _MAX_EXAMPLES_PER_AREA:
            bucket.append(t.title[:80])
    return [{"area": code, "examples": ex} for code, ex in by_area.items()]


async def run_capture_agent(task_id: uuid.UUID, title: str, notes: str) -> None:
    """Background entry point. Safe to call unconditionally."""
    if not (settings.capture_agent_enabled and llm.configured()):
        return
    try:
        await _file_capture(task_id, title, notes)
    except Exception:  # noqa: BLE001 — never raise out of a background task
        log.warning("capture agent failed for %s", task_id, exc_info=True)


async def _propose(system: str, payload: str) -> tuple[str, dict]:
    """Run the filing LLM call inside a span that records the prompt AND the raw
    response + parsed proposal — so the trace always carries the model output,
    even when the call takes the httpx fallback (which autologging can't see)."""
    with span("llm.file_capture", span_type="LLM") as sp:
        if sp is not None:
            sp.set_inputs({"system": system, "user": payload})
        path = "openai"
        try:
            text = await llm.respond_via_openai(system, payload)
        except Exception:  # noqa: BLE001 — SDK/gateway issue → untraced fallback
            log.debug("openai path failed, falling back to httpx respond()", exc_info=True)
            text = await llm.respond(system, payload)
            path = "httpx"
        rows = llm.parse_json_array(text)
        prop = rows[0] if rows else {}
        if sp is not None:
            sp.set_outputs({"response": text, "parsed": prop})
            sp.set_attributes({"llm.path": path, "llm.model": settings.llm_model})
    return text, prop


@trace("capture.file")
async def _file_capture(task_id: uuid.UUID, title: str, notes: str) -> dict:
    """Infer + apply filing for a fresh capture. Returns a decision dict, which
    the @trace decorator records as the span's output (alongside the args)."""
    async with SessionLocal() as session:
        task = (
            await session.execute(
                select(Task).where(Task.id == task_id, Task.deleted_at.is_(None))
            )
        ).scalars().first()
        # Nothing to do if it vanished or another path already filed it.
        if task is None or task.area_id is not None:
            return {"action": "skipped", "reason": "missing or already filed"}

        areas = list(
            (await session.execute(select(Area).where(Area.deleted_at.is_(None)))).scalars()
        )
        if not areas:
            return {"action": "skipped", "reason": "no areas to file into"}
        projects = list(
            (await session.execute(select(Project).where(Project.deleted_at.is_(None)))).scalars()
        )
        catalog, area_map, proj_map = _catalog(areas, projects)
        # area id → code, to group the few-shot examples.
        area_code = {str(a): c for c, a in area_map.items()}
        examples = await _filed_examples(session, area_code)

        payload = json.dumps(
            {
                "task": {"title": title, "notes": _clip(notes or "", 300)},
                "areas": catalog["areas"],
                "projects": catalog["projects"],
                "filed_examples": examples,
            },
            ensure_ascii=False,
        )

        text, prop = await _propose(_SYSTEM, payload)
        resp_preview = text[:1000]
        area_id, project_id = _resolve(prop, area_map, proj_map)
        try:
            confidence = float(prop.get("confidence"))
        except (TypeError, ValueError):
            confidence = 0.0
        reason = (str(prop.get("reason") or "").strip() or "Inferred from your filing")[:200]

        if area_id is None:
            # No confident home; leave unfiled — the periodic filing scan may
            # revisit it later.
            return {
                "action": "left_unfiled",
                "reason": "no clear area match",
                "confidence": confidence,
                "llm_response": resp_preview,
            }

        if confidence >= settings.capture_file_confidence:
            # Confident → file the task directly.
            task.area_id = area_id
            task.project_id = project_id
            await session.commit()
            log.info("capture %s auto-filed (confidence %.2f)", task_id, confidence)
            return {
                "action": "auto_filed",
                "area_id": str(area_id),
                "project_id": str(project_id) if project_id else None,
                "confidence": confidence,
                "reason": reason,
                "llm_response": resp_preview,
            }

        # Low confidence → keep the task unfiled and pre-fill a filing suggestion
        # with the best guess, so the user just confirms/edits it in the inbox.
        existing = await _existing_refs(session, "filing")
        if str(task_id) in existing:
            return {"action": "suggestion_exists", "confidence": confidence}
        filing_prop = _apply_filing_rules(
            {
                "ref": str(task_id),
                "title": task.title,
                "reason": reason,
                "detail": None,
                "link_url": None,
                "suggested_due": None,
                "suggested_area_id": area_id,
                "suggested_project_id": project_id,
                "source_at": None,
            },
            areas,
            projects,
        )
        _add_suggestion(session, "filing", filing_prop)
        await session.commit()
        log.info("capture %s → filing suggestion (confidence %.2f)", task_id, confidence)
        return {
            "action": "filing_suggestion",
            "area_id": str(area_id),
            "project_id": str(project_id) if project_id else None,
            "confidence": confidence,
            "reason": reason,
            "llm_response": resp_preview,
        }
