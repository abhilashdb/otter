"""Backup API: snapshot the authoritative Postgres to the local backup folder,
list archives, and restore one. The tool/UI drives these; the actual work lives
in app/backup.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from .. import backup
from ..db import get_session

router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.get("/status")
async def status(session: AsyncSession = Depends(get_session)) -> dict:
    return await backup.status(session)


@router.post("/run")
async def run(session: AsyncSession = Depends(get_session)) -> dict:
    return await backup.run_backup(session)


@router.get("/list")
async def list_archives() -> dict:
    return {"backups": backup.list_backups()}


class RestoreIn(BaseModel):
    filename: str


@router.post("/restore")
async def restore(payload: RestoreIn, session: AsyncSession = Depends(get_session)) -> dict:
    try:
        return await backup.restore(session, payload.filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
