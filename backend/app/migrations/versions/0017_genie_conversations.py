"""Genie conversations: the list of past Genie One conversations, so the Genie
tool can reopen them. Stores only ids + the original view_ask result per turn
(the MCP App view re-fetches the actual answer from Databricks). Not published
to Electric — the tool is online-only, so it's plain REST.

Revision ID: 0017_genie_conversations
Revises: 0016_pt_scenario_growth
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0017_genie_conversations"
down_revision: Union[str, None] = "0016_pt_scenario_growth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "genie_conversations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("conversation_id", sa.Text(), nullable=False, unique=True),
        sa.Column("title", sa.Text(), server_default="", nullable=False),
        sa.Column("turns", sa.Text(), server_default="[]", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("genie_conversations")
