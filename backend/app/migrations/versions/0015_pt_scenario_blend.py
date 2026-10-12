"""Simulations can blend a percentage of a second usage dataset on top of the
base one — modeling traffic migration (e.g. move 30% of model B's traffic onto
model A). Adds `blend_usage_id` (the add-on dataset) and `blend_pct` (0–100+,
the share of it to add) to pt_scenarios. Published table already; the new
columns replicate through Electric.

Revision ID: 0015_pt_scenario_blend
Revises: 0014_ext_tools_embed
Create Date: 2026-09-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0015_pt_scenario_blend"
down_revision: Union[str, None] = "0014_ext_tools_embed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("pt_scenarios", sa.Column("blend_usage_id", UUID(as_uuid=True), nullable=True))
    op.add_column(
        "pt_scenarios",
        sa.Column("blend_pct", sa.Float(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("pt_scenarios", "blend_pct")
    op.drop_column("pt_scenarios", "blend_usage_id")
