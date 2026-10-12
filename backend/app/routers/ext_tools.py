"""External-tool write API: user-added links to tools outside the app. Same
optimistic pattern as areas — client generates the UUID, creates are upserts,
deletes are soft (tombstones replicate through Electric)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import ExtTool
from ..schemas import ExtToolCreate, ExtToolOut, ExtToolUpdate

router = APIRouter(prefix="/api/ext-tools", tags=["ext-tools"])

_MUTABLE = ("name", "url", "description", "sort_order", "embed")


@router.get("", response_model=list[ExtToolOut])
async def list_ext_tools(session: AsyncSession = Depends(get_session)) -> list[ExtTool]:
    rows = (
        await session.execute(
            select(ExtTool)
            .where(ExtTool.deleted_at.is_(None))
            .order_by(ExtTool.sort_order, ExtTool.name)
        )
    ).scalars().all()
    return list(rows)


@router.post("", response_model=ExtToolOut)
async def create_ext_tool(
    payload: ExtToolCreate, session: AsyncSession = Depends(get_session)
) -> ExtTool:
    stmt = pg_insert(ExtTool).values(**payload.model_dump())
    set_ = {c: stmt.excluded[c] for c in _MUTABLE}
    set_["updated_at"] = func.now()
    set_["deleted_at"] = None
    stmt = stmt.on_conflict_do_update(index_elements=[ExtTool.id], set_=set_).returning(ExtTool)
    tool = (await session.execute(stmt)).scalars().one()
    await session.commit()
    return tool


@router.patch("/{tool_id}", response_model=ExtToolOut)
async def update_ext_tool(
    tool_id: uuid.UUID, payload: ExtToolUpdate, session: AsyncSession = Depends(get_session)
) -> ExtTool:
    values = payload.model_dump(exclude_unset=True)
    values["updated_at"] = func.now()
    stmt = update(ExtTool).where(ExtTool.id == tool_id).values(**values).returning(ExtTool)
    tool = (await session.execute(stmt)).scalars().first()
    if tool is None:
        raise HTTPException(status_code=404, detail="ext tool not found")
    await session.commit()
    return tool


@router.delete("/{tool_id}", response_model=ExtToolOut)
async def delete_ext_tool(
    tool_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> ExtTool:
    stmt = (
        update(ExtTool)
        .where(ExtTool.id == tool_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(ExtTool)
    )
    tool = (await session.execute(stmt)).scalars().first()
    if tool is None:
        raise HTTPException(status_code=404, detail="ext tool not found")
    await session.commit()
    return tool
