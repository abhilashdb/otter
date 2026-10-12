import * as api from '../lib/api'
import { getDb } from './pglite'

export interface AreaRow {
  id: string
  name: string
  kind: string
  color: string | null
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** Area kinds and how they're grouped/labeled in the Overview. Kept deliberately
 *  few to minimize decision overhead. */
export const AREA_KINDS = [
  { kind: 'customer', label: 'Accounts' },
  { kind: 'internal', label: 'Internal' },
  { kind: 'personal', label: 'Personal' },
] as const

export async function addArea(input: { name: string; kind?: string }): Promise<string> {
  const db = await getDb()
  const id = crypto.randomUUID()
  const kind = input.kind ?? 'other'
  const sortOrder = Date.now()
  await db.query(`INSERT INTO areas (id, name, kind, sort_order) VALUES ($1, $2, $3, $4)`, [
    id,
    input.name,
    kind,
    sortOrder,
  ])
  await api.apiCreateArea({ id, name: input.name, kind, sort_order: sortOrder })
  return id
}

export async function renameArea(id: string, name: string) {
  const db = await getDb()
  await db.query(`UPDATE areas SET name = $2, updated_at = now() WHERE id = $1`, [id, name])
  await api.apiUpdateArea(id, { name })
}

export async function setAreaKind(id: string, kind: string) {
  const db = await getDb()
  await db.query(`UPDATE areas SET kind = $2, updated_at = now() WHERE id = $1`, [id, kind])
  await api.apiUpdateArea(id, { kind })
}

export async function setAreaColor(id: string, color: string | null) {
  const db = await getDb()
  await db.query(`UPDATE areas SET color = $2, updated_at = now() WHERE id = $1`, [id, color])
  await api.apiUpdateArea(id, { color })
}

/** Delete an area and its projects, re-filing its tasks to Unfiled (never orphan). */
export async function removeArea(id: string) {
  const db = await getDb()
  const projs = (
    await db.query<{ id: string }>(
      `SELECT id FROM projects WHERE area_id = $1 AND deleted_at IS NULL`,
      [id],
    )
  ).rows
  const tsks = (
    await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE area_id = $1 AND deleted_at IS NULL`,
      [id],
    )
  ).rows

  // Optimistic local cascade.
  await db.query(
    `UPDATE tasks SET area_id = NULL, project_id = NULL, updated_at = now() WHERE area_id = $1`,
    [id],
  )
  await db.query(`UPDATE projects SET deleted_at = now(), updated_at = now() WHERE area_id = $1`, [id])
  await db.query(`UPDATE areas SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])

  // Persist authoritatively.
  await Promise.all([
    ...tsks.map((t) => api.apiUpdateTask(t.id, { area_id: null, project_id: null })),
    ...projs.map((p) => api.apiDeleteProject(p.id)),
    api.apiDeleteArea(id),
  ])
}
