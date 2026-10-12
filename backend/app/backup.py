"""Local backups of the authoritative Postgres data.

Writes a timestamped, gzipped JSON snapshot of every app table to a local folder
(settings.backup_dir). Point Google Drive for Desktop / rclone at that folder to
get the archives off-machine — the app deliberately doesn't talk to Drive.

Why this and not PGlite: PGlite is a disposable local cache that re-hydrates from
Postgres via Electric. Postgres is the source of truth, so it's what we protect.

Security: OAuth tokens (google_account) are NOT included, so archives synced to
Drive carry no secrets — after a restore you simply reconnect Google. Non-secret
operational state (gtask link mapping, scan cursors) is included so sync/scan
resume cleanly.
"""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import DateTime, delete, insert, select
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import (
    Area,
    BackupState,
    ExtTool,
    GenieConversation,
    GtaskLink,
    Link,
    Note,
    Project,
    PtModel,
    PtScenario,
    PtUsage,
    ScanState,
    Suggestion,
    Task,
)

log = logging.getLogger("otter.backup")

# Tables included in a backup. User data + non-secret operational state. Order is
# irrelevant (the schema has no hard FKs). google_account (tokens) and
# backup_state (bookkeeping) are intentionally excluded.
_TABLES = [Task, Area, Project, Note, Link, Suggestion, PtModel, PtUsage, PtScenario, GtaskLink, ScanState, ExtTool, GenieConversation]
_BY_NAME = {m.__tablename__: m for m in _TABLES}

SCHEMA_VERSION = 1
_FILE_RE = re.compile(r"^otter-backup-\d{8}-\d{6}\.json\.gz$")


def _backup_dir() -> Path:
    return Path(settings.backup_dir).expanduser().resolve()


def _json_default(o: object) -> object:
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, uuid.UUID):
        return str(o)
    return str(o)


def _row_dict(model: type, row: object) -> dict:
    return {c.key: getattr(row, c.key) for c in model.__mapper__.columns}


async def _dump_document(session: AsyncSession) -> dict:
    tables: dict[str, list[dict]] = {}
    counts: dict[str, int] = {}
    for model in _TABLES:
        rows = (await session.execute(select(model))).scalars().all()
        tables[model.__tablename__] = [_row_dict(model, r) for r in rows]
        counts[model.__tablename__] = len(rows)
    return {
        "version": SCHEMA_VERSION,
        "created_at": datetime.now(UTC).isoformat(),
        "counts": counts,
        "tables": tables,
    }


async def _state(session: AsyncSession) -> BackupState:
    st = (await session.execute(select(BackupState).where(BackupState.id == 1))).scalars().first()
    if st is None:
        st = BackupState(id=1)
        session.add(st)
    return st


def _list_files() -> list[Path]:
    d = _backup_dir()
    if not d.is_dir():
        return []
    return sorted((p for p in d.iterdir() if _FILE_RE.match(p.name)), reverse=True)


def _write_and_prune(data: bytes, keep: int) -> str:
    """Blocking: gzip + write the archive, then prune old ones. Returns filename."""
    d = _backup_dir()
    d.mkdir(parents=True, exist_ok=True)
    name = f"otter-backup-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.json.gz"
    (d / name).write_bytes(gzip.compress(data))
    if keep > 0:
        for old in _list_files()[keep:]:
            try:
                old.unlink()
            except OSError:
                log.warning("could not prune old backup %s", old, exc_info=True)
    return name


async def run_backup(session: AsyncSession) -> dict:
    """Take a snapshot, write it to the backup folder, prune, and record state."""
    st = await _state(session)
    try:
        doc = await _dump_document(session)
        payload = json.dumps(doc, default=_json_default).encode("utf-8")
        name = await asyncio.to_thread(_write_and_prune, payload, settings.backup_keep)
        st.last_backup_at = datetime.now(UTC)
        st.last_file_id = name
        st.last_file_name = name
        st.last_error = None
        st.updated_at = datetime.now(UTC)
        await session.commit()
        total = sum(doc["counts"].values())
        return {"ok": True, "file": name, "rows": total, "bytes": len(gzip.compress(payload)), "counts": doc["counts"]}
    except Exception as exc:  # record and surface, but don't crash the loop
        st.last_error = str(exc)[:500]
        st.updated_at = datetime.now(UTC)
        await session.commit()
        log.warning("backup failed", exc_info=True)
        return {"ok": False, "error": str(exc)[:300]}


def list_backups() -> list[dict]:
    """Archives currently in the backup folder, newest first."""
    out = []
    for p in _list_files():
        stat = p.stat()
        out.append(
            {
                "name": p.name,
                "size": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
            }
        )
    return out


def _coerce(model: type, row: dict) -> dict:
    """Turn JSON scalars back into the Python types the columns expect."""
    out: dict[str, object] = {}
    for col in model.__mapper__.columns:
        if col.key not in row:
            continue
        val = row[col.key]
        if val is not None and isinstance(col.type, PGUUID):
            val = uuid.UUID(val) if isinstance(val, str) else val
        elif val is not None and isinstance(col.type, DateTime) and isinstance(val, str):
            val = datetime.fromisoformat(val)
        out[col.key] = val
    return out


async def restore(session: AsyncSession, filename: str) -> dict:
    """Replace all managed tables with the contents of an archive. Destructive:
    wipes current rows and reloads from the snapshot, in one transaction."""
    d = _backup_dir()
    path = (d / filename).resolve()
    # Guard against path traversal — must be a real archive inside the folder.
    if not _FILE_RE.match(filename) or path.parent != d or not path.is_file():
        raise FileNotFoundError("backup archive not found")

    raw = await asyncio.to_thread(lambda: gzip.decompress(path.read_bytes()))
    doc = json.loads(raw)
    tables = doc.get("tables", {})

    counts: dict[str, int] = {}
    for name, model in _BY_NAME.items():
        rows = tables.get(name)
        if rows is None:
            continue  # table absent from this archive — leave it untouched
        await session.execute(delete(model))
        coerced = [_coerce(model, r) for r in rows]
        if coerced:
            await session.execute(insert(model), coerced)
        counts[name] = len(coerced)
    await session.commit()
    return {"ok": True, "restored": counts, "from": filename, "created_at": doc.get("created_at")}


async def status(session: AsyncSession) -> dict:
    st = (await session.execute(select(BackupState).where(BackupState.id == 1))).scalars().first()
    return {
        "configured": settings.backup_configured,
        "dir": str(_backup_dir()),
        "interval_seconds": settings.backup_interval_seconds,
        "keep": settings.backup_keep,
        "last_backup_at": st.last_backup_at.isoformat() if st and st.last_backup_at else None,
        "last_file": st.last_file_name if st else None,
        "last_error": st.last_error if st else None,
        "archive_count": len(_list_files()),
    }
