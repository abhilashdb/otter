"""Health of the Databricks CLI logins Otter mints tokens from.

Surfaced in Settings so the user knows when to re-run scripts/db-auth.sh — the
OAuth sessions behind these profiles expire (~daily, per SSO policy). Read-only
and non-interactive: it only checks/refreshes access tokens via
`databricks auth token` (which never opens a browser), never `auth login`.
"""
from __future__ import annotations

import asyncio
import re
import subprocess

from fastapi import APIRouter

from ..config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _check(args: list[str]) -> tuple[bool, str]:
    """Run `databricks auth token <args>`; (ok, detail-on-failure)."""
    try:
        subprocess.run(
            ["databricks", "auth", "token", *args],
            capture_output=True,
            timeout=30,
            check=True,
        )
        return True, ""
    except FileNotFoundError:
        return False, "databricks CLI not found on PATH"
    except subprocess.TimeoutExpired:
        return False, "timed out"
    except subprocess.CalledProcessError as exc:
        msg = (exc.stderr or b"").decode(errors="replace").strip()
        return False, (msg or "session expired — re-login")[:280]


def _mlflow_profile() -> str | None:
    """Profile in a 'databricks://<profile>' MLflow tracking URI, if any."""
    m = re.match(r"databricks://([^/]+)", settings.mlflow_tracking_uri or "")
    return m.group(1) if m else None


def _login_hint(profile: str | None, host: str | None) -> str:
    if profile:
        return f"databricks auth login -p {profile}"
    if host:
        return f"databricks auth login --host {host}"
    return "databricks auth login"


@router.get("/databricks")
async def databricks_auth() -> dict:
    """Per-dependency Databricks auth health for the Settings card."""
    deps: list[dict] = []

    # 1) LLM / FMAPI (+ Slack) — minted from the workspace host, or a static PAT.
    if settings.databricks_token:
        deps.append(
            {
                "name": "LLM / FMAPI + Slack",
                "workspace": settings.databricks_host,
                "ok": True,
                "detail": "using a static token",
                "hint": None,
            }
        )
    else:
        profile = settings.databricks_profile or None
        args = ["-p", profile] if profile else ["--host", settings.databricks_host]
        ok, detail = await asyncio.to_thread(_check, args)
        deps.append(
            {
                "name": "LLM / FMAPI + Slack",
                "workspace": settings.databricks_host,
                "ok": ok,
                "detail": detail,
                "hint": None if ok else _login_hint(profile, settings.databricks_host),
            }
        )

    # 2) MLflow tracing — only when an experiment is configured.
    if settings.mlflow_configured:
        profile = _mlflow_profile()
        if profile:
            ok, detail = await asyncio.to_thread(_check, ["-p", profile])
        else:
            ok, detail = True, "uses default Databricks auth"
        deps.append(
            {
                "name": "MLflow tracing",
                "workspace": settings.mlflow_tracking_uri,
                "ok": ok,
                "detail": detail,
                "hint": None if ok else _login_hint(profile, None),
            }
        )

    # 3) Genie One MCP — a separate workspace/profile from FMAPI+Slack above.
    if settings.genie_configured:
        if settings.genie_token:
            deps.append(
                {
                    "name": "Genie",
                    "workspace": settings.genie_host,
                    "ok": True,
                    "detail": "using a static token",
                    "hint": None,
                }
            )
        else:
            profile = settings.genie_profile or None
            args = ["-p", profile] if profile else ["--host", settings.genie_host]
            ok, detail = await asyncio.to_thread(_check, args)
            deps.append(
                {
                    "name": "Genie",
                    "workspace": settings.genie_host,
                    "ok": ok,
                    "detail": detail,
                    "hint": None if ok else _login_hint(profile, settings.genie_host),
                }
            )

    return {"ok": all(d["ok"] for d in deps), "deps": deps}
