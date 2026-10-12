"""Thin async client for Google OAuth + the Google Tasks REST API.

Uses httpx directly (no google-api-python-client) to stay light and portable.
All calls take a bearer access token; token lifecycle lives in gsync.py.
"""
from __future__ import annotations

from urllib.parse import urlencode

import httpx

from .config import settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
TASKS_BASE = "https://tasks.googleapis.com/tasks/v1"
GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1"
CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"

# openid+email so we can show which account is connected; tasks (read-write) so we
# can both import tasks and push status changes back; gmail + calendar (read-only)
# so the suggestion engine can scan mail and meetings for actionable tasks.
SCOPES = (
    "openid email"
    " https://www.googleapis.com/auth/tasks"
    " https://www.googleapis.com/auth/gmail.readonly"
    " https://www.googleapis.com/auth/calendar.readonly"
)

# Scopes beyond the base Tasks integration that the suggestion engine needs; if a
# connected account is missing any of these it must re-consent.
SUGGEST_SCOPES = (
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
)


def authorize_url(state: str) -> str:
    """The Google consent URL to redirect the browser to."""
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        # offline + consent so we reliably get a refresh_token.
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


async def exchange_code(code: str) -> dict:
    """Trade an authorization code for access + refresh tokens."""
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        res.raise_for_status()
        return res.json()


async def refresh_token(refresh: str) -> dict:
    """Get a fresh access token from a stored refresh token."""
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(
            TOKEN_URL,
            data={
                "refresh_token": refresh,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "grant_type": "refresh_token",
            },
        )
        res.raise_for_status()
        return res.json()


async def userinfo(access_token: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(USERINFO_URL, headers=_auth(access_token))
        res.raise_for_status()
        return res.json()


async def list_tasklists(access_token: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(
            f"{TASKS_BASE}/users/@me/lists",
            headers=_auth(access_token),
            params={"maxResults": 100},
        )
        res.raise_for_status()
        return res.json().get("items", []) or []


async def list_tasks(access_token: str, tasklist_id: str, *, show_completed: bool = False) -> list[dict]:
    """All tasks in a list, following pagination. Excludes completed by default."""
    out: list[dict] = []
    page_token: str | None = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params: dict = {
                "maxResults": 100,
                "showCompleted": str(show_completed).lower(),
                "showHidden": "false",
            }
            if page_token:
                params["pageToken"] = page_token
            res = await client.get(
                f"{TASKS_BASE}/lists/{tasklist_id}/tasks",
                headers=_auth(access_token),
                params=params,
            )
            res.raise_for_status()
            body = res.json()
            out.extend(body.get("items", []) or [])
            page_token = body.get("nextPageToken")
            if not page_token:
                break
    return out


async def set_task_status(access_token: str, tasklist_id: str, task_id: str, *, completed: bool) -> dict:
    """Mark a Google task completed or reopen it (needsAction)."""
    payload: dict = {"status": "completed" if completed else "needsAction"}
    # Reopening must clear the completed timestamp, or Google keeps it completed.
    if not completed:
        payload["completed"] = None
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.patch(
            f"{TASKS_BASE}/lists/{tasklist_id}/tasks/{task_id}",
            headers=_auth(access_token),
            json=payload,
        )
        res.raise_for_status()
        return res.json()


# ── Calendar (read-only) ────────────────────────────────────────────────────
async def list_calendar_events(
    access_token: str,
    time_min: str,
    time_max: str,
    *,
    updated_min: str | None = None,
    max_results: int = 50,
) -> list[dict]:
    """Timed events on the primary calendar in [time_min, time_max) (RFC3339),
    recurring events expanded to instances and ordered by start. `updated_min`
    (RFC3339) makes the fetch incremental — only events changed since then."""
    params: dict = {
        "timeMin": time_min,
        "timeMax": time_max,
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": max_results,
    }
    if updated_min:
        params["updatedMin"] = updated_min
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            f"{CALENDAR_BASE}/calendars/primary/events",
            headers=_auth(access_token),
            params=params,
        )
        res.raise_for_status()
        return res.json().get("items", []) or []


# ── Gmail (read-only) ─────────────────────────────────────────────────────────
async def list_gmail_message_ids(
    access_token: str, query: str, *, max_results: int = 25
) -> list[str]:
    """Message ids matching a Gmail search query (e.g. 'in:inbox after:<epoch>')."""
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            f"{GMAIL_BASE}/users/me/messages",
            headers=_auth(access_token),
            params={"q": query, "maxResults": max_results},
        )
        res.raise_for_status()
        return [m["id"] for m in (res.json().get("messages") or []) if m.get("id")]


async def get_gmail_message(access_token: str, message_id: str) -> dict:
    """A message's key headers + snippet (metadata format — no body download)."""
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            f"{GMAIL_BASE}/users/me/messages/{message_id}",
            headers=_auth(access_token),
            params={
                "format": "metadata",
                "metadataHeaders": ["From", "Subject", "Date", "List-Id"],
            },
        )
        res.raise_for_status()
        return res.json()


def _auth(access_token: str) -> dict:
    return {"Authorization": f"Bearer {access_token}"}
