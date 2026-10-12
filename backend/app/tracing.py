"""MLflow tracing setup for the capture agent.

Tracing is entirely optional and fail-safe: if `mlflow` isn't installed or no
experiment is configured (`MLFLOW_EXPERIMENT`), everything here degrades to
no-ops so the app runs unchanged. When configured, `init_tracing()` points
MLflow at the Databricks workspace, selects the experiment, and turns on OpenAI
autologging so the agent's AI-Gateway calls are captured as spans.

Auth reuses the ambient Databricks credentials (the same CLI login that mints
FMAPI tokens); set `mlflow_tracking_uri` to "databricks://<profile>" to pin one.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import nullcontext
from typing import Any, TypeVar

from .config import settings

log = logging.getLogger("otter.tracing")

_enabled = False

F = TypeVar("F", bound=Callable[..., Any])


def init_tracing() -> None:
    """Configure MLflow + OpenAI autolog once at startup. Safe to call always."""
    global _enabled
    if not settings.mlflow_configured:
        return
    try:
        import mlflow

        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        if settings.mlflow_registry_uri:
            mlflow.set_registry_uri(settings.mlflow_registry_uri)
        # Select the experiment by id when given (from the connect snippet),
        # otherwise by path.
        if settings.mlflow_experiment_id:
            mlflow.set_experiment(experiment_id=settings.mlflow_experiment_id)
            which = f"id={settings.mlflow_experiment_id}"
        else:
            mlflow.set_experiment(settings.mlflow_experiment)
            which = settings.mlflow_experiment
        # Capture the agent's OpenAI-SDK calls (through the AI Gateway) as spans.
        try:
            mlflow.openai.autolog()
        except Exception:  # noqa: BLE001 — autolog is best-effort
            log.debug("mlflow.openai.autolog() unavailable", exc_info=True)
        _enabled = True
        log.info("MLflow tracing on → %s / %s", settings.mlflow_tracking_uri, which)
    except Exception:  # noqa: BLE001 — never let tracing setup break startup
        log.warning("MLflow tracing setup failed; continuing without it", exc_info=True)


def enabled() -> bool:
    return _enabled


def span(name: str, span_type: str = "LLM"):
    """Context manager for a manual MLflow span; yields the span (with
    .set_inputs / .set_outputs / .set_attributes) or None when tracing is off.
    Use this to record the LLM request + response even when autologging misses
    the call (e.g. the httpx fallback path)."""
    if not _enabled:
        return nullcontext()
    try:
        import mlflow

        return mlflow.start_span(name=name, span_type=span_type)
    except Exception:  # noqa: BLE001 — never let tracing break the agent
        log.debug("mlflow.start_span failed", exc_info=True)
        return nullcontext()


def trace(name: str) -> Callable[[F], F]:
    """Decorator that wraps a function in an MLflow span when tracing is on, and
    is a transparent passthrough otherwise (or if mlflow isn't installed)."""

    def decorate(fn: F) -> F:
        if not settings.mlflow_configured:
            return fn
        try:
            import mlflow

            return mlflow.trace(name=name)(fn)  # type: ignore[no-any-return]
        except Exception:  # noqa: BLE001 — fall back to the undecorated fn
            return fn

    return decorate
