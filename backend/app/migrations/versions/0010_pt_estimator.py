"""Reserved PT estimator: model rate cards, named usage datasets, and saved
simulations. All three are published to Electric (the tool live-queries them
from PGlite).

Revision ID: 0010_pt_estimator
Revises: 0009_gtask_updated
Create Date: 2026-09-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0010_pt_estimator"
down_revision: Union[str, None] = "0009_gtask_updated"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pt_models",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("sku", sa.Text(), server_default="", nullable=False),
        sa.Column("mu_to_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("dbu_rate", sa.Float(), server_default="0", nullable=False),
        sa.Column("std_input_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("std_output_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("std_cache_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("pri_input_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("pri_output_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("pri_cache_dbu", sa.Float(), server_default="0", nullable=False),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "pt_usage",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("granularity", sa.String(length=8), server_default="tpm", nullable=False),
        sa.Column("data", sa.Text(), server_default="[]", nullable=False),
        sa.Column("row_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "pt_scenarios",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("model_id", UUID(as_uuid=True), nullable=True),
        sa.Column("usage_id", UUID(as_uuid=True), nullable=True),
        sa.Column("dbu_rate_discounted", sa.Float(), nullable=True),
        sa.Column("rpm", sa.Float(), server_default="0", nullable=False),
        sa.Column("avg_input_tokens", sa.Float(), server_default="0", nullable=False),
        sa.Column("avg_output_tokens", sa.Float(), server_default="0", nullable=False),
        sa.Column("cache_pct", sa.Float(), server_default="0", nullable=False),
        sa.Column("mus", sa.Float(), server_default="0", nullable=False),
        sa.Column("baseline_mus", sa.Float(), nullable=True),
        sa.Column("tpm_cap", sa.Float(), server_default="20000000", nullable=False),
        sa.Column("ppt_tier", sa.String(length=16), server_default="standard", nullable=False),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("pt_scenarios")
    op.drop_table("pt_usage")
    op.drop_table("pt_models")
