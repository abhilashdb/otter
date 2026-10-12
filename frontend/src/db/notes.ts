import * as api from '../lib/api'
import { getDb } from './pglite'

export type EntityType = 'task' | 'area' | 'project'

export interface NoteRow {
  id: string
  entity_type: EntityType
  entity_id: string
  body: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export async function addNote(entityType: EntityType, entityId: string, body: string) {
  const db = await getDb()
  const id = crypto.randomUUID()
  await db.query(`INSERT INTO notes (id, entity_type, entity_id, body) VALUES ($1, $2, $3, $4)`, [
    id,
    entityType,
    entityId,
    body,
  ])
  await api.apiCreateNote({ id, entity_type: entityType, entity_id: entityId, body })
}

export async function editNote(id: string, entityType: EntityType, entityId: string, body: string) {
  const db = await getDb()
  await db.query(`UPDATE notes SET body = $2, updated_at = now() WHERE id = $1`, [id, body])
  // create endpoint upserts by id, so re-posting updates the body server-side.
  await api.apiCreateNote({ id, entity_type: entityType, entity_id: entityId, body })
}

export async function removeNote(id: string) {
  const db = await getDb()
  await db.query(`UPDATE notes SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
  await api.apiDeleteNote(id)
}
