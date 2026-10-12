"""Application settings, loaded from environment / repo-root .env."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Loads the repo-root .env when running with cwd=backend (scripts/dev.sh),
    # but real environment variables always win.
    model_config = SettingsConfigDict(
        env_file="../.env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = "postgresql+asyncpg://otter:otter@localhost:54321/otter"
    electric_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:5173"
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000

    # ── Google Tasks integration (M5) ──────────────────────────────────────
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8000/api/google/oauth/callback"
    # Where to send the browser back to after the OAuth dance (the frontend).
    app_url: str = "http://localhost:5173"
    # Interval for the background pull/push loop; 0 disables it (manual sync only).
    google_sync_interval_seconds: int = 300

    # ── Task suggestions (Databricks FMAPI intelligence) ───────────────────
    # The LLM lives behind the workspace AI Gateway (OpenAI Responses API shape).
    # The token is minted at call time from the Databricks CLI login for this host
    # (`databricks auth token --host ...`); databricks_token is an optional PAT
    # override for headless/prod deploys.
    databricks_host: str = ""  # your workspace URL (set in .env)
    databricks_profile: str = ""  # optional CLI profile; blank → resolve by host
    databricks_token: str = ""  # optional explicit token; blank → resolve via CLI
    llm_model: str = "system.ai.gpt-5-6-sol"
    llm_max_output_tokens: int = 1024
    # Agentic quick-capture: after a capture lands, an agent infers its area/
    # project from the user's areas + how existing tasks are filed. It auto-files
    # when confidence ≥ this threshold; below it, the task stays unfiled and a
    # pre-filled filing suggestion goes to the inbox for the user to refine.
    capture_agent_enabled: bool = True
    capture_file_confidence: float = 0.7

    # ── MLflow tracing (Databricks) ────────────────────────────────────────
    # Traces the capture agent's LLM calls. Tracing is OFF until an experiment is
    # named — either by path (mlflow_experiment, e.g. /Users/you@…/otter-capture)
    # or by id (mlflow_experiment_id, from the experiment's connect snippet).
    # tracking_uri "databricks" reuses the CLI login / DATABRICKS_HOST+TOKEN env;
    # add a profile like "databricks://myprofile" to pin one. registry_uri is
    # optional (e.g. "databricks-uc"). Autologging captures the OpenAI SDK calls
    # the agent makes through the AI Gateway.
    mlflow_tracking_uri: str = "databricks"
    mlflow_registry_uri: str = ""
    mlflow_experiment: str = ""
    mlflow_experiment_id: str = ""

    # Background scan loop (email + calendar → suggested tasks); 0 disables it.
    suggest_scan_interval_seconds: int = 900
    suggest_calendar_lookahead_days: int = 7
    suggest_email_lookback_days: int = 3
    suggest_max_items_per_source: int = 25

    # ── Slack suggestions (via the Databricks-hosted Slack MCP) ────────────
    # Reuses the same Databricks CLI login as FMAPI (bearer minted in llm.py) —
    # no Slack app to create. Blank disables the Slack source.
    slack_mcp_url: str = ""
    suggest_slack_lookback_days: int = 3

    # ── Genie One MCP (Databricks-hosted natural-language Q&A) ─────────────
    # system.ai.genie_one_mcp is governed metastore-wide by Unity Catalog —
    # there's no Genie "space" to pick, just a workspace. It's a *different*
    # workspace than DATABRICKS_HOST above, so it mints its own CLI-login
    # token (see genie_client.py) rather than reusing llm._token().
    genie_host: str = ""  # workspace URL (set in .env)
    genie_profile: str = ""  # CLI profile for that login (set in .env)
    genie_org_id: str = ""  # the "o=" workspace id on the MCP URL
    genie_token: str = ""  # optional static PAT override; blank → use the CLI login

    # ── Backups (authoritative Postgres → local archive folder) ───────────
    # A timestamped, gzipped JSON snapshot of every app table, written to a local
    # folder. Point Google Drive for Desktop (or rclone) at BACKUP_DIR to sync the
    # archives off-machine. Guards against losing the local Postgres volume.
    # Interval 0 disables the scheduled loop (manual only).
    backup_dir: str = "../backups"  # relative to backend cwd (repo-root/backups)
    backup_interval_seconds: int = 86_400  # daily
    backup_keep: int = 14  # prune older archives beyond this many

    @property
    def backup_configured(self) -> bool:
        return bool(self.backup_dir)

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def google_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def llm_configured(self) -> bool:
        # A PAT override or a host we can mint a CLI token for both count.
        return bool(self.databricks_token or self.databricks_host)

    @property
    def slack_configured(self) -> bool:
        # Needs the MCP endpoint and a Databricks token (same one FMAPI uses).
        return bool(self.slack_mcp_url and self.llm_configured)

    @property
    def genie_mcp_url(self) -> str:
        base = f"{self.genie_host.rstrip('/')}/ai-gateway/mcp-services/system.ai.genie_one_mcp"
        return f"{base}?o={self.genie_org_id}" if self.genie_org_id else base

    @property
    def genie_configured(self) -> bool:
        return bool(self.genie_host and (self.genie_token or self.genie_profile))

    @property
    def mlflow_configured(self) -> bool:
        # Tracing is opt-in: it activates once an experiment is named (path or id).
        return bool(self.mlflow_experiment or self.mlflow_experiment_id)


settings = Settings()
