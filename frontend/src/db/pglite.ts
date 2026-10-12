/**
 * Local-first database: PGlite (Postgres in the browser, persisted to IndexedDB),
 * hydrated from the Electric sync service. Reads are instant/offline from here;
 * writes go through the FastAPI API (see lib/api.ts) and stream back via Electric.
 *
 * The local schema mirrors the server's Postgres schema (see backend migrations).
 */
import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'

const ELECTRIC_URL = import.meta.env.VITE_ELECTRIC_URL ?? 'http://localhost:3000'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'p2',
    due_at TIMESTAMPTZ,
    area_id UUID,
    project_id UUID,
    project TEXT,
    sfdc_url TEXT,
    sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
    gcal_event_id TEXT,
    gcal_etag TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ
  );
  -- migrate older local databases created before M2
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS area_id UUID;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

  CREATE TABLE IF NOT EXISTS areas (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    color TEXT,
    sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY,
    area_id UUID,
    name TEXT NOT NULL,
    sfdc_url TEXT,
    sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS links (
    id UUID PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    detail TEXT,
    link_url TEXT,
    suggested_due TIMESTAMPTZ,
    suggested_area_id UUID,
    suggested_project_id UUID,
    status TEXT NOT NULL DEFAULT 'pending',
    created_task_id UUID,
    source_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS pt_models (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '',
    mu_to_dbu_1mo DOUBLE PRECISION NOT NULL DEFAULT 0,
    mu_to_dbu_3mo DOUBLE PRECISION NOT NULL DEFAULT 0,
    mu_to_dbu_1d DOUBLE PRECISION NOT NULL DEFAULT 0,
    mu_to_dbu_1w DOUBLE PRECISION NOT NULL DEFAULT 0,
    dbu_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
    std_input_dbu DOUBLE PRECISION NOT NULL DEFAULT 0,
    std_output_dbu DOUBLE PRECISION NOT NULL DEFAULT 0,
    std_cache_dbu DOUBLE PRECISION NOT NULL DEFAULT 0,
    pri_input_dbu DOUBLE PRECISION NOT NULL DEFAULT 0,
    pri_output_dbu DOUBLE PRECISION NOT NULL DEFAULT 0,
    pri_cache_dbu DOUBLE PRECISION NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS pt_usage (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    granularity TEXT NOT NULL DEFAULT 'tpm',
    data TEXT NOT NULL DEFAULT '[]',
    row_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS pt_scenarios (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    model_id UUID,
    usage_id UUID,
    blend_usage_id UUID,
    blend_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    growth_weekday_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    growth_weekend_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    dbu_rate_discounted DOUBLE PRECISION,
    rpm DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_input_tokens DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_output_tokens DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    mus DOUBLE PRECISION NOT NULL DEFAULT 0,
    baseline_mus DOUBLE PRECISION,
    tpm_cap DOUBLE PRECISION NOT NULL DEFAULT 20000000,
    ppt_tier TEXT NOT NULL DEFAULT 'standard',
    reservation_term TEXT NOT NULL DEFAULT '1mo',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS ext_tools (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
    embed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  );

  -- migrate older local databases
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sfdc_url TEXT;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS sfdc_url TEXT;
  ALTER TABLE ext_tools ADD COLUMN IF NOT EXISTS embed BOOLEAN NOT NULL DEFAULT false;
  -- pt_models gained 1mo/3mo reservation rates (was a single mu_to_dbu); the old
  -- column lingers harmlessly on pre-existing local dbs and Electric re-syncs the
  -- new ones. A "Re-sync local data" gives a clean rebuild.
  ALTER TABLE pt_models ADD COLUMN IF NOT EXISTS mu_to_dbu_1mo DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE pt_models ADD COLUMN IF NOT EXISTS mu_to_dbu_3mo DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE pt_models ADD COLUMN IF NOT EXISTS mu_to_dbu_1d DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE pt_models ADD COLUMN IF NOT EXISTS mu_to_dbu_1w DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE pt_scenarios ADD COLUMN IF NOT EXISTS reservation_term TEXT NOT NULL DEFAULT '1mo';
  -- Traffic-migration blend (add-on dataset + %); older local dbs get them here.
  ALTER TABLE pt_scenarios ADD COLUMN IF NOT EXISTS blend_usage_id UUID;
  ALTER TABLE pt_scenarios ADD COLUMN IF NOT EXISTS blend_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
  -- Organic-growth uplift (per-minute, by day type); older local dbs get them here.
  ALTER TABLE pt_scenarios ADD COLUMN IF NOT EXISTS growth_weekday_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE pt_scenarios ADD COLUMN IF NOT EXISTS growth_weekend_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
`

async function syncTable(pg: PGlite & { electric: any }, table: string) {
  await pg.electric.syncShapeToTable({
    shape: { url: `${ELECTRIC_URL}/v1/shape`, params: { table } },
    table,
    primaryKey: ['id'],
    shapeKey: table,
  })
}

async function create() {
  const pg = await PGlite.create({
    dataDir: 'idb://otter',
    extensions: { live, electric: electricSync() },
  })
  await pg.exec(SCHEMA)
  // Read-path sync: Electric streams each table's rows into the local copy,
  // upserting by primary key (so it reconciles our optimistic local writes).
  await syncTable(pg as never, 'tasks')
  await syncTable(pg as never, 'areas')
  await syncTable(pg as never, 'projects')
  await syncTable(pg as never, 'notes')
  await syncTable(pg as never, 'links')
  await syncTable(pg as never, 'suggestions')
  await syncTable(pg as never, 'pt_models')
  await syncTable(pg as never, 'pt_usage')
  await syncTable(pg as never, 'pt_scenarios')
  await syncTable(pg as never, 'ext_tools')
  // Handy for debugging from the console in dev: `await __otterDb.query(...)`.
  if (import.meta.env.DEV) (window as unknown as { __otterDb: unknown }).__otterDb = pg
  return pg
}

/**
 * Wipe the local database and reload so Electric re-hydrates every table from
 * scratch. Safe: all data is server-authoritative (writes go through the API),
 * so nothing local-only is lost. Use when the local sync state drifts out of
 * step with the server — e.g. after the Electric container is restarted, which
 * changes shape handles and can strand a resumed subscription.
 */
export async function resetLocalDb() {
  try {
    const pg = await getDb()
    await pg.close()
  } catch {
    /* already closed / failed to open — proceed to delete anyway */
  }
  const drop = (name: string) =>
    new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  try {
    const dbs = (await indexedDB.databases?.()) ?? []
    await Promise.all(dbs.map((d) => (d.name ? drop(d.name) : Promise.resolve())))
  } catch {
    /* indexedDB.databases() unsupported — reload still helps */
  }
  location.reload()
}

let dbPromise: ReturnType<typeof create> | null = null

/** Singleton so React StrictMode's double-mount doesn't create two databases. */
export function getDb() {
  if (!dbPromise) dbPromise = create()
  return dbPromise
}

export type Db = Awaited<ReturnType<typeof create>>
