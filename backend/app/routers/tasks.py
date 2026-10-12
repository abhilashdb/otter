"""Task write API. Reads happen client-side from PGlite (hydrated by Electric);
this router owns authoritative writes to Postgres and returns the txn id so the
client can await the change over the Electric stream.

Creates are upserts keyed by the client-generated UUID, so an optimistic retry
is idempotent. Deletes are soft (deleted_at) so they replicate as updates.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Task
from ..schemas import TaskCreate, TaskOut, TaskUpdate, WriteResult

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

_MUTABLE = (
    "title", "body", "status", "priority", "due_at", "area_id", "project_id", "sfdc_url", "sort_order",
)


async def _txid(session: AsyncSession) -> str:
    val = (await session.execute(text("SELECT pg_current_xact_id()::text"))).scalar_one()
    return str(val)


@router.get("", response_model=list[TaskOut])
async def list_tasks(session: AsyncSession = Depends(get_session)) -> list[Task]:
    rows = (
        await session.execute(
            select(Task)
            .where(Task.deleted_at.is_(None))
            .order_by(Task.sort_order, Task.created_at)
        )
    ).scalars().all()
    return list(rows)


@router.post("", response_model=WriteResult)
async def create_task(
    payload: TaskCreate, session: AsyncSession = Depends(get_session)
) -> WriteResult:
    stmt = pg_insert(Task).values(**payload.model_dump())
    set_ = {c: stmt.excluded[c] for c in _MUTABLE}
    set_["updated_at"] = func.now()
    set_["deleted_at"] = None  # re-creating a soft-deleted id revives it
    stmt = stmt.on_conflict_do_update(index_elements=[Task.id], set_=set_).returning(Task)
    task = (await session.execute(stmt)).scalars().one()
    txid = await _txid(session)
    await session.commit()
    return WriteResult(task=TaskOut.model_validate(task), txid=txid)


@router.patch("/{task_id}", response_model=WriteResult)
async def update_task(
    task_id: uuid.UUID, payload: TaskUpdate, session: AsyncSession = Depends(get_session)
) -> WriteResult:
    values = payload.model_dump(exclude_unset=True)
    values["updated_at"] = func.now()
    stmt = update(Task).where(Task.id == task_id).values(**values).returning(Task)
    task = (await session.execute(stmt)).scalars().first()
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    txid = await _txid(session)
    await session.commit()
    return WriteResult(task=TaskOut.model_validate(task), txid=txid)


@router.delete("/{task_id}", response_model=WriteResult)
async def delete_task(
    task_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> WriteResult:
    stmt = (
        update(Task)
        .where(Task.id == task_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(Task)
    )
    task = (await session.execute(stmt)).scalars().first()
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    txid = await _txid(session)
    await session.commit()
    return WriteResult(task=TaskOut.model_validate(task), txid=txid)
