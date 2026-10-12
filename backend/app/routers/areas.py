"""Area write API (customers / internal / growth buckets). Same optimistic pattern
as tasks: client generates the UUID, creates are upserts, deletes are soft."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Area
from ..schemas import AreaCreate, AreaOut, AreaUpdate

router = APIRouter(prefix="/api/areas", tags=["areas"])

_MUTABLE = ("name", "kind", "color", "sort_order")


@router.get("", response_model=list[AreaOut])
async def list_areas(session: AsyncSession = Depends(get_session)) -> list[Area]:
    rows = (
        await session.execute(
            select(Area).where(Area.deleted_at.is_(None)).order_by(Area.sort_order, Area.name)
        )
    ).scalars().all()
    return list(rows)


@router.post("", response_model=AreaOut)
async def create_area(payload: AreaCreate, session: AsyncSession = Depends(get_session)) -> Area:
    stmt = pg_insert(Area).values(**payload.model_dump())
    set_ = {c: stmt.excluded[c] for c in _MUTABLE}
    set_["updated_at"] = func.now()
    set_["deleted_at"] = None
    stmt = stmt.on_conflict_do_update(index_elements=[Area.id], set_=set_).returning(Area)
    area = (await session.execute(stmt)).scalars().one()
    await session.commit()
    return area


@router.patch("/{area_id}", response_model=AreaOut)
async def update_area(
    area_id: uuid.UUID, payload: AreaUpdate, session: AsyncSession = Depends(get_session)
) -> Area:
    values = payload.model_dump(exclude_unset=True)
    values["updated_at"] = func.now()
    stmt = update(Area).where(Area.id == area_id).values(**values).returning(Area)
    area = (await session.execute(stmt)).scalars().first()
    if area is None:
        raise HTTPException(status_code=404, detail="area not found")
    await session.commit()
    return area


@router.delete("/{area_id}", response_model=AreaOut)
async def delete_area(area_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Area:
    stmt = (
        update(Area)
        .where(Area.id == area_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(Area)
    )
    area = (await session.execute(stmt)).scalars().first()
    if area is None:
        raise HTTPException(status_code=404, detail="area not found")
    await session.commit()
    return area
