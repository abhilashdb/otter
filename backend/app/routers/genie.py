"""Genie One (Databricks MCP) proxy: ask a natural-language question over
whatever Unity-Catalog-governed data the caller can see, wait for Genie's
answer, and return a normalized result. Stateless on this side — no DB table —
the `conversation_id` round-trips through the client so a follow-up question
continues the same Genie turn."""
from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .. import genie_client
from ..config import settings
from ..db import get_session
from ..models import GenieConversation

log = logging.getLogger("otter.genie")

router = APIRouter(prefix="/api/genie", tags=["genie"])


class GenieAskIn(BaseModel):
    question: str
    conversation_id: str | None = None


class GenieSource(BaseModel):
    title: str | None = None
    url: str


class GenieTable(BaseModel):
    columns: list[str]
    rows: list[list]


class GenieAskOut(BaseModel):
    conversation_id: str
    response_id: str
    status: str
    text: str
    sources: list[GenieSource]
    table: GenieTable | None = None


@router.get("/status")
async def genie_status() -> dict:
    return {"configured": settings.genie_configured, "host": settings.genie_host}


@router.post("/ask", response_model=GenieAskOut)
async def genie_ask(payload: GenieAskIn) -> dict:
    if not settings.genie_configured:
        raise HTTPException(status_code=503, detail="Genie isn't configured (set GENIE_HOST in .env)")
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="question is required")
    try:
        result = await genie_client.ask_and_wait(question, payload.conversation_id)
    except RuntimeError as exc:
        log.warning("genie ask failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return result


class GenieViewCallIn(BaseModel):
    name: str
    arguments: dict = {}


@router.get("/app")
async def genie_app() -> dict:
    """HTML of the Genie One MCP App view, for the frontend's sandboxed iframe."""
    if not settings.genie_configured:
        raise HTTPException(status_code=503, detail="Genie isn't configured (set GENIE_HOST in .env)")
    try:
        return await genie_client.app_resource()
    except RuntimeError as exc:
        log.warning("genie app resource failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/view/call")
async def genie_view_call(payload: GenieViewCallIn, session: AsyncSession = Depends(get_session)) -> dict:
    """Proxy a tools/call from the MCP App iframe (view_ask, view_poll_response,
    ...) and return the raw CallToolResult."""
    if not settings.genie_configured:
        raise HTTPException(status_code=503, detail="Genie isn't configured (set GENIE_HOST in .env)")
    try:
        result = await genie_client.view_call(payload.name, payload.arguments)
    except RuntimeError as exc:
        log.warning("genie view call %s failed: %s", payload.name, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if payload.name == "view_ask" and not result.get("isError"):
        try:
            await _record_turn(session, str(payload.arguments.get("question", "")), result)
        except Exception:  # noqa: BLE001 — history is best-effort; never fail the ask
            log.warning("couldn't record genie turn", exc_info=True)
    return result


async def _record_turn(session: AsyncSession, question: str, result: dict) -> None:
    """Append this `view_ask` turn to its conversation (creating the row on the
    first turn, titled with the opening question)."""
    cid = (result.get("structuredContent") or {}).get("conversation_id")
    if not cid:
        return
    row = (
        await session.execute(select(GenieConversation).where(GenieConversation.conversation_id == cid))
    ).scalar_one_or_none()
    turn = {"question": question, "result": result}
    if row is None:
        stmt = pg_insert(GenieConversation).values(
            id=uuid.uuid4(), conversation_id=cid, title=question.strip()[:80], turns=json.dumps([turn])
        )
        await session.execute(stmt.on_conflict_do_nothing(index_elements=[GenieConversation.conversation_id]))
    else:
        row.turns = json.dumps([*json.loads(row.turns), turn])
        row.updated_at = func.now()
        row.deleted_at = None
    await session.commit()


class ConversationSummary(BaseModel):
    conversation_id: str
    title: str
    turn_count: int
    updated_at: str


@router.get("/conversations", response_model=list[ConversationSummary])
async def list_conversations(session: AsyncSession = Depends(get_session)) -> list[dict]:
    rows = (
        await session.execute(
            select(GenieConversation)
            .where(GenieConversation.deleted_at.is_(None))
            .order_by(GenieConversation.updated_at.desc())
            .limit(200)
        )
    ).scalars()
    return [
        {
            "conversation_id": r.conversation_id,
            "title": r.title or "Untitled",
            "turn_count": len(json.loads(r.turns)),
            "updated_at": r.updated_at.isoformat(),
        }
        for r in rows
    ]


async def _get_row(session: AsyncSession, conversation_id: str) -> GenieConversation:
    row = (
        await session.execute(
            select(GenieConversation).where(
                GenieConversation.conversation_id == conversation_id, GenieConversation.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return row


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    row = await _get_row(session, conversation_id)
    return {"conversation_id": row.conversation_id, "title": row.title, "turns": json.loads(row.turns)}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    row = await _get_row(session, conversation_id)
    row.deleted_at = func.now()
    await session.commit()
    return {"ok": True}
