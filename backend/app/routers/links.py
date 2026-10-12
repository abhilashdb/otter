"""Link write API: named links (label + url) attached to any entity. Many allowed."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Link
from ..schemas import LinkCreate, LinkOut, LinkUpdate

router = APIRouter(prefix="/api/links", tags=["links"])

_MUTABLE = ("label", "url", "sort_order")


@router.get("", response_model=list[LinkOut])
async def list_links(
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[Link]:
    stmt = select(Link).where(Link.deleted_at.is_(None))
    if entity_type is not None:
        stmt = stmt.where(Link.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(Link.entity_id == entity_id)
    stmt = stmt.order_by(Link.sort_order, Link.created_at)
    return list((await session.execute(stmt)).scalars().all())


@router.post("", response_model=LinkOut)
async def create_link(payload: LinkCreate, session: AsyncSession = Depends(get_session)) -> Link:
    stmt = pg_insert(Link).values(**payload.model_dump())
    set_ = {c: stmt.excluded[c] for c in _MUTABLE}
    set_["updated_at"] = func.now()
    set_["deleted_at"] = None
    stmt = stmt.on_conflict_do_update(index_elements=[Link.id], set_=set_).returning(Link)
    link = (await session.execute(stmt)).scalars().one()
    await session.commit()
    return link


@router.patch("/{link_id}", response_model=LinkOut)
async def update_link(
    link_id: uuid.UUID, payload: LinkUpdate, session: AsyncSession = Depends(get_session)
) -> Link:
    values = payload.model_dump(exclude_unset=True)
    values["updated_at"] = func.now()
    stmt = update(Link).where(Link.id == link_id).values(**values).returning(Link)
    link = (await session.execute(stmt)).scalars().first()
    if link is None:
        raise HTTPException(status_code=404, detail="link not found")
    await session.commit()
    return link


@router.delete("/{link_id}", response_model=LinkOut)
async def delete_link(link_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Link:
    stmt = (
        update(Link)
        .where(Link.id == link_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(Link)
    )
    link = (await session.execute(stmt)).scalars().first()
    if link is None:
        raise HTTPException(status_code=404, detail="link not found")
    await session.commit()
    return link
