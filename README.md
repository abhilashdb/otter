# 🦦 Otter

A private, local-first **personal work OS** — tasks, notes, prioritisation, reminders,
a ⌘K search palette, and an extensible set of **tools** (sub-pages) you add over time.
Runs locally on macOS now; designed to port cleanly to **Databricks Apps + Lakebase**.

## Architecture

Postgres everywhere, local-first via **Electric + PGlite** — so the schema and SQL
dialect are identical on your Mac and on Lakebase, and the port is a re-point, not a rewrite.

```
UI write ──optimistic──▶ PGlite (browser)         reads: UI ◀── live query ── PGlite
   │                                                                   ▲
   └─ POST/PATCH ─▶ FastAPI ─▶ Postgres (source) ── WAL ─▶ Electric ───┘  (shape stream → PGlite)
                       └─ returns txid ─▶ client awaits it in the stream, drops optimistic copy
```

- **Frontend**: React + Vite + TypeScript + Tailwind (`frontend/`).
- **Backend**: FastAPI, `uv`-managed (`backend/`) — owns writes, quick-capture, Google Tasks import, Electric shape auth; serves the built frontend in production.
- **Local data**: PGlite in the browser, hydrated by the **Electric** sync service from a **local Postgres** (source of truth), both via `docker compose`.
- **Reads** are client-side from PGlite (instant, offline-capable). **Writes** go through FastAPI.

## Prerequisites

- A container runtime (currently **OrbStack**) — runs Postgres + Electric. The
  `docker-compose.yml` is runtime-agnostic (Colima / Podman / Docker Desktop all work).
- **Node** 20+ / npm, **[uv](https://docs.astral.sh/uv/)**, and macOS.

## Run

```bash
cp .env.example .env          # first time
scripts/dev.sh                # boots Postgres + Electric, then backend + frontend
```

- Frontend: http://localhost:5173
- Backend API + health: http://localhost:8000/api/health
- Electric shape API: http://localhost:3000
- Postgres: `localhost:54321` (db/user/pass: `otter`/`otter`/`otter`)

Stop the containers with `docker compose down` (add `-v` to also wipe the data volume).

## Layout

```
backend/        FastAPI app (app/), migrations (alembic), pyproject (uv)
frontend/       React + Vite + Tailwind; design tokens in src/styles/tokens.css
macos/          quick-capture helper + Shortcut recipe (M4)
scripts/dev.sh  one-command local stack
docker-compose.yml   Postgres (wal_level=logical) + Electric
```

## Troubleshooting

### New table syncs empty (rows in Postgres, but PGlite/UI shows nothing)

Electric snapshots a shape the first time it's requested and caches it. If a table
is added to the Electric publication **after** rows already exist, and Electric had
already cached an (empty) snapshot at an earlier txid, those pre-existing rows fall
into a gap: the cached snapshot is too old to contain them, and they never came
through the replication log because the table wasn't published when they were
written. The shape then stays empty forever.

Symptom: `curl "http://localhost:3000/v1/shape?table=<t>&offset=-1"` returns only a
`snapshot-end` control with no rows, while the table clearly has rows in Postgres.

**Fix — force Electric to re-materialize from the current DB state.** Electric here
runs with shape deletion disabled (`DELETE /v1/shape` → 405) and has **no persistent
volume**, so its shape cache lives in the container's ephemeral filesystem. Recreate
the container (not just `restart`, which keeps the cache):

```
docker compose up -d --force-recreate electric
```

It re-snapshots every shape from Postgres at the current txid. Then refresh the
browser — PGlite reconnects, gets a 409 for its stale shape handle, and re-syncs.

**Prevention:** whenever you add a new table to the publication, `--force-recreate`
Electric afterward (a plain `restart` is not enough to pick up pre-existing rows).

## Porting to Databricks Apps + Lakebase (later)

- **App**: `app.yaml` runs `uvicorn app.main:app`; FastAPI serves the built React bundle (one process).
- **DB**: point `DATABASE_URL` at Lakebase; run Alembic migrations; one-time `pg_dump`/restore from local Postgres.
- **Electric**: run it against Lakebase (needs confirming Lakebase exposes outbound logical
  replication — Neon-based, likely yes). If unavailable, the hosted app can query Lakebase
  directly server-side and skip PGlite — same React/FastAPI code supports both.

## Roadmap

- **M0** ✅ scaffold + local stack (Postgres + Electric verified)
- **M1** ✅ core local-first tasks (tasks schema + migration, Electric shape, PGlite + optimistic add/toggle/delete, Tasks UI)
- **M2** ✅ organize by Area → Project (typed areas), browsable **Overview** map with live counts, editable priority + due dates, task filtering/grouping
- **M2c** ✅ Kanban board, task drawer w/ notes (edit + clickable links), SFDC links, per-customer colors + Internal/Personal icons, kind filter, in-app confirm dialog, cursor-following otter on all pages
- **M3** ✅ ⌘K command palette (search tasks/areas/projects/tools, quick-create) + tools architecture (`src/tools/registry.ts`, `/tools`); Overview reorganized with a **Focus** (overdue + due today) at top and area management at the bottom
- **M5** ✅ Google Tasks import (pivoted from calendar sync): OAuth connect on **Settings**, imports open tasks (To-do→todo, In-progress→doing, completed skipped), pushes completion status back to Google, and **pulls title/due/notes back from Google when they change upstream** (`gtask_updated` marker gates the pull so local edits aren't clobbered). Backend-only `google_account` + `gtask_links` tables (not replicated to the browser); needs your own Google OAuth client — see `.env.example`.
- **Suggestions** ✅ task suggestions from **email + calendar** via **Databricks FMAPI** (AI Gateway Responses API, token minted from your Databricks CLI login — no PAT). Meeting-prep + actionable-email detection, and the LLM files each proposed task into the best-matching **area + optional project**. Review inbox at `/suggestions` (accept → real task filed & linked; dismiss → remembered). Reuses the Google connection with added `gmail.readonly` + `calendar.readonly` scopes (**Reconnect** in Settings). Slack (via the Databricks Slack MCP) is the next source.
- **M4** ✅ quick capture: `POST /api/quick-capture` (server-generated id, title-only) + `scripts/capture.sh` CLI; macOS Shortcut hotkey recipe on the **Settings** page. New tasks land unfiled and stream in via Electric.
- **M2b** ✅ Today / agenda view (`/today`): overdue + due-today + next-7-days grouped by day, with complete/reschedule (one-tap "→ Today", any-date picker) inline; ambient reminder **badge** on the Today nav item (overdue + due-today count).
- **Tool: Reserved PT estimator** ✅ (`src/tools/ptEstimator/`) sizes FMAPI reserved provisioned throughput against real usage vs pay-per-token: model rate cards (1-day / 1-week / 1-month / 3-month MU→DBU rates), uploaded usage datasets, saved simulations, weekday-vs-weekend utilization, printable report. Tables replicate via Electric.
- **Tool: Genie** ✅ (`src/tools/genie/`) natural-language Q&A over Unity Catalog data via the Databricks **Genie One MCP App**: the backend proxies the MCP server (`backend/app/genie_client.py`) and the frontend hosts Databricks' interactive view in a sandboxed iframe (`GenieView.tsx`), so thinking steps / SQL / charts render collapsed like the Databricks UI. Past conversations are listed and reopenable (only ids + questions are stored; answers are re-fetched from Databricks). Needs a separate CLI login — see the Genie block in `.env.example`.
- **Backups** ✅ scheduled gzipped-JSON snapshots of all app tables to `BACKUP_DIR` (point Google Drive for Desktop at it); OAuth tokens are excluded.
- **M6** design polish (full Wama pass, dark mode, empty states)
