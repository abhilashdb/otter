"""Task suggestions: proposed tasks from external scans + per-source scan cursors

`suggestions` is published to Electric (the review inbox live-queries it);
`scan_state` is backend-only (incremental cursors, never sent to the browser).

Revision ID: 0008_suggestions
Revises: 0007_google_sync
Create Date: 2026-09-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0008_suggestions"
down_revision: Union[str, None] = "0007_google_sync"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "suggestions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("source_ref", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), server_default="", nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("link_url", sa.Text(), nullable=True),
        sa.Column("suggested_due", sa.DateTime(timezone=True), nullable=True),
        sa.Column("suggested_area_id", UUID(as_uuid=True), nullable=True),
        sa.Column("suggested_project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("created_task_id", UUID(as_uuid=True), nullable=True),
        sa.Column("source_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    # One suggestion per source item — makes re-scans idempotent and remembers
    # dismissals (partial: tombstoned rows don't block a fresh proposal).
    op.create_index(
        "ux_suggestions_source_ref",
        "suggestions",
        ["source", "source_ref"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_table(
        "scan_state",
        sa.Column("source", sa.String(length=16), primary_key=True),
        sa.Column("cursor", sa.Text(), nullable=True),
        sa.Column("last_scan_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("scan_state")
    op.drop_index("ux_suggestions_source_ref", table_name="suggestions")
    op.drop_table("suggestions")
