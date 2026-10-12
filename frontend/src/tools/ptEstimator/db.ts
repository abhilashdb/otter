/**
 * Local-first data layer for the Reserved PT estimator. Rows sync in via Electric
 * (read from PGlite with useLiveQuery); writes go optimistically to the local DB
 * and then to the FastAPI write API, matching the pattern in src/db/areas.ts.
 */
import * as api from '../../lib/api'
import { getDb } from '../../db/pglite'

export interface PtModelRow {
  id: string
  name: string
  sku: string
  mu_to_dbu_1mo: number
  mu_to_dbu_3mo: number
  mu_to_dbu_1d: number
  mu_to_dbu_1w: number
  dbu_rate: number
  std_input_dbu: number
  std_output_dbu: number
  std_cache_dbu: number
  pri_input_dbu: number
  pri_output_dbu: number
  pri_cache_dbu: number
  notes: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface PtUsageRow {
  id: string
  name: string
  granularity: 'tpm' | 'tph'
  data: string // JSON array of UsagePoint
  row_count: number
  notes: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface PtScenarioRow {
  id: string
  name: string
  model_id: string | null
  usage_id: string | null
  blend_usage_id: string | null // add-on dataset for traffic migration (null → none)
  blend_pct: number // % of blend_usage_id's traffic added on top of the base
  growth_weekday_pct: number // organic-growth uplift on weekday buckets (per minute)
  growth_weekend_pct: number // organic-growth uplift on weekend buckets (per minute)
  dbu_rate_discounted: number | null
  rpm: number
  avg_input_tokens: number
  avg_output_tokens: number
  cache_pct: number
  mus: number
  baseline_mus: number | null
  tpm_cap: number
  ppt_tier: string
  reservation_term: string
  notes: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** A normalized usage sample. For 'tpm' datasets `total` is tokens-per-minute;
 *  for 'tph' it's total tokens in the hour. Splits are optional. */
export interface UsagePoint {
  t: number | null // epoch ms, or null when the CSV had no timestamp
  total: number
  input: number | null
  output: number | null
  cached: number | null
  rpm: number | null // requests/min in this bucket (when the CSV carried it)
  avg_input: number | null // avg input tokens/request
  avg_output: number | null // avg output tokens/request
  migrated?: number // runtime-only: migrated-in tokens in this bucket (from a blend)
}

// ── generic local-first write helpers (table names are fixed literals) ────────
async function localUpsert(table: string, row: Record<string, unknown>) {
  const db = await getDb()
  const cols = Object.keys(row)
  const values = cols.map((_, i) => `$${i + 1}`)
  const setCols = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat(['updated_at = now()', 'deleted_at = NULL'])
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values.join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${setCols.join(', ')}`,
    cols.map((c) => row[c]),
  )
}

async function localPatch(table: string, id: string, patch: Record<string, unknown>) {
  const db = await getDb()
  const cols = Object.keys(patch)
  if (cols.length === 0) return
  const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
  await db.query(`UPDATE ${table} SET ${set}, updated_at = now() WHERE id = $1`, [
    id,
    ...cols.map((c) => patch[c]),
  ])
}

async function localDelete(table: string, id: string) {
  const db = await getDb()
  await db.query(`UPDATE ${table} SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
}

// ── Models ────────────────────────────────────────────────────────────────────
export type ModelInput = Omit<
  PtModelRow,
  'id' | 'created_at' | 'updated_at' | 'deleted_at'
>

export async function saveModel(id: string, input: ModelInput): Promise<string> {
  await localUpsert('pt_models', { id, ...input })
  await api.apiPtCreateModel({ id, ...input })
  return id
}

export async function deleteModel(id: string) {
  await localDelete('pt_models', id)
  await api.apiPtDeleteModel(id)
}

// ── Usage datasets ──────────────────────────────────────────────────────────
export async function saveUsage(
  id: string,
  input: { name: string; granularity: 'tpm' | 'tph'; points: UsagePoint[]; notes?: string },
): Promise<string> {
  const row = {
    name: input.name,
    granularity: input.granularity,
    data: JSON.stringify(input.points),
    row_count: input.points.length,
    notes: input.notes ?? '',
  }
  await localUpsert('pt_usage', { id, ...row })
  await api.apiPtCreateUsage({ id, ...row })
  return id
}

export async function deleteUsage(id: string) {
  await localDelete('pt_usage', id)
  await api.apiPtDeleteUsage(id)
}

export function parseUsagePoints(row: PtUsageRow): UsagePoint[] {
  try {
    const arr = JSON.parse(row.data) as UsagePoint[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// ── Simulations (scenarios) ───────────────────────────────────────────────────
export type ScenarioInput = Omit<
  PtScenarioRow,
  'id' | 'created_at' | 'updated_at' | 'deleted_at'
>

export async function saveScenario(id: string, input: ScenarioInput): Promise<string> {
  await localUpsert('pt_scenarios', { id, ...input })
  await api.apiPtCreateScenario({ id, ...input })
  return id
}

export async function patchScenario(id: string, patch: Partial<ScenarioInput>) {
  await localPatch('pt_scenarios', id, patch)
  await api.apiPtUpdateScenario(id, patch)
}

export async function deleteScenario(id: string) {
  await localDelete('pt_scenarios', id)
  await api.apiPtDeleteScenario(id)
}
