"""Thin async client for the Databricks-hosted Slack MCP.

Slack access goes through the workspace AI Gateway's MCP endpoint
(`system.ai.slack`) rather than a Slack app — so it reuses the same Databricks
CLI-minted bearer token as FMAPI (see llm.py). This module only opens an MCP
session and calls tools; parsing the (markdown) tool output lives in suggest.py,
mirroring how google_client.py does HTTP and suggest.py/gsync.py parse.

The MCP client here is the `mcp` package's streamable-HTTP transport. NB: this
build (mcp 2.2.0) ships its own `httpx2` and uses snake_case result attributes
(`is_error`, not `isError`).
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from . import llm
from .config import settings


class _Caller:
    """A live MCP session; `.call(name, args)` returns the tool's text output."""

    def __init__(self, session: ClientSession) -> None:
        self._session = session

    async def call(self, name: str, args: dict) -> str:
        res = await self._session.call_tool(name, args)
        if getattr(res, "is_error", False):
            raise RuntimeError(f"slack MCP tool {name} returned an error")
        parts = [
            c.text for c in (res.content or []) if getattr(c, "text", None)
        ]
        return "\n".join(parts)


@asynccontextmanager
async def session():
    """Open an authenticated Slack MCP session. Usage:

        async with slack_client.session() as sc:
            text = await sc.call("slack_read_user_profile", {})
    """
    token = await llm._token()
    http = httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {token}"}, timeout=90
    )
    async with http, streamable_http_client(settings.slack_mcp_url, http_client=http) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as s:
            await s.initialize()
            yield _Caller(s)


def unwrap(text: str) -> str:
    """Slack MCP tools wrap their payload as {"result"/"results": "<markdown>"}.
    Return the inner markdown (or the raw text if it isn't wrapped that way)."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return text
    if isinstance(data, dict):
        return data.get("results") or data.get("result") or text
    return text
