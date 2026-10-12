"""Track each linked Google task's last-seen `updated` timestamp

Lets the importer pull title/due/notes changes from Google when the upstream
task genuinely changes, without clobbering local edits on every sync.

Revision ID: 0009_gtask_updated
Revises: 0008_suggestions
Create Date: 2026-09-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_gtask_updated"
down_revision: Union[str, None] = "0008_suggestions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "gtask_links",
        sa.Column("gtask_updated", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("gtask_links", "gtask_updated")
