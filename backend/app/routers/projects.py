"""Project write API (optional sub-group inside an Area)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Project
from ..schemas import ProjectCreate, ProjectOut, ProjectUpdate

router = APIRouter(prefix="/api/projects", tags=["projects"])

_MUTABLE = ("name", "area_id", "sfdc_url", "sort_order")


@router.get("", response_model=list[ProjectOut])
async def list_projects(session: AsyncSession = Depends(get_session)) -> list[Project]:
    rows = (
        await session.execute(
            select(Project)
            .where(Project.deleted_at.is_(None))
            .order_by(Project.sort_order, Project.name)
        )
    ).scalars().all()
    return list(rows)


@router.post("", response_model=ProjectOut)
async def create_project(
    payload: ProjectCreate, session: AsyncSession = Depends(get_session)
) -> Project:
    stmt = pg_insert(Project).values(**payload.model_dump())
    set_ = {c: stmt.excluded[c] for c in _MUTABLE}
    set_["updated_at"] = func.now()
    set_["deleted_at"] = None
    stmt = stmt.on_conflict_do_update(index_elements=[Project.id], set_=set_).returning(Project)
    project = (await session.execute(stmt)).scalars().one()
    await session.commit()
    return project


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: uuid.UUID, payload: ProjectUpdate, session: AsyncSession = Depends(get_session)
) -> Project:
    values = payload.model_dump(exclude_unset=True)
    values["updated_at"] = func.now()
    stmt = update(Project).where(Project.id == project_id).values(**values).returning(Project)
    project = (await session.execute(stmt)).scalars().first()
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    await session.commit()
    return project


@router.delete("/{project_id}", response_model=ProjectOut)
async def delete_project(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Project:
    stmt = (
        update(Project)
        .where(Project.id == project_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(Project)
    )
    project = (await session.execute(stmt)).scalars().first()
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    await session.commit()
    return project
