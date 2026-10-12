"""Write API for the Reserved PT estimator tool: model rate cards, named usage
datasets, and saved simulations. Same contract as the other routers — the tool
reads rows locally from PGlite (hydrated by Electric); these endpoints own the
authoritative writes to Postgres.

All three entities share one CRUD shape, so create/patch/delete are generic over
the model class. Creates are upserts keyed by the client UUID (idempotent);
deletes are soft (deleted_at) so they replicate as updates.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Base, PtModel, PtScenario, PtUsage
from ..schemas import (
    PtModelCreate,
    PtModelUpdate,
    PtScenarioCreate,
    PtScenarioUpdate,
    PtUsageCreate,
    PtUsageUpdate,
    PtWriteResult,
)

router = APIRouter(prefix="/api/pt", tags=["pt"])


async def _txid(session: AsyncSession) -> str:
    val = (await session.execute(text("SELECT pg_current_xact_id()::text"))).scalar_one()
    return str(val)


async def _upsert(session: AsyncSession, model: type[Base], payload: BaseModel) -> PtWriteResult:
    data = payload.model_dump()
    stmt = pg_insert(model).values(**data)
    set_ = {c: stmt.excluded[c] for c in data if c != "id"}
    set_["updated_at"] = func.now()
    set_["deleted_at"] = None  # re-creating a soft-deleted id revives it
    stmt = stmt.on_conflict_do_update(index_elements=[model.id], set_=set_).returning(model.id)
    rid = (await session.execute(stmt)).scalar_one()
    txid = await _txid(session)
    await session.commit()
    return PtWriteResult(id=rid, txid=txid)


async def _patch(
    session: AsyncSession, model: type[Base], row_id: uuid.UUID, payload: BaseModel
) -> PtWriteResult:
    values = payload.model_dump(exclude_unset=True)
    values["updated_at"] = func.now()
    stmt = update(model).where(model.id == row_id).values(**values).returning(model.id)
    rid = (await session.execute(stmt)).scalars().first()
    if rid is None:
        raise HTTPException(status_code=404, detail="not found")
    txid = await _txid(session)
    await session.commit()
    return PtWriteResult(id=rid, txid=txid)


async def _soft_delete(session: AsyncSession, model: type[Base], row_id: uuid.UUID) -> PtWriteResult:
    stmt = (
        update(model)
        .where(model.id == row_id)
        .values(deleted_at=func.now(), updated_at=func.now())
        .returning(model.id)
    )
    rid = (await session.execute(stmt)).scalars().first()
    if rid is None:
        raise HTTPException(status_code=404, detail="not found")
    txid = await _txid(session)
    await session.commit()
    return PtWriteResult(id=rid, txid=txid)


# ── Models (rate cards) ───────────────────────────────────────────────────────
@router.post("/models", response_model=PtWriteResult)
async def create_model(p: PtModelCreate, session: AsyncSession = Depends(get_session)):
    return await _upsert(session, PtModel, p)


@router.patch("/models/{row_id}", response_model=PtWriteResult)
async def update_model(row_id: uuid.UUID, p: PtModelUpdate, session: AsyncSession = Depends(get_session)):
    return await _patch(session, PtModel, row_id, p)


@router.delete("/models/{row_id}", response_model=PtWriteResult)
async def delete_model(row_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    return await _soft_delete(session, PtModel, row_id)


# ── Usage datasets ────────────────────────────────────────────────────────────
@router.post("/usage", response_model=PtWriteResult)
async def create_usage(p: PtUsageCreate, session: AsyncSession = Depends(get_session)):
    return await _upsert(session, PtUsage, p)


@router.patch("/usage/{row_id}", response_model=PtWriteResult)
async def update_usage(row_id: uuid.UUID, p: PtUsageUpdate, session: AsyncSession = Depends(get_session)):
    return await _patch(session, PtUsage, row_id, p)


@router.delete("/usage/{row_id}", response_model=PtWriteResult)
async def delete_usage(row_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    return await _soft_delete(session, PtUsage, row_id)


# ── Simulations (scenarios) ───────────────────────────────────────────────────
@router.post("/scenarios", response_model=PtWriteResult)
async def create_scenario(p: PtScenarioCreate, session: AsyncSession = Depends(get_session)):
    return await _upsert(session, PtScenario, p)


@router.patch("/scenarios/{row_id}", response_model=PtWriteResult)
async def update_scenario(
    row_id: uuid.UUID, p: PtScenarioUpdate, session: AsyncSession = Depends(get_session)
):
    return await _patch(session, PtScenario, row_id, p)


@router.delete("/scenarios/{row_id}", response_model=PtWriteResult)
async def delete_scenario(row_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    return await _soft_delete(session, PtScenario, row_id)
