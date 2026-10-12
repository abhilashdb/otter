"""PT estimator: split MU→DBU into 1-month & 3-month reservation terms, and add
a reservation_term to scenarios.

Renames pt_models.mu_to_dbu → mu_to_dbu_1mo (preserving existing data) and adds
mu_to_dbu_3mo; adds pt_scenarios.reservation_term. Both tables are published to
Electric, so restart Electric after upgrading so it re-reads the schema.

Revision ID: 0011_pt_reservation_terms
Revises: 0010_pt_estimator
Create Date: 2026-09-20
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_pt_reservation_terms"
down_revision: Union[str, None] = "0010_pt_estimator"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("pt_models", "mu_to_dbu", new_column_name="mu_to_dbu_1mo")
    op.add_column(
        "pt_models",
        sa.Column("mu_to_dbu_3mo", sa.Float(), server_default="0", nullable=False),
    )
    op.add_column(
        "pt_scenarios",
        sa.Column("reservation_term", sa.String(length=8), server_default="1mo", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("pt_scenarios", "reservation_term")
    op.drop_column("pt_models", "mu_to_dbu_3mo")
    op.alter_column("pt_models", "mu_to_dbu_1mo", new_column_name="mu_to_dbu")
