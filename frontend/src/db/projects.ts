import * as api from '../lib/api'
import { getDb } from './pglite'

export interface ProjectRow {
  id: string
  area_id: string | null
  name: string
  sfdc_url: string | null
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export async function setProjectSfdc(id: string, url: string | null) {
  const db = await getDb()
  await db.query(`UPDATE projects SET sfdc_url = $2, updated_at = now() WHERE id = $1`, [id, url])
  await api.apiUpdateProject(id, { sfdc_url: url })
}

export async function addProject(input: {
  name: string
  areaId?: string | null
}): Promise<string> {
  const db = await getDb()
  const id = crypto.randomUUID()
  const areaId = input.areaId ?? null
  const sortOrder = Date.now()
  await db.query(`INSERT INTO projects (id, name, area_id, sort_order) VALUES ($1, $2, $3, $4)`, [
    id,
    input.name,
    areaId,
    sortOrder,
  ])
  await api.apiCreateProject({ id, name: input.name, area_id: areaId, sort_order: sortOrder })
  return id
}

export async function renameProject(id: string, name: string) {
  const db = await getDb()
  await db.query(`UPDATE projects SET name = $2, updated_at = now() WHERE id = $1`, [id, name])
  await api.apiUpdateProject(id, { name })
}

/** Delete a project, clearing it off its tasks (they keep their area). */
export async function removeProject(id: string) {
  const db = await getDb()
  const tsks = (
    await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE project_id = $1 AND deleted_at IS NULL`,
      [id],
    )
  ).rows

  await db.query(`UPDATE tasks SET project_id = NULL, updated_at = now() WHERE project_id = $1`, [id])
  await db.query(`UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])

  await Promise.all([
    ...tsks.map((t) => api.apiUpdateTask(t.id, { project_id: null })),
    api.apiDeleteProject(id),
  ])
}
