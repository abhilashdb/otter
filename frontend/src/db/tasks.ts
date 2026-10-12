/**
 * Task operations: optimistic local write into PGlite (UI updates instantly via
 * live queries) + the authoritative API call. Electric streams the server row
 * back and upserts by id, reconciling the optimistic copy.
 */
import * as api from '../lib/api'
import { getDb } from './pglite'

export interface TaskRow {
  id: string
  title: string
  body: string
  status: string
  priority: string
  due_at: string | null
  area_id: string | null
  project_id: string | null
  sfdc_url: string | null
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  archived_at: string | null
}

export interface NewTaskInput {
  title: string
  priority?: string
  areaId?: string | null
  projectId?: string | null
  dueAt?: string | null
}

export async function addTask(input: NewTaskInput) {
  const db = await getDb()
  const id = crypto.randomUUID()
  const priority = input.priority ?? 'p2'
  const areaId = input.areaId ?? null
  const projectId = input.projectId ?? null
  const dueAt = input.dueAt ?? null
  const sortOrder = Date.now()
  await db.query(
    `INSERT INTO tasks (id, title, priority, area_id, project_id, due_at, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.title, priority, areaId, projectId, dueAt, sortOrder],
  )
  await api.apiCreateTask({
    id,
    title: input.title,
    priority,
    area_id: areaId,
    project_id: projectId,
    due_at: dueAt,
    sort_order: sortOrder,
  })
}

export async function setTitle(id: string, title: string) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET title = $2, updated_at = now() WHERE id = $1`, [id, title])
  await api.apiUpdateTask(id, { title })
}

export async function setStatus(id: string, status: string) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`, [id, status])
  await api.apiUpdateTask(id, { status })
}

export async function setPriority(id: string, priority: string) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET priority = $2, updated_at = now() WHERE id = $1`, [id, priority])
  await api.apiUpdateTask(id, { priority })
}

export async function setSfdc(id: string, url: string | null) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET sfdc_url = $2, updated_at = now() WHERE id = $1`, [id, url])
  await api.apiUpdateTask(id, { sfdc_url: url })
}

export async function setDue(id: string, dueAt: string | null) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET due_at = $2, updated_at = now() WHERE id = $1`, [id, dueAt])
  await api.apiUpdateTask(id, { due_at: dueAt })
}

export async function assignTask(
  id: string,
  sel: { areaId: string | null; projectId: string | null },
) {
  const db = await getDb()
  await db.query(
    `UPDATE tasks SET area_id = $2, project_id = $3, updated_at = now() WHERE id = $1`,
    [id, sel.areaId, sel.projectId],
  )
  await api.apiUpdateTask(id, { area_id: sel.areaId, project_id: sel.projectId })
}

export async function archiveTask(id: string) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET archived_at = now(), updated_at = now() WHERE id = $1`, [id])
  await api.apiUpdateTask(id, { archived_at: new Date().toISOString() })
}

export async function unarchiveTask(id: string) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET archived_at = NULL, updated_at = now() WHERE id = $1`, [id])
  await api.apiUpdateTask(id, { archived_at: null })
}

export async function removeTask(id: string) {
  const db = await getDb()
  await db.query(`UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
  await api.apiDeleteTask(id)
}
