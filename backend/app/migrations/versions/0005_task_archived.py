"""archived_at on tasks (hide from default views without deleting)

Revision ID: 0005_task_archived
Revises: 0004_sfdc_url
Create Date: 2026-09-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_task_archived"
down_revision: Union[str, None] = "0004_sfdc_url"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "archived_at")
