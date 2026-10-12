"""sfdc_url on tasks and projects (link to a Salesforce use case)

Revision ID: 0004_sfdc_url
Revises: 0003_task_notes
Create Date: 2026-09-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_sfdc_url"
down_revision: Union[str, None] = "0003_task_notes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("sfdc_url", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("sfdc_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "sfdc_url")
    op.drop_column("tasks", "sfdc_url")
