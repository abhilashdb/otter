"""Otter backend entrypoint.

Serves the write/mutation API and, in production (e.g. Databricks Apps), the
built React frontend. Reads happen client-side from PGlite (hydrated by Electric);
this backend owns writes, quick-capture, Google sync, and Electric shape auth.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .backup import run_backup
from .config import settings
from .db import SessionLocal, engine
from .gsync import run_sync
from .routers import (
    areas,
    auth_status,
    backup,
    calendar,
    capture,
    ext_tools,
    genie,
    google,
    links,
    notes,
    projects,
    pt,
    suggestions,
    tasks,
)
from .suggest import run_scan_serialized
from .tracing import init_tracing

log = logging.getLogger("otter")


async def _google_sync_loop() -> None:
    """Periodically reconcile Google Tasks (import + status push) when connected."""
    interval = settings.google_sync_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            async with SessionLocal() as session:
                await run_sync(session)
        except Exception:  # noqa: BLE001 — a transient sync failure must not kill the loop
            log.exception("google sync loop iteration failed")


async def _suggest_scan_loop() -> None:
    """Periodically scan email + calendar + Slack + unfiled tasks for suggestions."""
    interval = settings.suggest_scan_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            async with SessionLocal() as session:
                await run_scan_serialized(session)
        except Exception:  # noqa: BLE001 — a transient scan failure must not kill the loop
            log.exception("suggestion scan loop iteration failed")


async def _backup_loop() -> None:
    """Periodically snapshot the authoritative Postgres to the local backup folder."""
    interval = settings.backup_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            async with SessionLocal() as session:
                await run_backup(session)
        except Exception:  # noqa: BLE001 — a transient backup failure must not kill the loop
            log.exception("backup loop iteration failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_tracing()  # MLflow (no-op unless an experiment is configured)
    tasks: list[asyncio.Task] = []
    if settings.google_configured and settings.google_sync_interval_seconds > 0:
        tasks.append(asyncio.create_task(_google_sync_loop()))
    if settings.backup_configured and settings.backup_interval_seconds > 0:
        tasks.append(asyncio.create_task(_backup_loop()))
    # The scan loop covers filing + Slack (LLM/Databricks-only) as well as
    # email/calendar, so run it whenever any of those is configured.
    if settings.suggest_scan_interval_seconds > 0 and (
        settings.google_configured or settings.llm_configured or settings.slack_configured
    ):
        tasks.append(asyncio.create_task(_suggest_scan_loop()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await engine.dispose()


app = FastAPI(title="Otter", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(tasks.router)
app.include_router(areas.router)
app.include_router(projects.router)
app.include_router(notes.router)
app.include_router(links.router)
app.include_router(google.router)
app.include_router(calendar.router)
app.include_router(auth_status.router)
app.include_router(capture.router)
app.include_router(suggestions.router)
app.include_router(pt.router)
app.include_router(ext_tools.router)
app.include_router(backup.router)
app.include_router(genie.router)


@app.get("/api/health")
async def health() -> dict:
    """Liveness + DB connectivity check."""
    db_ok = False
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return {"status": "ok", "db": db_ok}


# In production the frontend is built to frontend/dist and served here so the
# whole app is one process (matches the Databricks Apps deployment model).
# In local dev the Vite server serves the frontend, so this mount is skipped.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
