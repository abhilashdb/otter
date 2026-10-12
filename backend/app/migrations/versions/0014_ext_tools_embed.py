"""External tools can open embedded (in an in-app iframe) instead of a new tab.
Adds `embed` to ext_tools — set for pages that allow framing, e.g. Databricks
Apps (embeddable when the viewer is an authenticated Databricks user with access
to the app). Published table already; the new column replicates through Electric.

Revision ID: 0014_ext_tools_embed
Revises: 0013_ext_tools
Create Date: 2026-09-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014_ext_tools_embed"
down_revision: Union[str, None] = "0013_ext_tools"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ext_tools",
        sa.Column("embed", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("ext_tools", "embed")
