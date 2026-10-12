"""Note write API: timestamped notes attached to any entity (task/area/project)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Note
from ..schemas import NoteCreate, NoteOut

router = APIRouter(prefix="/api/notes", tags=["notes"])


@router.get("", response_model=list[NoteOut])
async def list_notes(
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[Note]:
    stmt = select(Note).where(Note.deleted_at.is_(None))
    if entity_type is not None:
        stmt = stmt.where(Note.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(Note.entity_id == entity_id)
    stmt = stmt.order_by(Note.created_at.desc())
    return list((await session.execute(stmt)).scalars().all())


@router.post("", response_model=NoteOut)
async def create_note(payload: NoteCreate, session: AsyncSession = Depends(get_session)) -> Note:
    stmt = pg_insert(Note).values(**payload.model_dump())
    stmt = stmt.on_conflict_do_update(
        index_elements=[Note.id],
        set_={"body": stmt.excluded.body, "updated_at": func.now(), "deleted_at": None},
    ).returning(Note)
    note = (await session.execute(stmt)).scalars().one()
    await session.commit()
    return note


@router.delete("/{note_id}", response_model=NoteOut)
async def delete_note(note_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Note:
    stmt = (
        update(Note)
        .where(Note.id == note_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(Note)
    )
    note = (await session.execute(stmt)).scalars().first()
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    await session.commit()
    return note
