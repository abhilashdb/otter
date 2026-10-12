"""Google Tasks <-> Otter reconciliation.

Direction (per product decision):
  • Import (Google -> Otter): open (needsAction) Google tasks are pulled in once.
    List "In progress" -> status 'doing', everything else -> 'todo'. Completed
    Google tasks are skipped. Re-imports are idempotent via gtask_links.
  • Status push (Otter -> Google): when an imported task's completion state changes
    in Otter, reflect it on the Google task (done -> completed, reopened ->
    needsAction). Title/due/notes are NOT pushed back — Google owns that content.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import google_client as gc
from .models import GoogleAccount, GtaskLink, Link, Task


async def get_account(session: AsyncSession) -> GoogleAccount | None:
    return (
        await session.execute(select(GoogleAccount).where(GoogleAccount.id == 1))
    ).scalars().first()


def _status_for_list(list_title: str) -> str:
    """Map a Google list name to an Otter status column."""
    return "doing" if "progress" in list_title.lower() else "todo"


def _parse_due(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        # Google returns RFC3339 (date-only semantics, time is always 00:00Z).
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _valid_token(session: AsyncSession, account: GoogleAccount) -> str:
    """Return a live access token, refreshing via the refresh token if needed."""
    now = datetime.now(UTC)
    if account.access_token and account.token_expiry and account.token_expiry > now:
        return account.access_token
    if not account.refresh_token:
        raise RuntimeError("no refresh token — reconnect Google")
    data = await gc.refresh_token(account.refresh_token)
    account.access_token = data["access_token"]
    account.token_expiry = now + timedelta(seconds=int(data.get("expires_in", 3600)) - 60)
    await session.flush()
    return account.access_token


async def import_open_tasks(session: AsyncSession, token: str) -> dict:
    """Pull open Google tasks.

    • New Google tasks become Otter tasks.
    • Already-linked tasks have their title/due/notes pulled from Google when the
      upstream task genuinely changed (its `updated` timestamp advanced past what
      we last saw) — Google owns that content. We gate on `updated` rather than
      overwriting every sync so a local edit isn't clobbered unless Google changed.
    • Every open task also gets its Google `links` (e.g. the Gmail deep-link on
      email-derived tasks) mirrored into Otter's links table — idempotently.
    """
    # gtask_id -> (link, task) for already-imported tasks.
    by_gid: dict[str, tuple[GtaskLink, Task]] = {
        link.gtask_id: (link, task)
        for link, task in (
            await session.execute(
                select(GtaskLink, Task).join(Task, Task.id == GtaskLink.task_id)
            )
        ).all()
    }
    # Existing (task_id, url) so we never duplicate a link on re-sync.
    have_link = {
        (tid, url)
        for tid, url in (
            await session.execute(
                select(Link.entity_id, Link.url).where(
                    Link.entity_type == "task", Link.deleted_at.is_(None)
                )
            )
        ).all()
    }
    now = datetime.now(UTC)
    imported = 0
    updated = 0
    for tl in await gc.list_tasklists(token):
        list_id = tl["id"]
        status = _status_for_list(tl.get("title", ""))
        for t in await gc.list_tasks(token, list_id, show_completed=False):
            gtask_id = t.get("id")
            if not gtask_id or t.get("deleted") or t.get("status") == "completed":
                continue
            gupdated = _parse_due(t.get("updated"))
            existing = by_gid.get(gtask_id)
            if existing is None:
                task_id = uuid.uuid4()
                session.add(
                    Task(
                        id=task_id,
                        title=(t.get("title") or "").strip() or "(untitled)",
                        body=t.get("notes") or "",
                        status=status,
                        priority="p2",
                        due_at=_parse_due(t.get("due")),
                    )
                )
                session.add(
                    GtaskLink(
                        id=uuid.uuid4(),
                        task_id=task_id,
                        gtask_id=gtask_id,
                        list_id=list_id,
                        pushed_status=status,
                        gtask_updated=gupdated,
                    )
                )
                imported += 1
            else:
                link, task = existing
                task_id = task.id
                # Pull content only when Google changed it and we still own the task.
                changed = gupdated is not None and (
                    link.gtask_updated is None or gupdated > link.gtask_updated
                )
                if task.deleted_at is None and changed:
                    task.title = (t.get("title") or "").strip() or task.title
                    task.due_at = _parse_due(t.get("due"))
                    task.body = t.get("notes") or ""
                    task.updated_at = now
                    link.gtask_updated = gupdated
                    updated += 1
                elif changed:
                    # Task was deleted locally; just advance the marker so we don't
                    # keep re-detecting the same upstream change.
                    link.gtask_updated = gupdated
            # Mirror the task's Google links (Gmail links, etc.) onto the Otter task.
            for i, gl in enumerate(t.get("links") or []):
                url = (gl.get("link") or "").strip()
                if not url or (task_id, url) in have_link:
                    continue
                session.add(
                    Link(
                        id=uuid.uuid4(),
                        entity_type="task",
                        entity_id=task_id,
                        label=(gl.get("description") or "").strip()
                        or (gl.get("type") or "link").capitalize(),
                        url=url,
                        sort_order=float(i),
                    )
                )
                have_link.add((task_id, url))
    return {"imported": imported, "updated": updated}


async def push_status(session: AsyncSession, token: str) -> int:
    """Push completion-state changes from Otter tasks back to their Google tasks."""
    rows = (
        await session.execute(
            select(GtaskLink, Task)
            .join(Task, Task.id == GtaskLink.task_id)
            .where(Task.deleted_at.is_(None))
        )
    ).all()
    pushed = 0
    for link, task in rows:
        if task.status == link.pushed_status:
            continue
        was_done = link.pushed_status == "done"
        now_done = task.status == "done"
        if was_done != now_done:
            try:
                res = await gc.set_task_status(token, link.list_id, link.gtask_id, completed=now_done)
                # Our own push bumps Google's `updated`; record it so the importer
                # doesn't mistake it for an upstream content edit and pull it back.
                link.gtask_updated = _parse_due(res.get("updated")) or link.gtask_updated
                pushed += 1
            except Exception:
                # Google task may have been deleted upstream; leave the link so a
                # later reconcile can retry, but don't advance pushed_status.
                continue
        link.pushed_status = task.status
    return pushed


async def run_sync(session: AsyncSession) -> dict:
    """Full reconcile: push status changes, then import new open tasks."""
    account = await get_account(session)
    if account is None or not account.refresh_token:
        return {"connected": False}
    try:
        token = await _valid_token(session, account)
        pushed = await push_status(session, token)
        result = await import_open_tasks(session, token)
        account.last_sync_at = datetime.now(UTC)
        account.last_sync_error = None
        await session.commit()
        return {
            "connected": True,
            "imported": result["imported"],
            "updated": result["updated"],
            "pushed": pushed,
        }
    except Exception as exc:  # noqa: BLE001 — surface the message to the UI
        await session.rollback()
        account = await get_account(session)
        if account is not None:
            account.last_sync_error = str(exc)[:500]
            await session.commit()
        return {"connected": True, "error": str(exc)[:500]}
