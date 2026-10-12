import * as api from '../lib/api'
import { getDb } from './pglite'
import { type EntityType } from './notes'

export interface LinkRow {
  id: string
  entity_type: EntityType
  entity_id: string
  label: string
  url: string
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export async function addLink(entityType: EntityType, entityId: string, label: string, url: string) {
  const db = await getDb()
  const id = crypto.randomUUID()
  const sortOrder = Date.now()
  await db.query(
    `INSERT INTO links (id, entity_type, entity_id, label, url, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, entityType, entityId, label, url, sortOrder],
  )
  await api.apiCreateLink({
    id,
    entity_type: entityType,
    entity_id: entityId,
    label,
    url,
    sort_order: sortOrder,
  })
}

export async function updateLink(id: string, patch: { label?: string; url?: string }) {
  const db = await getDb()
  const sets: string[] = []
  const vals: unknown[] = [id]
  if (patch.label !== undefined) {
    vals.push(patch.label)
    sets.push(`label = $${vals.length}`)
  }
  if (patch.url !== undefined) {
    vals.push(patch.url)
    sets.push(`url = $${vals.length}`)
  }
  if (sets.length === 0) return
  await db.query(`UPDATE links SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals)
  await api.apiUpdateLink(id, patch)
}

export async function removeLink(id: string) {
  const db = await getDb()
  await db.query(`UPDATE links SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
  await api.apiDeleteLink(id)
}
