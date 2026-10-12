"""Task-suggestion engine.

Scans external sources (Google Calendar + Gmail now; Slack via the Databricks
Slack MCP is the next source) for things that imply a concrete personal to-do,
asks the LLM (Databricks FMAPI) which items warrant a task and how to file them
(area + optional project), and records the results as `suggestions` rows for the
user to accept or dismiss.

Design:
  • Incremental — a per-source cursor in `scan_state` means each scan only looks
    at what's new (calendar re-windows the lookahead and relies on dedupe).
  • Deduped — one suggestion per (source, source_ref); already-suggested and
    dismissed items are never re-proposed.
  • Non-destructive — a suggestion never becomes a task on its own. Accepting one
    creates a Task (filed into the suggested area/project) and mirrors its source
    link; dismissing just remembers the ref so it stays out of the way.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import google_client as gc
from . import llm, slack_client
from .config import settings
from .db import SessionLocal
from .gsync import _valid_token, get_account
from .models import Area, Link, Project, ScanState, Suggestion, Task

log = logging.getLogger("otter.suggest")

SOURCES = ("calendar", "email")

# Deterministic filing rules applied after the LLM: if a proposal's text matches
# any keyword, it's filed into the named area (+ optional project) when those
# exist — so a standing routing preference is honored regardless of the model's
# (stochastic) area/project pick. Matching is case-insensitive; names are matched
# against the user's actual areas/projects, so a rule is a no-op until they exist.
_FILING_RULES: list[tuple[tuple[str, ...], tuple[str, str | None]]] = [
    (("scorecard", "interview", "candidate"), ("Interviews", "Interviews")),
]

# Meeting titles that are broadcasts / social / routine — never worth prep.
_SKIP_MEETING_WORDS = (
    "webinar", "all hands", "all-hands", "town hall", "townhall", "office hours",
    "broadcast", "ama", "happy hour", "social", "holiday", "birthday", "ooo",
    "out of office", "standup", "stand-up", "daily sync", "lunch", "coffee chat",
)


# ── small helpers ─────────────────────────────────────────────────────────────
def _parse_dt(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _parse_date(raw: str | None) -> datetime | None:
    """An LLM-proposed 'YYYY-MM-DD' due date → UTC-midnight datetime."""
    if not raw or not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.strip()[:10]).replace(tzinfo=UTC)
    except ValueError:
        return None


def _clip(s: str, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _fmt_when(dt: datetime | None) -> str:
    return dt.strftime("%a %b %d, %H:%M") if dt else ""


def _looks_like_broadcast(title: str) -> bool:
    t = title.lower()
    return any(w in t for w in _SKIP_MEETING_WORDS)


async def _get_scan_state(session: AsyncSession, source: str) -> ScanState:
    st = (
        await session.execute(select(ScanState).where(ScanState.source == source))
    ).scalars().first()
    if st is None:
        st = ScanState(source=source)
        session.add(st)
    return st


# ── source candidate collection ───────────────────────────────────────────────
async def _calendar_candidates(token: str, updated_min: str | None = None) -> list[dict]:
    now = datetime.now(UTC)
    tmax = now + timedelta(days=settings.suggest_calendar_lookahead_days)
    events = await gc.list_calendar_events(
        token, now.isoformat(), tmax.isoformat(), updated_min=updated_min
    )
    out: list[dict] = []
    for e in events:
        if e.get("status") == "cancelled":
            continue
        if e.get("eventType") in ("outOfOffice", "focusTime", "workingLocation"):
            continue
        start_dt = _parse_dt((e.get("start") or {}).get("dateTime"))
        if start_dt is None:  # all-day → holidays/OOO, not a prep meeting
            continue
        title = (e.get("summary") or "").strip()
        if not title or _looks_like_broadcast(title):
            continue
        attendees = [a for a in (e.get("attendees") or []) if not a.get("resource")]
        me = next((a for a in attendees if a.get("self")), None)
        if me and me.get("responseStatus") == "declined":
            continue
        n = len(attendees)
        if n < 2 or n > 20:  # solo holds, or big broadcasts → skip
            continue
        out.append(
            {
                "ref": e.get("id"),
                "title": title,
                "when": _fmt_when(start_dt),
                "attendees": n,
                "organizer": (e.get("organizer") or {}).get("email", ""),
                "description": _clip(e.get("description") or "", 400),
                "link_url": e.get("htmlLink"),
                "source_at": start_dt,
            }
        )
    return out


async def _email_candidates(token: str, since_epoch: int | None) -> list[dict]:
    base = "in:inbox -category:promotions -category:social -category:forums"
    if since_epoch:
        query = f"{base} after:{since_epoch}"
    else:
        query = f"{base} newer_than:{settings.suggest_email_lookback_days}d"
    ids = await gc.list_gmail_message_ids(
        token, query, max_results=settings.suggest_max_items_per_source
    )
    out: list[dict] = []
    for mid in ids:
        m = await gc.get_gmail_message(token, mid)
        headers = {
            h.get("name", "").lower(): h.get("value", "")
            for h in (m.get("payload") or {}).get("headers", [])
        }
        internal = m.get("internalDate")
        src_at = (
            datetime.fromtimestamp(int(internal) / 1000, UTC) if internal else None
        )
        out.append(
            {
                "ref": mid,
                "subject": headers.get("subject", "(no subject)"),
                "from": headers.get("from", ""),
                "snippet": _clip(m.get("snippet", ""), 300),
                "mailing_list": "list-id" in headers,
                "when": _fmt_when(src_at),
                "link_url": f"https://mail.google.com/mail/u/0/#all/{mid}",
                "source_at": src_at,
            }
        )
    # Gmail's `after:` is only day-granular, so a same-day re-scan re-fetches the
    # day's inbox. Filter strictly by receive time so each message is only ever
    # examined once (no wasted LLM calls on mail we already looked at).
    if since_epoch:
        out = [o for o in out if o["source_at"] and o["source_at"].timestamp() > since_epoch]
    return out


def _clean_slack(s: str) -> str:
    """Turn Slack's angle-bracket markup into readable text for the LLM/titles."""
    s = re.sub(r"<@[UWB][A-Z0-9]+\|([^>]+)>", r"@\1", s)  # user mention w/ name
    s = re.sub(r"<@[UWB][A-Z0-9]+>", "@someone", s)  # bare user mention
    s = re.sub(r"<#C[A-Z0-9]+\|([^>]+)>", r"#\1", s)  # channel mention
    s = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"\2", s)  # link w/ label
    s = re.sub(r"<(https?://[^>]+)>", r"\1", s)  # bare link
    return s


def _slack_uid(profile_text: str) -> str | None:
    m = re.search(r"User ID:\s*(\S+)", slack_client.unwrap(profile_text))
    return m.group(1) if m else None


def _parse_slack_results(md: str) -> list[dict]:
    """Parse the Slack MCP search's markdown into per-message records."""
    out: list[dict] = []
    for b in re.split(r"### Result \d+", md)[1:]:
        link_m = re.search(r"Permalink:\s*\[[^\]]*\]\(([^)]+)\)", b)
        if not link_m:
            continue
        ts_m = re.search(r"Message_ts:\s*([\d.]+)", b)
        chan_m = re.search(r"Channel:\s*(.+)", b)
        from_m = re.search(r"From:\s*(.+)", b)
        from_id_m = re.search(r"From:[^\n]*?\(ID:\s*([UWB][A-Z0-9]+)\)", b)
        text_m = re.search(
            r"Text:\s*\n?(.*?)(?:\n(?:Context (?:before|after)|Reply count|Participants)\b|\Z)",
            b,
            re.DOTALL,
        )
        src_at = None
        if ts_m:
            try:
                src_at = datetime.fromtimestamp(float(ts_m.group(1)), UTC)
            except (ValueError, OSError):
                src_at = None
        raw_from = from_m.group(1).strip() if from_m else ""
        from_label = re.sub(r"\s*\(ID:[^)]*\)", "", raw_from).strip() or "someone"
        out.append(
            {
                "ref": link_m.group(1),
                "from": from_label,
                "from_id": from_id_m.group(1) if from_id_m else None,
                "channel": _clean_slack(chan_m.group(1).strip() if chan_m else ""),
                "text": _clip(_clean_slack(text_m.group(1).strip() if text_m else ""), 500),
                "when": _fmt_when(src_at),
                "link_url": link_m.group(1),
                "source_at": src_at,
            }
        )
    return out


async def _slack_candidates(since_epoch: int | None) -> list[dict]:
    """The user's recent Slack mentions + DMs, scoped to them and incremental.

    Slack `after:` is day-granular, so we fetch from the cursor's day (or a
    lookback on first run) and then strictly filter by message time so each
    message is examined once. Messages the user authored are dropped."""
    if since_epoch:
        after = datetime.fromtimestamp(since_epoch, UTC).date().isoformat()
    else:
        lookback = timedelta(days=settings.suggest_slack_lookback_days)
        after = (datetime.now(UTC).date() - lookback).isoformat()

    raw_blocks: list[str] = []
    uid: str | None = None
    async with slack_client.session() as sc:
        uid = _slack_uid(await sc.call("slack_read_user_profile", {}))
        if uid:  # messages that @-mention me
            raw_blocks.append(
                await sc.call(
                    "slack_search_public_and_private",
                    {"keywords": [f"<@{uid}>"], "filters": f"after:{after}", "natural_language_query": ""},
                )
            )
        # direct + group DMs to me
        raw_blocks.append(
            await sc.call(
                "slack_search_public_and_private",
                {"keywords": [], "filters": f"is:dm after:{after}", "natural_language_query": ""},
            )
        )

    by_ref: dict[str, dict] = {}
    for raw in raw_blocks:
        for rec in _parse_slack_results(slack_client.unwrap(raw)):
            if uid and rec.get("from_id") == uid:  # skip my own messages
                continue
            if rec["ref"] in by_ref:
                continue
            if since_epoch and rec["source_at"] and rec["source_at"].timestamp() <= since_epoch:
                continue
            by_ref[rec["ref"]] = rec
    items = sorted(
        by_ref.values(),
        key=lambda r: r["source_at"] or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )
    return items[: settings.suggest_max_items_per_source]


def _detail(source: str, item: dict) -> str:
    if source == "calendar":
        bits = [item.get("when", ""), f"{item.get('attendees', 0)} attendees"]
        if item.get("organizer"):
            bits.append(item["organizer"])
        return " · ".join(b for b in bits if b)
    if source == "slack":
        bits = [item.get("from", ""), item.get("channel", ""), item.get("when", "")]
        return " · ".join(b for b in bits if b)
    bits = [item.get("from", ""), item.get("when", "")]
    return " · ".join(b for b in bits if b)


# ── LLM proposal ───────────────────────────────────────────────────────────────
_SYSTEM_BASE = (
    "You are Otter's task-suggestion assistant. You review the user's {source} and"
    " decide which items warrant a concrete personal to-do for the user, write a"
    " short imperative task title for each, and file it under the best-matching"
    " area (and optionally a project).\n"
    "Rules:\n"
    "- Only suggest a task when there is a real, specific action for the user."
    " Skip FYIs, newsletters, notifications, automated mail, and things already done.\n"
    "- {focus}\n"
    "- title: imperative, specific, <= ~10 words.\n"
    "- reason: one short phrase naming what triggered it.\n"
    "- due: ISO date 'YYYY-MM-DD' if implied, else null. For meeting prep use the"
    " meeting day or the day before.\n"
    "- area: the code of the best-matching area, or null if none fits."
    " project: a project code that belongs to that area, or null (projects are optional).\n"
    "- Return ONLY a JSON array; each element"
    ' {"code","title","reason","due","area","project"}. Omit items that do not'
    " warrant a task. If none, return []."
)
_FOCUS = {
    "email": "Focus on mail asking you to do, decide, review, reply, schedule, or send something.",
    "calendar": (
        "These are upcoming meetings. Suggest prep only when it is genuinely useful"
        " (review a doc, prepare an agenda or update, make a decision, gather data)."
        " Skip routine standups and agenda-less 1:1s."
    ),
    "slack": (
        "These are Slack messages that mention you or were sent to you directly."
        " Suggest a task only when someone is asking you to do, decide, review,"
        " reply to, or follow up on something. Skip FYIs, banter, resolved threads,"
        " and automated/bot messages."
    ),
}


def _catalog(areas: list[Area], projects: list[Project]) -> tuple[dict, dict, dict]:
    """Build the compact area/project catalog for the prompt + code→id maps."""
    area_code, area_map = {}, {}
    payload_areas = []
    for i, a in enumerate(areas):
        code = f"a{i}"
        area_code[str(a.id)] = code
        area_map[code] = a.id
        payload_areas.append({"code": code, "name": a.name, "kind": a.kind})
    proj_map = {}
    payload_projects = []
    for i, p in enumerate(projects):
        code = f"p{i}"
        acode = area_code.get(str(p.area_id))
        proj_map[code] = (p.id, acode)
        payload_projects.append({"code": code, "name": p.name, "area": acode})
    return {"areas": payload_areas, "projects": payload_projects}, area_map, proj_map


async def _llm_suggest(
    source: str, items: list[dict], areas: list[Area], projects: list[Project]
) -> list[dict]:
    catalog, area_map, proj_map = _catalog(areas, projects)
    code_map = {str(i): it for i, it in enumerate(items)}
    payload = {
        **catalog,
        "items": [{"code": str(i), **_item_for_prompt(source, it)} for i, it in enumerate(items)],
    }
    # NB: .replace, not .format — the prompt contains literal JSON braces that
    # str.format() would try (and fail) to interpret as replacement fields.
    system = _SYSTEM_BASE.replace("{source}", source).replace("{focus}", _FOCUS[source])
    text = await llm.respond(system, json.dumps(payload))
    proposals = []
    for row in llm.parse_json_array(text):
        item = code_map.get(str(row.get("code")))
        if not item:
            continue
        area_id = area_map.get(row.get("area"))
        project_id = None
        proj = proj_map.get(row.get("project"))
        if proj:
            pid, pacode = proj
            if area_id is None:  # infer area from the project
                area_id = area_map.get(pacode)
            if pacode is None or area_map.get(pacode) == area_id:
                project_id = pid
        title = (row.get("title") or item.get("title") or item.get("subject") or "").strip()
        if not title:
            continue
        proposals.append(
            _proposal(
                source, item, title=title, reason=(row.get("reason") or "").strip(),
                due=_parse_date(row.get("due")), area_id=area_id, project_id=project_id,
            )
        )
    return proposals


def _item_for_prompt(source: str, it: dict) -> dict:
    if source == "calendar":
        return {
            "title": it["title"], "when": it["when"], "attendees": it["attendees"],
            "organizer": it["organizer"], "description": it["description"],
        }
    if source == "slack":
        return {
            "from": it["from"], "channel": it["channel"], "when": it["when"],
            "text": it["text"],
        }
    return {
        "subject": it["subject"], "from": it["from"], "snippet": it["snippet"],
        "when": it["when"], "mailing_list": it["mailing_list"],
    }


def _heuristic_suggest(source: str, items: list[dict], areas: list[Area]) -> list[dict]:
    """LLM-free fallback (used when FMAPI isn't configured). Deliberately cautious."""
    out = []
    if source == "calendar":
        for it in items:
            if it.get("description"):  # only meetings with an agenda/description
                out.append(
                    _proposal(source, it, title=f"Prep for {it['title']}",
                              reason="Upcoming meeting", due=it.get("source_at"),
                              area_id=None, project_id=None)
                )
    else:
        kw = ("please", "can you", "could you", "action", "review", "approve", "sign", "deadline")
        for it in items:
            if it.get("mailing_list"):
                continue
            blob = f"{it.get('subject', '')} {it.get('snippet', '')}".lower()
            if any(k in blob for k in kw):
                out.append(
                    _proposal(source, it, title=f"Follow up: {it['subject']}",
                              reason="Email needs a reply/action", due=None,
                              area_id=None, project_id=None)
                )
    return out


def _proposal(source, item, *, title, reason, due, area_id, project_id) -> dict:
    return {
        "ref": item["ref"],
        "title": title[:200],
        "reason": reason[:200],
        "detail": _detail(source, item),
        "link_url": item.get("link_url"),
        "suggested_due": due,
        "suggested_area_id": area_id,
        "suggested_project_id": project_id,
        "source_at": item.get("source_at"),
    }


def _apply_filing_rules(prop: dict, areas: list[Area], projects: list[Project]) -> dict:
    text = f"{prop['title']} {prop['reason']}".lower()
    for keywords, (area_name, project_name) in _FILING_RULES:
        if not any(k in text for k in keywords):
            continue
        area = next((a for a in areas if a.name.lower() == area_name.lower()), None)
        if area is None:
            break
        prop["suggested_area_id"] = area.id
        if project_name:
            proj = next(
                (
                    p
                    for p in projects
                    if p.area_id == area.id and p.name.lower() == project_name.lower()
                ),
                None,
            )
            prop["suggested_project_id"] = proj.id if proj else None
        break
    return prop


async def _suggest_for(source, items, areas, projects) -> list[dict]:
    proposals = (
        await _llm_suggest(source, items, areas, projects)
        if llm.configured()
        else _heuristic_suggest(source, items, areas)
    )
    return [_apply_filing_rules(p, areas, projects) for p in proposals]


# ── filing assistant (unfiled tasks → area/project) ────────────────────────────
_FILING_SYSTEM = (
    "You file the user's tasks into their areas and projects. For each task, pick"
    " an area ONLY when it is a clear, specific match to what the task is actually"
    " about (e.g. the task names that customer, or is clearly that project's work)."
    " Prefer leaving a task unfiled (area = null) over forcing a weak match.\n"
    "- Announcements, newsletters, FYIs, and broad internal notices usually have NO"
    " good area — return null for those. Never file a task into an area just"
    " because both are 'internal'.\n"
    "- Do not treat an area/project named for one topic (e.g. Interviews) as a"
    " generic bucket — only file there if the task is genuinely about that topic.\n"
    "- area: the code of a clearly-matching area, or null. project: a project code"
    " under that area, or null (projects are optional).\n"
    "- reason: a short phrase on why it fits.\n"
    "- Return ONLY a JSON array; each element"
    ' {"code","area","project","reason"}. Include every task; use null areas'
    " liberally where nothing clearly fits."
)


async def _llm_file(tasks: list[Task], areas: list[Area], projects: list[Project]) -> list[dict]:
    """Ask the LLM to file each unfiled task. Returns proposals with resolved
    area/project ids (only for tasks it could place)."""
    if not areas:
        return []
    catalog, area_map, proj_map = _catalog(areas, projects)
    code_map = {str(i): t for i, t in enumerate(tasks)}
    payload = {
        **catalog,
        "tasks": [
            {"code": str(i), "title": t.title, "notes": _clip(t.body or "", 200)}
            for i, t in enumerate(tasks)
        ],
    }
    text = await llm.respond(_FILING_SYSTEM, json.dumps(payload))
    out: list[dict] = []
    for row in llm.parse_json_array(text):
        task = code_map.get(str(row.get("code")))
        if task is None:
            continue
        area_id = area_map.get(row.get("area"))
        project_id = None
        proj = proj_map.get(row.get("project"))
        if proj:
            pid, pacode = proj
            if area_id is None:
                area_id = area_map.get(pacode)
            if pacode is None or area_map.get(pacode) == area_id:
                project_id = pid
        prop = {
            "ref": str(task.id),
            "title": task.title,
            "reason": (row.get("reason") or "").strip() or "Unfiled task",
            "detail": None,
            "link_url": None,
            "suggested_due": None,
            "suggested_area_id": area_id,
            "suggested_project_id": project_id,
            "source_at": None,
        }
        out.append(_apply_filing_rules(prop, areas, projects))
    return out


# ── orchestration ──────────────────────────────────────────────────────────────
def _needs_reconnect(account) -> bool:
    scopes = account.scopes or ""
    return not all(s in scopes for s in gc.SUGGEST_SCOPES)


async def _existing_refs(session: AsyncSession, source: str) -> set[str]:
    return {
        r
        for (r,) in (
            await session.execute(
                select(Suggestion.source_ref).where(
                    Suggestion.source == source, Suggestion.deleted_at.is_(None)
                )
            )
        ).all()
    }


def _add_suggestion(session: AsyncSession, source: str, p: dict) -> None:
    session.add(
        Suggestion(
            id=uuid.uuid4(),
            source=source,
            source_ref=p["ref"],
            title=p["title"],
            reason=p["reason"],
            detail=p["detail"],
            link_url=p["link_url"],
            suggested_due=p["suggested_due"],
            suggested_area_id=p["suggested_area_id"],
            suggested_project_id=p["suggested_project_id"],
            source_at=p["source_at"],
        )
    )


async def _scan_source(
    session: AsyncSession, source: str, token: str, areas, projects, now: datetime, summary: dict
) -> None:
    st = await _get_scan_state(session, source)
    try:
        if source == "calendar":
            cands = await _calendar_candidates(token, updated_min=st.cursor or None)
        else:
            since = int(st.cursor) if (st.cursor or "").isdigit() else None
            cands = await _email_candidates(token, since)
        existing = await _existing_refs(session, source)
        fresh = [c for c in cands if c["ref"] and c["ref"] not in existing]
        created = 0
        for p in await _suggest_for(source, fresh, areas, projects):
            if p["ref"] in existing:
                continue
            _add_suggestion(session, source, p)
            existing.add(p["ref"])
            created += 1
        st.cursor = str(int(now.timestamp())) if source == "email" else now.isoformat()
        st.last_scan_at = now
        st.last_error = None
        summary["sources"][source] = {"scanned": len(cands), "created": created}
        summary["created"] += created
    except Exception as exc:  # noqa: BLE001 — one source failing must not sink the scan
        st.last_error = str(exc)[:500]
        summary["sources"][source] = {"error": str(exc)[:300]}


async def _scan_filing(session: AsyncSession, areas, projects, now: datetime, summary: dict) -> None:
    """Propose area/project for open, unfiled tasks (no Google needed — LLM only)."""
    st = await _get_scan_state(session, "filing")
    try:
        tasks = list(
            (
                await session.execute(
                    select(Task)
                    .where(
                        Task.area_id.is_(None),
                        Task.deleted_at.is_(None),
                        Task.status != "done",
                    )
                    .order_by(Task.created_at.desc())
                    .limit(settings.suggest_max_items_per_source)
                )
            ).scalars()
        )
        existing = await _existing_refs(session, "filing")
        fresh = [t for t in tasks if str(t.id) not in existing]
        created = 0
        if fresh:
            for p in await _llm_file(fresh, areas, projects):
                # Only surface a filing suggestion when we actually found a home.
                if p["ref"] in existing or p["suggested_area_id"] is None:
                    continue
                _add_suggestion(session, "filing", p)
                existing.add(p["ref"])
                created += 1
        st.last_scan_at = now
        st.last_error = None
        summary["sources"]["filing"] = {"scanned": len(tasks), "created": created}
        summary["created"] += created
    except Exception as exc:  # noqa: BLE001
        st.last_error = str(exc)[:500]
        summary["sources"]["filing"] = {"error": str(exc)[:300]}


async def _scan_slack(session: AsyncSession, areas, projects, now: datetime, summary: dict) -> None:
    """Scan the user's recent Slack mentions + DMs for actionable tasks. Needs
    only the Databricks token (via the Slack MCP), not Google."""
    st = await _get_scan_state(session, "slack")
    try:
        since = int(st.cursor) if (st.cursor or "").isdigit() else None
        cands = await _slack_candidates(since)
        existing = await _existing_refs(session, "slack")
        fresh = [c for c in cands if c["ref"] and c["ref"] not in existing]
        created = 0
        for p in await _suggest_for("slack", fresh, areas, projects):
            if p["ref"] in existing:
                continue
            _add_suggestion(session, "slack", p)
            existing.add(p["ref"])
            created += 1
        st.cursor = str(int(now.timestamp()))
        st.last_scan_at = now
        st.last_error = None
        summary["sources"]["slack"] = {"scanned": len(cands), "created": created}
        summary["created"] += created
    except Exception as exc:  # noqa: BLE001 — one source failing must not sink the scan
        st.last_error = str(exc)[:500]
        summary["sources"]["slack"] = {"error": str(exc)[:300]}


async def run_scan(session: AsyncSession) -> dict:
    now = datetime.now(UTC)
    areas = list(
        (await session.execute(select(Area).where(Area.deleted_at.is_(None)))).scalars()
    )
    projects = list(
        (await session.execute(select(Project).where(Project.deleted_at.is_(None)))).scalars()
    )
    summary: dict = {"created": 0, "sources": {}}

    # Filing + Slack need only the LLM / Databricks token — run without Google.
    if llm.configured():
        await _scan_filing(session, areas, projects, now, summary)
    if settings.slack_configured:
        await _scan_slack(session, areas, projects, now, summary)

    # Email + calendar need the Google connection (with the read scopes).
    account = await get_account(session)
    connected = bool(account and account.refresh_token)
    summary["connected"] = connected
    if connected and _needs_reconnect(account):
        summary["needs_reconnect"] = True
    elif connected:
        token = await _valid_token(session, account)
        for source in SOURCES:
            await _scan_source(session, source, token, areas, projects, now, summary)

    await session.commit()
    return summary


# ── background scan orchestration ─────────────────────────────────────────────
# A manual "Scan now" runs in the background so the user can navigate away while
# it works; results stream in via Electric. A lock serializes manual scans
# against the periodic loop so the two never run at once, and the task handle
# lets `status` report whether a manual scan is in flight.
_scan_lock = asyncio.Lock()
_scan_task: asyncio.Task | None = None


def is_scanning() -> bool:
    """True while a manually-triggered background scan is still running."""
    return _scan_task is not None and not _scan_task.done()


async def run_scan_serialized(session: AsyncSession) -> dict:
    """run_scan, but skipped if a scan is already running (used by the periodic
    loop so it never overlaps a manual background scan)."""
    if _scan_lock.locked():
        return {"skipped": True}
    async with _scan_lock:
        return await run_scan(session)


async def _run_scan_bg() -> None:
    # Own session — the request that started us has already returned. Hold the
    # lock so the periodic loop skips while we run.
    async with _scan_lock:
        async with SessionLocal() as session:
            await run_scan(session)


def start_background_scan() -> bool:
    """Kick a scan off in the background. Returns False if one is already running
    (so a double click / rapid re-trigger is a no-op)."""
    global _scan_task
    if is_scanning():
        return False

    def _done(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            log.error("background scan failed", exc_info=exc)

    _scan_task = asyncio.create_task(_run_scan_bg())
    _scan_task.add_done_callback(_done)
    return True


# ── accept / dismiss ─────────────────────────────────────────────────────────
async def _get_suggestion(session: AsyncSession, sug_id: uuid.UUID) -> Suggestion | None:
    return (
        await session.execute(
            select(Suggestion).where(
                Suggestion.id == sug_id, Suggestion.deleted_at.is_(None)
            )
        )
    ).scalars().first()


async def accept_suggestion(session: AsyncSession, sug_id: uuid.UUID, overrides: dict) -> uuid.UUID:
    """Accept a suggestion. For email/calendar this creates a real Task (filed +
    linked); for a 'filing' suggestion it files the existing unfiled task instead
    of creating a new one."""
    sug = await _get_suggestion(session, sug_id)
    if sug is None:
        raise LookupError("suggestion not found")
    if sug.status != "pending":
        raise ValueError("suggestion already handled")

    area_id = overrides.get("area_id", sug.suggested_area_id)
    project_id = overrides.get("project_id", sug.suggested_project_id)

    if sug.source == "filing":
        try:
            target = uuid.UUID(sug.source_ref)
        except ValueError as exc:
            raise LookupError("target task not found") from exc
        task = (
            await session.execute(
                select(Task).where(Task.id == target, Task.deleted_at.is_(None))
            )
        ).scalars().first()
        if task is None:
            raise LookupError("target task not found")
        task.area_id = area_id
        task.project_id = project_id
        task.updated_at = datetime.now(UTC)
        sug.status = "accepted"
        sug.created_task_id = task.id
        sug.updated_at = datetime.now(UTC)
        await session.commit()
        return task.id

    title = (overrides.get("title") or sug.title).strip() or sug.title
    due = overrides.get("due_at", sug.suggested_due)

    task_id = uuid.uuid4()
    session.add(
        Task(
            id=task_id,
            title=title,
            body=sug.detail or "",
            status="todo",
            priority="p2",
            due_at=due,
            area_id=area_id,
            project_id=project_id,
        )
    )
    if sug.link_url:
        session.add(
            Link(
                id=uuid.uuid4(),
                entity_type="task",
                entity_id=task_id,
                label="Email" if sug.source == "email" else "Meeting",
                url=sug.link_url,
            )
        )
    sug.status = "accepted"
    sug.created_task_id = task_id
    sug.updated_at = datetime.now(UTC)
    await session.commit()
    return task_id


async def dismiss_suggestion(session: AsyncSession, sug_id: uuid.UUID) -> None:
    sug = await _get_suggestion(session, sug_id)
    if sug is None:
        raise LookupError("suggestion not found")
    sug.status = "dismissed"
    sug.updated_at = datetime.now(UTC)
    await session.commit()


async def status(session: AsyncSession) -> dict:
    account = await get_account(session)
    connected = bool(account and account.refresh_token)
    states = {
        s.source: {
            "last_scan_at": s.last_scan_at.isoformat() if s.last_scan_at else None,
            "last_error": s.last_error,
        }
        for s in (await session.execute(select(ScanState))).scalars()
    }
    pending = (
        await session.execute(
            select(Suggestion).where(
                Suggestion.status == "pending", Suggestion.deleted_at.is_(None)
            )
        )
    ).scalars().all()
    return {
        "connected": connected,
        "llm_configured": llm.configured(),
        "llm_model": settings.llm_model,
        "needs_reconnect": connected and _needs_reconnect(account),
        "sources": states,
        "pending": len(pending),
        "scanning": is_scanning(),
    }
