"""Databricks FMAPI client — the intelligence behind task suggestions.

Talks to the workspace AI Gateway, which exposes an OpenAI *Responses* API at
`{host}/ai-gateway/mlflow/v1/responses`. The bearer token is minted on demand
from the local Databricks CLI login for the configured host (so there's no PAT
to store), cached until just before it expires. Set `DATABRICKS_TOKEN` to
override with a static token for headless/prod deploys.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
from datetime import UTC, datetime, timedelta

import httpx

from .config import settings

# Cached CLI-minted token: (token, expiry). Guarded so we don't spawn the CLI
# on every call.
_token_cache: tuple[str, datetime] | None = None
_token_lock = asyncio.Lock()


def _mint_token_sync() -> tuple[str, datetime]:
    """Run the Databricks CLI to mint an OAuth token for the workspace."""
    cmd = ["databricks", "auth", "token", "--output", "json"]
    if settings.databricks_profile:
        cmd += ["-p", settings.databricks_profile]
    else:
        cmd += ["--host", settings.databricks_host]
    out = subprocess.check_output(cmd, timeout=30, stderr=subprocess.PIPE)
    data = json.loads(out)
    token = data["access_token"]
    # Refresh a minute early; default to a short window if expiry is missing.
    expiry = datetime.now(UTC) + timedelta(minutes=10)
    raw = data.get("expiry")
    if raw:
        try:
            expiry = datetime.fromisoformat(raw) - timedelta(seconds=60)
        except ValueError:
            pass
    return token, expiry


async def _token() -> str:
    if settings.databricks_token:
        return settings.databricks_token
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


def configured() -> bool:
    return settings.llm_configured


def _extract_text(data: dict) -> str:
    """Pull the assistant's text out of a Responses-API payload."""
    if isinstance(data.get("output_text"), str) and data["output_text"].strip():
        return data["output_text"]
    chunks: list[str] = []
    for item in data.get("output", []) or []:
        for c in item.get("content", []) or []:
            if c.get("type") in ("output_text", "text") and c.get("text"):
                chunks.append(c["text"])
    return "\n".join(chunks).strip()


async def respond(system: str, user: str, *, max_output_tokens: int | None = None) -> str:
    """One-shot completion. Returns the assistant's text (may be empty)."""
    token = await _token()
    payload = {
        "model": settings.llm_model,
        "max_output_tokens": max_output_tokens or settings.llm_max_output_tokens,
        "instructions": system,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": user}]}],
    }
    url = f"{settings.databricks_host.rstrip('/')}/ai-gateway/mlflow/v1/responses"
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            url, headers={"Authorization": f"Bearer {token}"}, json=payload
        )
        res.raise_for_status()
        return _extract_text(res.json())


async def respond_via_openai(system: str, user: str, *, max_output_tokens: int | None = None) -> str:
    """Same as respond(), but through the OpenAI SDK pointed at the AI Gateway so
    MLflow's OpenAI autologging captures the call as a trace. Raises on any
    failure (missing `openai`, gateway hiccup) — callers fall back to respond()."""
    from openai import AsyncOpenAI  # lazy: optional dep, only needed with tracing

    token = await _token()
    base_url = f"{settings.databricks_host.rstrip('/')}/ai-gateway/mlflow/v1"
    client = AsyncOpenAI(api_key=token, base_url=base_url)
    resp = await client.responses.create(
        model=settings.llm_model,
        max_output_tokens=max_output_tokens or settings.llm_max_output_tokens,
        instructions=system,
        input=[{"role": "user", "content": [{"type": "input_text", "text": user}]}],
    )
    return (getattr(resp, "output_text", "") or "").strip()


def parse_json_array(text: str) -> list[dict]:
    """Tolerantly pull a JSON array out of an LLM reply (handles code fences and
    surrounding prose). Returns [] if nothing parses."""
    if not text:
        return []
    # Strip a ```json … ``` fence if present.
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```", 2)[1] if t.count("```") >= 2 else t
        if t.lstrip().startswith("json"):
            t = t.lstrip()[4:]
    start = t.find("[")
    end = t.rfind("]")
    if start == -1 or end == -1 or end < start:
        return []
    try:
        parsed = json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return []
    return [x for x in parsed if isinstance(x, dict)] if isinstance(parsed, list) else []
