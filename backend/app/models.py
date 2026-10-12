"""SQLAlchemy models. Sync-ready: UUID ids, created/updated/deleted_at on every table
(soft-delete tombstones so deletes replicate through Electric)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # todo | doing | done
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="todo", server_default="todo")
    # p0 (highest) .. p3
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="p2", server_default="p2")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Soft references (no hard FK, to keep Electric per-table sync order-independent).
    area_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    project: Mapped[str | None] = mapped_column(Text)  # legacy freeform; superseded by project_id
    sfdc_url: Mapped[str | None] = mapped_column(Text)  # link to a Salesforce use case
    sort_order: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    gcal_event_id: Mapped[str | None] = mapped_column(Text)
    gcal_etag: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Area(Base):
    """Top-level context for tasks: a customer, or a non-customer bucket."""

    __tablename__ = "areas"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # customer | internal | growth | personal | other
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="other", server_default="other")
    color: Mapped[str | None] = mapped_column(String(16))
    sort_order: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Note(Base):
    """A timestamped note attached to any entity (task/area/project)."""

    __tablename__ = "notes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(16), nullable=False)  # task | area | project
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Link(Base):
    """A named link (key=label, value=url) attached to any entity. Many allowed."""

    __tablename__ = "links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(16), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    url: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    sort_order: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GoogleAccount(Base):
    """The connected Google account + OAuth tokens for the Tasks integration.

    Backend-only (never published to Electric — it holds secrets). Single row,
    id=1: this is a local, single-user app.
    """

    __tablename__ = "google_account"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    email: Mapped[str | None] = mapped_column(Text)
    access_token: Mapped[str | None] = mapped_column(Text)
    refresh_token: Mapped[str | None] = mapped_column(Text)
    token_expiry: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[str | None] = mapped_column(Text)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class BackupState(Base):
    """Bookkeeping for the scheduled Postgres→Drive backup. Backend-only (never
    published to Electric). Single row, id=1."""

    __tablename__ = "backup_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    last_backup_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    last_file_id: Mapped[str | None] = mapped_column(Text)
    last_file_name: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class GtaskLink(Base):
    """Maps an imported Google task to its Otter task, so re-imports are idempotent
    and status changes can be pushed back. Backend-only (not published to Electric)."""

    __tablename__ = "gtask_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    gtask_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    list_id: Mapped[str] = mapped_column(Text, nullable=False)
    # The Otter status last pushed to Google (todo|doing|done); lets us detect changes.
    pushed_status: Mapped[str | None] = mapped_column(String(16))
    # Google task's `updated` timestamp at our last content pull — lets us detect a
    # genuine upstream edit (title/due/notes) and pull it in without clobbering
    # local edits on every sync.
    gtask_updated: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Suggestion(Base):
    """A task Otter proposes after scanning an external source (email, calendar,
    later Slack). Published to Electric so the review inbox live-queries it.

    Lifecycle: pending → accepted (a real Task is created, id in created_task_id)
    or dismissed. Deduped by (source, source_ref) so the same email/meeting isn't
    proposed twice, and a dismissal is remembered."""

    __tablename__ = "suggestions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # email | calendar | slack
    source_ref: Mapped[str] = mapped_column(Text, nullable=False)  # message/event id
    title: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    detail: Mapped[str | None] = mapped_column(Text)  # sender / meeting time / snippet
    link_url: Mapped[str | None] = mapped_column(Text)  # deep link back to the source
    suggested_due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # LLM-proposed filing (soft references; project is optional and may be null).
    suggested_area_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    suggested_project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # pending | accepted | dismissed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    created_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # When the underlying item is (meeting start / email date) — for ordering.
    source_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ScanState(Base):
    """Per-source incremental cursor for the suggestion engine. Backend-only
    (never published to Electric). One row per source name."""

    __tablename__ = "scan_state"

    source: Mapped[str] = mapped_column(String(16), primary_key=True)
    cursor: Mapped[str | None] = mapped_column(Text)  # e.g. last-scan epoch seconds
    last_scan_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PtModel(Base):
    """A foundation-model rate card for the Reserved PT estimator tool.

    Fixed, reusable characteristics of an OSS FMAPI model: the MU→DBU capacity
    factor, the SKU's $/DBU list rate, and the pay-per-token (PPT) rate card.
    PPT rates are stored in **DBU per 1M tokens** (converted to $ via the DBU
    rate, list or a scenario's discounted rate) across Standard and Priority
    tiers for input / output / cached-read tokens. Published to Electric."""

    __tablename__ = "pt_models"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sku: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # Capacity: DBU consumed per Model Unit per hour (the reserved-PT price basis).
    # Two reservation terms — a 1-month and a (usually cheaper) 3-month rate; the
    # scenario picks which one applies via reservation_term.
    mu_to_dbu_1mo: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    mu_to_dbu_3mo: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # Short terms priced at a premium over the 1-month rate (1 day = 2x, 1 week = 1.75x);
    # stored so they can be overridden per model.
    mu_to_dbu_1d: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    mu_to_dbu_1w: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # SKU list price: $ per DBU.
    dbu_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # PPT rate card — DBU per 1M tokens. std = Standard tier, pri = Priority tier.
    std_input_dbu: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    std_output_dbu: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    std_cache_dbu: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    pri_input_dbu: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    pri_output_dbu: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    pri_cache_dbu: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PtUsage(Base):
    """A named, reusable historical-usage dataset for the PT estimator: an
    uploaded CSV of real customer usage, either per-minute TPM samples or
    hourly token totals across dates. Normalized points are stored as a JSON
    array in `data` ([{t, total, input?, output?, cached?}]). One dataset can
    back many simulations (optimize different baselines against the same
    actuals). Published to Electric."""

    __tablename__ = "pt_usage"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # tpm = per-minute token-rate samples; tph = hourly token totals.
    granularity: Mapped[str] = mapped_column(String(8), nullable=False, default="tpm", server_default="tpm")
    data: Mapped[str] = mapped_column(Text, nullable=False, default="[]", server_default="[]")
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PtScenario(Base):
    """A saved Reserved-PT simulation: a model + a usage dataset + the PT sizing
    inputs and the reserved baseline being evaluated. All the cost math runs
    client-side; this just persists the inputs so simulations can be re-opened
    and compared. Published to Electric."""

    __tablename__ = "pt_scenarios"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    usage_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Traffic-migration blend: add `blend_pct`% of `blend_usage_id`'s series on
    # top of the base usage (models moving a share of another model's traffic in).
    blend_usage_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    blend_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # Organic-growth uplift applied per minute by day type (peaks included), to
    # project future demand at the same request shape. 0 → no growth.
    growth_weekday_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    growth_weekend_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # Scenario-specific discounted $/DBU (null → use the model's list rate).
    dbu_rate_discounted: Mapped[float | None] = mapped_column(Float)
    # PT sizing inputs (fed to the external MU sizer; kept here for the record
    # and to calibrate the MU→TPM conversion).
    rpm: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    avg_input_tokens: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    avg_output_tokens: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    cache_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # MUs sized for the (rpm, tokens) reference point — pasted from the external
    # sizing app (can't be derived here). Calibrates TPM-per-MU for the sweep.
    mus: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # The reserved PT baseline being evaluated, in MUs (null → default to `mus`
    # or the sweep's recommendation).
    baseline_mus: Mapped[float | None] = mapped_column(Float)
    # Spike ceiling in tokens/minute (default 20M; scenarios may raise it).
    tpm_cap: Mapped[float] = mapped_column(Float, nullable=False, default=20_000_000, server_default="20000000")
    # Which PPT tier bursts are billed at: standard | priority.
    ppt_tier: Mapped[str] = mapped_column(String(16), nullable=False, default="standard", server_default="standard")
    # Reservation term for the MU→DBU rate: 1d | 1w | 1mo | 3mo.
    reservation_term: Mapped[str] = mapped_column(String(8), nullable=False, default="1mo", server_default="1mo")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Project(Base):
    """Optional sub-group inside an Area (e.g. a specific customer engagement)."""

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    area_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sfdc_url: Mapped[str | None] = mapped_column(Text)  # link to a Salesforce use case
    sort_order: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ExtTool(Base):
    """An external tool: a user-added link to a tool outside the app, listed on
    the Tools page next to the built-in tools and launched in a new tab. Only a
    name + url (+ optional description); no in-app UI. Published to Electric."""

    __tablename__ = "ext_tools"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    sort_order: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    # When set, the tool opens embedded in an in-app iframe instead of a new tab
    # (e.g. Databricks Apps, which allow framing for authenticated viewers).
    embed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GenieConversation(Base):
    """A past Genie One conversation, listed in the Genie tool so it can be
    reopened. `conversation_id` is Genie's own id; `turns` is a JSON array of
    {question, result} where `result` is the original `view_ask` tool result —
    replaying it into the MCP App view makes the view re-fetch the answer from
    Databricks. Not published to Electric (REST only)."""

    __tablename__ = "genie_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    turns: Mapped[str] = mapped_column(Text, nullable=False, default="[]", server_default="[]")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
