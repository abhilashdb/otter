"""Simulations can project organic growth: a per-minute uplift applied by day
type (weekday vs weekend), scaling the whole demand series — peaks included — at
the same request shape. Adds `growth_weekday_pct` and `growth_weekend_pct` to
pt_scenarios (0 → no growth). Published table already; the new columns replicate
through Electric.

Revision ID: 0016_pt_scenario_growth
Revises: 0015_pt_scenario_blend
Create Date: 2026-09-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_pt_scenario_growth"
down_revision: Union[str, None] = "0015_pt_scenario_blend"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pt_scenarios",
        sa.Column("growth_weekday_pct", sa.Float(), server_default="0", nullable=False),
    )
    op.add_column(
        "pt_scenarios",
        sa.Column("growth_weekend_pct", sa.Float(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("pt_scenarios", "growth_weekend_pct")
    op.drop_column("pt_scenarios", "growth_weekday_pct")
