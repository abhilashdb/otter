"""Backup bookkeeping: last backup time / file / error for the Postgres→Drive
backup. Backend-only (not published to Electric).

Revision ID: 0012_backup_state
Revises: 0011_pt_reservation_terms
Create Date: 2026-09-20
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_backup_state"
down_revision: Union[str, None] = "0011_pt_reservation_terms"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "backup_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("last_backup_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_file_id", sa.Text(), nullable=True),
        sa.Column("last_file_name", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("backup_state")
