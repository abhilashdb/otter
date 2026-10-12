"""Pydantic request/response schemas for the write API."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ── Tasks ─────────────────────────────────────────────────────────────────────
class TaskCreate(BaseModel):
    # Client generates the UUID (idempotent, no round-trip for the id).
    id: uuid.UUID
    title: str
    body: str = ""
    status: str = "todo"
    priority: str = "p2"
    due_at: datetime | None = None
    area_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    sfdc_url: str | None = None
    sort_order: float = 0


class TaskUpdate(BaseModel):
    title: str | None = None
    body: str | None = None
    status: str | None = None
    priority: str | None = None
    due_at: datetime | None = None
    area_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    sfdc_url: str | None = None
    archived_at: datetime | None = None
    sort_order: float | None = None


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    body: str
    status: str
    priority: str
    due_at: datetime | None
    area_id: uuid.UUID | None
    project_id: uuid.UUID | None
    sfdc_url: str | None
    sort_order: float
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    archived_at: datetime | None


class WriteResult(BaseModel):
    """A write's authoritative row plus the Postgres transaction id, so the client
    can await this exact change arriving over the Electric stream if it wants to."""

    task: TaskOut
    txid: str = Field(description="Postgres pg_current_xact_id() of the write txn")


class QuickCaptureIn(BaseModel):
    """External quick-capture (macOS Shortcut / CLI). The server generates the id,
    so the caller only needs a title. Lands as an unfiled todo to triage later."""

    title: str
    notes: str | None = None
    due_at: datetime | None = None


class SuggestionAcceptIn(BaseModel):
    """Optional edits applied when turning a suggestion into a task. Any field the
    caller omits falls back to the suggestion's own value; a field sent as null
    explicitly clears it (e.g. drop the suggested project)."""

    title: str | None = None
    due_at: datetime | None = None
    area_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


# ── Areas ─────────────────────────────────────────────────────────────────────
class AreaCreate(BaseModel):
    id: uuid.UUID
    name: str
    kind: str = "other"  # customer | internal | growth | personal | other
    color: str | None = None
    sort_order: float = 0


class AreaUpdate(BaseModel):
    name: str | None = None
    kind: str | None = None
    color: str | None = None
    sort_order: float | None = None


class AreaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    kind: str
    color: str | None
    sort_order: float
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


# ── Projects ──────────────────────────────────────────────────────────────────
class ProjectCreate(BaseModel):
    id: uuid.UUID
    name: str
    area_id: uuid.UUID | None = None
    sfdc_url: str | None = None
    sort_order: float = 0


class ProjectUpdate(BaseModel):
    name: str | None = None
    area_id: uuid.UUID | None = None
    sfdc_url: str | None = None
    sort_order: float | None = None


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    area_id: uuid.UUID | None
    name: str
    sfdc_url: str | None
    sort_order: float
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


# ── Notes (any entity) ────────────────────────────────────────────────────────
class NoteCreate(BaseModel):
    id: uuid.UUID
    entity_type: str  # task | area | project
    entity_id: uuid.UUID
    body: str


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    body: str
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


# ── Links (any entity; key=label, value=url) ────────────────────────────────────
class LinkCreate(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    label: str = ""
    url: str = ""
    sort_order: float = 0


class LinkUpdate(BaseModel):
    label: str | None = None
    url: str | None = None
    sort_order: float | None = None


class LinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    label: str
    url: str
    sort_order: float
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


# ── External tools (user-added links to tools outside the app) ────────────────
class ExtToolCreate(BaseModel):
    id: uuid.UUID
    name: str
    url: str = ""
    description: str = ""
    sort_order: float = 0
    embed: bool = False


class ExtToolUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    description: str | None = None
    sort_order: float | None = None
    embed: bool | None = None


class ExtToolOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    url: str
    description: str
    sort_order: float
    embed: bool
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


# ── Reserved PT estimator (models / usage datasets / simulations) ─────────────
class PtWriteResult(BaseModel):
    """Minimal write ack: the row id + the Postgres txn id (so the client can
    await this exact change over Electric if it wants). The tool reads rows from
    PGlite, so we don't need to echo the whole row back."""

    id: uuid.UUID
    txid: str = Field(description="Postgres pg_current_xact_id() of the write txn")


class PtModelCreate(BaseModel):
    id: uuid.UUID
    name: str
    sku: str = ""
    mu_to_dbu_1mo: float = 0
    mu_to_dbu_3mo: float = 0
    mu_to_dbu_1d: float = 0
    mu_to_dbu_1w: float = 0
    dbu_rate: float = 0
    std_input_dbu: float = 0
    std_output_dbu: float = 0
    std_cache_dbu: float = 0
    pri_input_dbu: float = 0
    pri_output_dbu: float = 0
    pri_cache_dbu: float = 0
    notes: str = ""


class PtModelUpdate(BaseModel):
    name: str | None = None
    sku: str | None = None
    mu_to_dbu_1mo: float | None = None
    mu_to_dbu_3mo: float | None = None
    mu_to_dbu_1d: float | None = None
    mu_to_dbu_1w: float | None = None
    dbu_rate: float | None = None
    std_input_dbu: float | None = None
    std_output_dbu: float | None = None
    std_cache_dbu: float | None = None
    pri_input_dbu: float | None = None
    pri_output_dbu: float | None = None
    pri_cache_dbu: float | None = None
    notes: str | None = None


class PtUsageCreate(BaseModel):
    id: uuid.UUID
    name: str
    granularity: str = "tpm"  # tpm | tph
    data: str = "[]"  # JSON array of normalized points
    row_count: int = 0
    notes: str = ""


class PtUsageUpdate(BaseModel):
    name: str | None = None
    granularity: str | None = None
    data: str | None = None
    row_count: int | None = None
    notes: str | None = None


class PtScenarioCreate(BaseModel):
    id: uuid.UUID
    name: str
    model_id: uuid.UUID | None = None
    usage_id: uuid.UUID | None = None
    blend_usage_id: uuid.UUID | None = None
    blend_pct: float = 0
    growth_weekday_pct: float = 0
    growth_weekend_pct: float = 0
    dbu_rate_discounted: float | None = None
    rpm: float = 0
    avg_input_tokens: float = 0
    avg_output_tokens: float = 0
    cache_pct: float = 0
    mus: float = 0
    baseline_mus: float | None = None
    tpm_cap: float = 20_000_000
    ppt_tier: str = "standard"  # standard | priority
    reservation_term: str = "1mo"  # 1d | 1w | 1mo | 3mo
    notes: str = ""


class PtScenarioUpdate(BaseModel):
    name: str | None = None
    model_id: uuid.UUID | None = None
    usage_id: uuid.UUID | None = None
    blend_usage_id: uuid.UUID | None = None
    blend_pct: float | None = None
    growth_weekday_pct: float | None = None
    growth_weekend_pct: float | None = None
    dbu_rate_discounted: float | None = None
    rpm: float | None = None
    avg_input_tokens: float | None = None
    avg_output_tokens: float | None = None
    cache_pct: float | None = None
    mus: float | None = None
    baseline_mus: float | None = None
    tpm_cap: float | None = None
    ppt_tier: str | None = None
    reservation_term: str | None = None
    notes: str | None = None
