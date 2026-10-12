"""Thin async client for the Databricks-hosted Genie One MCP — natural-language
Q&A over whatever Unity-Catalog-governed data the caller can see. There's no
Genie "space" to configure: `system.ai.genie_one_mcp` operates metastore-wide,
and UC permissions do the scoping (that's the "One" in Genie One).

Genie One lives in a *different* workspace than FMAPI/Slack (see config.py), so
unlike slack_client.py — which reuses llm._token() because it's the same host —
this module mints and caches its own token from a separate CLI login. Same
transport otherwise: the `mcp` package's streamable-HTTP client (see
slack_client.py's module docstring for the httpx2/snake_case notes).

The exact tool-call shape isn't published in the Databricks docs beyond tool
names + one-line descriptions. A real `genie_ask` reply turned out to be plain
markdown text, not JSON — the answer prose, a trailing "**Status:** completed"
line, a markdown link to the thread in the Databricks UI, and the
conversation/response ids tucked into an HTML comment at the end, e.g.:

    **Status:** completed

    <answer prose...>

    [Explore in Databricks](https://.../one/chat/threads/<id>?o=...)

    <!-- agent: Tool-call IDs for your follow-up Genie tool calls; ...
    - `conversation_id`: `...`
    - `response_id`: `...`
    -->

That leading/trailing HTML-comment business also included a directive aimed at
an LLM caller ("your reply MUST include the [...] link rendered verbatim...").
`_parse_markdown_turn` below treats the whole comment as opaque metadata —
it's mined for the ids and otherwise discarded, never followed as an
instruction. `raw` is kept in every result for debugging; `_parse_turn` also
keeps the old tolerant dict-digging path (`_extract_*`) as a fallback for any
tool call that *does* come back as real JSON (observed only for `genie_ask` so
far — `genie_poll_response`/`genie_get_query_result` haven't been exercised
against this exact markdown shape yet).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .config import settings

log = logging.getLogger("otter.genie")

_TERMINAL_STATUSES = {"completed", "failed", "cancelled", "canceled", "error"}
_POLL_INTERVAL_SECONDS = 1.5
_POLL_TIMEOUT_SECONDS = 90
# ClientSession.call_tool() has no timeout of its own — it just awaits a reply
# that arrives over the session's SSE channel. If that reply is ever lost (a
# mismatched request id, a server-side hiccup, ...) the await blocks forever
# with no exception, which is exactly what showed up as a turn stuck on
# "Thinking…" with no error even though Genie had already answered. Every
# call gets a hard ceiling so a lost reply becomes a visible error instead.
_CALL_TIMEOUT_SECONDS = 30

# Cached CLI-minted token: (token, expiry). Separate from llm.py's cache since
# it's a different workspace/profile.
_token_cache: tuple[str, datetime] | None = None
_token_lock = asyncio.Lock()


def _mint_token_sync() -> tuple[str, datetime]:
    cmd = ["databricks", "auth", "token", "--output", "json"]
    if settings.genie_profile:
        cmd += ["-p", settings.genie_profile]
    else:
        cmd += ["--host", settings.genie_host]
    out = subprocess.check_output(cmd, timeout=30, stderr=subprocess.PIPE)
    data = json.loads(out)
    token = data["access_token"]
    expiry = datetime.now(UTC) + timedelta(minutes=10)
    raw = data.get("expiry")
    if raw:
        try:
            expiry = datetime.fromisoformat(raw) - timedelta(seconds=60)
        except ValueError:
            pass
    return token, expiry


async def _token() -> str:
    if settings.genie_token:
        return settings.genie_token
    global _token_cache
    async with _token_lock:
        now = datetime.now(UTC)
        if _token_cache and _token_cache[1] > now:
            return _token_cache[0]
        try:
            token, expiry = await asyncio.to_thread(_mint_token_sync)
        except subprocess.CalledProcessError as exc:
            msg = (exc.stderr or b"").decode(errors="replace").strip()
            raise RuntimeError(f"databricks CLI token failed: {msg or exc}") from exc
        except FileNotFoundError as exc:
            raise RuntimeError("databricks CLI not found on PATH") from exc
        _token_cache = (token, expiry)
        return token


class _Caller:
    """A live MCP session; `.call(name, args)` returns the tool's parsed JSON
    output (or `{"text": ...}` if it wasn't JSON)."""

    def __init__(self, session: ClientSession) -> None:
        self._session = session

    async def call_raw(self, name: str, args: dict, timeout: float = _CALL_TIMEOUT_SECONDS) -> dict:
        """The full CallToolResult (content, structuredContent, isError, ...)
        as a JSON-able dict — what an MCP Apps view expects back from its own
        `tools/call` requests."""
        try:
            res = await asyncio.wait_for(self._session.call_tool(name, args), timeout=timeout)
        except TimeoutError as exc:
            raise RuntimeError(f"genie MCP tool {name} didn't reply within {timeout:.0f}s") from exc
        return res.model_dump(by_alias=True, exclude_none=True, mode="json")

    async def call(self, name: str, args: dict) -> dict:
        try:
            res = await asyncio.wait_for(self._session.call_tool(name, args), timeout=_CALL_TIMEOUT_SECONDS)
        except TimeoutError as exc:
            raise RuntimeError(f"genie MCP tool {name} didn't reply within {_CALL_TIMEOUT_SECONDS}s") from exc
        parts = [c.text for c in (res.content or []) if getattr(c, "text", None)]
        text = "\n".join(parts)
        if getattr(res, "is_error", False):
            raise RuntimeError(f"genie MCP tool {name} returned an error: {text or '(no detail)'}")
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return {"text": text}
        return parsed if isinstance(parsed, dict) else {"text": text}


_UI_EXTENSION = {"io.modelcontextprotocol/ui": {"mimeTypes": ["text/html;profile=mcp-app"]}}


@asynccontextmanager
async def session(ui: bool = False):
    """Open an authenticated Genie One MCP session. Usage:

        async with genie_client.session() as gc:
            out = await gc.call("genie_ask", {"question": "..."})

    `ui=True` declares MCP Apps support at initialize; the server then offers
    `view_ask` (+ the app-only `view_*` tools) and the `ui://` resource.
    """
    token = await _token()
    http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=90)
    async with http, streamable_http_client(settings.genie_mcp_url, http_client=http) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write, extensions=_UI_EXTENSION if ui else None) as s:
            await s.initialize()
            yield _Caller(s)


def _dig(obj: Any, *keys: str) -> Any:
    """First present, non-None key (shallow) across a list of candidate names —
    a small hedge against not knowing the server's exact field names."""
    if not isinstance(obj, dict):
        return None
    for k in keys:
        if obj.get(k) is not None:
            return obj[k]
    return None


def _extract_text(payload: dict) -> str:
    return str(_dig(payload, "answer", "text", "content", "message") or "")


def _extract_sources(payload: dict) -> list[dict]:
    raw = _dig(payload, "sources", "links", "citations") or []
    out: list[dict] = []
    for s in raw if isinstance(raw, list) else []:
        if isinstance(s, str):
            out.append({"url": s})
        elif isinstance(s, dict):
            url = s.get("url") or s.get("link") or s.get("href")
            if url:
                out.append({"title": s.get("title") or s.get("name"), "url": url})
    return out


def _extract_table(payload: dict) -> dict | None:
    """Best-effort pull of a {columns, rows} table out of a Genie payload,
    tolerant of a few plausible shapes (schema+data_array, columns+rows,
    nested under "result") since the exact field names aren't published."""
    columns = _dig(payload, "columns", "column_names")
    rows = _dig(payload, "rows", "data_array", "data")
    if columns is None or rows is None:
        nested = _dig(payload, "result", "query_result")
        if isinstance(nested, dict):
            columns = columns or _dig(nested, "columns", "column_names")
            rows = rows or _dig(nested, "rows", "data_array", "data")
        schema = _dig(payload, "schema", "manifest")
        if columns is None and isinstance(schema, dict):
            cols = schema.get("columns")
            if isinstance(cols, list):
                columns = [c.get("name", str(i)) if isinstance(c, dict) else str(c) for i, c in enumerate(cols)]
    if not isinstance(columns, list) or not isinstance(rows, list):
        return None
    return {"columns": [str(c) for c in columns], "rows": rows}


_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_ID_RE = re.compile(r"`(conversation_id|response_id)`\s*:\s*`([^`]+)`")
_STATUS_RE = re.compile(r"\*\*Status:\*\*\s*([A-Za-z_]+)\s*\n*")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")


def _parse_markdown_turn(raw: str) -> dict:
    """Parse the real `genie_ask`/`genie_poll_response` shape: markdown prose +
    a `**Status:**` line + a trailing HTML comment holding the ids. Comments
    are mined for ids then dropped entirely from the displayed text — their
    contents are untrusted metadata, not instructions to follow (one observed
    comment tried to direct an LLM caller's reply formatting)."""
    comments = "\n".join(_COMMENT_RE.findall(raw))
    ids = dict(_ID_RE.findall(comments))
    body = _COMMENT_RE.sub("", raw)
    status = ""
    m = _STATUS_RE.search(body)
    if m:
        status = m.group(1).lower()
        body = _STATUS_RE.sub("", body, count=1)
    sources = [{"title": title, "url": url} for title, url in _MD_LINK_RE.findall(body)]
    body = _MD_LINK_RE.sub("", body).strip()
    return {
        "conversation_id": ids.get("conversation_id"),
        "response_id": ids.get("response_id"),
        "status": status,
        "text": body,
        "sources": sources,
        "table": None,
    }


def _parse_turn(payload: dict) -> dict:
    """Normalize one `_Caller.call()` result (either the markdown-text shape
    above, or a genuine JSON dict) into {conversation_id, response_id, status,
    text, sources, table}."""
    if set(payload.keys()) <= {"text"}:
        return _parse_markdown_turn(str(payload.get("text") or ""))
    return {
        "conversation_id": _dig(payload, "conversation_id"),
        "response_id": _dig(payload, "response_id"),
        "status": str(_dig(payload, "status") or "").lower(),
        "text": _extract_text(payload),
        "sources": _extract_sources(payload),
        "table": _extract_table(payload),
    }


async def ask_and_wait(
    question: str,
    conversation_id: str | None = None,
    *,
    poll_interval: float = _POLL_INTERVAL_SECONDS,
    timeout: float = _POLL_TIMEOUT_SECONDS,
) -> dict:
    """Ask Genie One a question (optionally continuing `conversation_id`) and
    poll until the turn reaches a terminal status or `timeout` elapses.
    Returns conversation_id, response_id, status, text, sources, table (or
    None), and raw (the final poll payload — kept for debugging)."""
    async with session() as gc:
        args: dict[str, Any] = {"question": question}
        if conversation_id:
            args["conversation_id"] = conversation_id
        raw = await gc.call("genie_ask", args)
        turn = _parse_turn(raw)
        conv_id = turn["conversation_id"] or conversation_id
        resp_id = turn["response_id"]
        status = turn["status"]
        if not conv_id or not resp_id:
            raise RuntimeError(f"genie_ask returned no conversation/response id: {raw!r}")

        # Real wall-clock time, not poll_interval * iterations — a slow
        # genie_poll_response call must count against the budget too, or a
        # handful of slow-but-not-hung calls could run well past `timeout`.
        start = time.monotonic()
        while status not in _TERMINAL_STATUSES and (time.monotonic() - start) < timeout:
            await asyncio.sleep(poll_interval)
            raw = await gc.call("genie_poll_response", {"conversation_id": conv_id, "response_id": resp_id})
            turn = _parse_turn(raw)
            status = turn["status"] or status

        table = turn["table"]
        if table is None:
            # Only a turn that ran a query has anything to fetch here — a miss
            # just means no table, never fatal. (Only applies to the JSON-dict
            # path — the markdown-text shape has no attachment id to find.)
            qid = _dig(raw, "attachment_id", "query_id", "statement_id")
            if qid:
                try:
                    qres = await gc.call(
                        "genie_get_query_result",
                        {"conversation_id": conv_id, "response_id": resp_id, "attachment_id": qid},
                    )
                    table = _extract_table(qres)
                except Exception:  # noqa: BLE001 — best-effort only
                    log.debug("genie_get_query_result failed for %s/%s", conv_id, resp_id, exc_info=True)

        elapsed = time.monotonic() - start
        if status not in _TERMINAL_STATUSES:
            log.warning("genie turn %s/%s still %r after %.0fs", conv_id, resp_id, status, elapsed)

        log.debug("genie poll payload for %s/%s: %r", conv_id, resp_id, raw)
        return {
            "conversation_id": conv_id,
            "response_id": resp_id,
            "status": status or "unknown",
            "text": turn["text"],
            "sources": turn["sources"],
            "table": table,
            "raw": raw,
        }


# ── MCP App (interactive view) ─────────────────────────────────────────────
# With MCP Apps support declared, the server returns an interactive view
# instead of markdown: `view_ask` starts a turn, and the view (an HTML page at
# `ui://genie/mcp-app.html`, rendered by the frontend in a sandboxed iframe)
# polls/fetches through the app-only `view_*` tools, proxied via view_call().
_APP_URI = "ui://genie/mcp-app.html"
# Tools the iframe may invoke. Anything else is refused — the view is
# third-party-authored HTML, so it only gets the tools meant for it.
_VIEW_TOOLS = {"view_ask", "view_poll_response", "view_fetch_query_results", "view_respond_approval"}

_app_cache: dict | None = None


def _csp_meta(csp: dict) -> str:
    """CSP for the iframe document, built from the resource's declared domains
    (MCP Apps default: everything closed except what the view asks for)."""
    res = " ".join(csp.get("resourceDomains") or [])
    # The chart code fetches its visualization manifest from the asset CDN
    # (a resourceDomain) with fetch(), which counts as connect-src.
    conn = " ".join([*(csp.get("connectDomains") or []), *(csp.get("resourceDomains") or [])]) or "'none'"
    frames = " ".join(csp.get("frameDomains") or []) or "'none'"
    policy = (
        "default-src 'none'; "
        f"script-src 'unsafe-inline' 'unsafe-eval' {res}; "
        f"style-src 'unsafe-inline' {res}; "
        f"img-src data: blob: {res}; font-src data: {res}; "
        f"connect-src {conn}; frame-src {frames}; base-uri 'none'; form-action 'none'"
    )
    return f'<meta http-equiv="Content-Security-Policy" content="{policy}">'


# The iframe is sandboxed without allow-same-origin (opaque origin), where
# touching window.localStorage/sessionStorage throws SecurityError — and the
# view's chart code does. Give it in-memory stand-ins instead of loosening the
# sandbox; runs before any of the view's own scripts.
_STORAGE_SHIM = (
    "<script>(function(){function m(){var d={};return{getItem:function(k){return k in d?d[k]:null},"
    "setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},"
    "key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}"
    "['localStorage','sessionStorage'].forEach(function(n){try{window[n]}catch(e){"
    "Object.defineProperty(window,n,{value:m(),configurable:true})}})})()</script>"
)


async def app_resource() -> dict:
    """The view's HTML (with a CSP <meta> injected), fetched once per process."""
    global _app_cache
    if _app_cache:
        return _app_cache
    async with session(ui=True) as gc:
        res = await gc._session.read_resource(_APP_URI)
    content = next((c for c in res.contents if getattr(c, "text", None)), None)
    if content is None:
        raise RuntimeError("genie MCP app resource had no HTML content")
    csp = ((content.meta or {}).get("ui") or {}).get("csp") or {}
    html = content.text
    meta = _csp_meta(csp) + _STORAGE_SHIM
    html = html.replace("<head>", f"<head>{meta}", 1) if "<head>" in html else meta + html
    _app_cache = {"html": html}
    return _app_cache


async def view_call(name: str, args: dict) -> dict:
    """Proxy one tool call from the MCP App iframe to the server."""
    if name not in _VIEW_TOOLS:
        raise RuntimeError(f"tool {name!r} isn't available to the Genie view")
    async with session(ui=True) as gc:
        return await gc.call_raw(name, args, timeout=60)
