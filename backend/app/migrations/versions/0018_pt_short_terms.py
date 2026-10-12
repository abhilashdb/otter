"""PT estimator: add 1-day and 1-week reservation rates to pt_models.

Published to Electric, so recreate the electric container after upgrading
(`docker compose up -d --force-recreate electric`) so it re-reads the schema.
Existing models are backfilled from their 1-month rate: 1 day = 2x, 1 week = 1.75x.

Revision ID: 0018_pt_short_terms
Revises: 0017_genie_conversations
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0018_pt_short_terms"
down_revision: Union[str, None] = "0017_genie_conversations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for col in ("mu_to_dbu_1d", "mu_to_dbu_1w"):
        op.add_column("pt_models", sa.Column(col, sa.Float(), server_default="0", nullable=False))
    op.execute("UPDATE pt_models SET mu_to_dbu_1d = mu_to_dbu_1mo * 2, mu_to_dbu_1w = mu_to_dbu_1mo * 1.75")


def downgrade() -> None:
    op.drop_column("pt_models", "mu_to_dbu_1w")
    op.drop_column("pt_models", "mu_to_dbu_1d")
