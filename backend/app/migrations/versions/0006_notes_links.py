"""Generalize notes to any entity (task/area/project) + add key-value links

Revision ID: 0006_notes_links
Revises: 0005_task_archived
Create Date: 2026-09-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006_notes_links"
down_revision: Union[str, None] = "0005_task_archived"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_type", sa.String(16), nullable=False),  # task | area | project
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_notes_entity", "notes", ["entity_type", "entity_id"])
    # carry existing task notes over
    op.execute(
        "INSERT INTO notes (id, entity_type, entity_id, body, created_at, updated_at, deleted_at) "
        "SELECT id, 'task', task_id, body, created_at, updated_at, deleted_at FROM task_notes"
    )
    op.drop_table("task_notes")

    op.create_table(
        "links",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_type", sa.String(16), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("label", sa.Text(), nullable=False, server_default=""),
        sa.Column("url", sa.Text(), nullable=False, server_default=""),
        sa.Column("sort_order", sa.Float(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_links_entity", "links", ["entity_type", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_links_entity", table_name="links")
    op.drop_table("links")
    op.create_table(
        "task_notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "INSERT INTO task_notes (id, task_id, body, created_at, updated_at, deleted_at) "
        "SELECT id, entity_id, body, created_at, updated_at, deleted_at FROM notes WHERE entity_type = 'task'"
    )
    op.drop_index("ix_notes_entity", table_name="notes")
    op.drop_table("notes")
