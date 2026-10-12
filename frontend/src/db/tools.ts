/**
 * Local-first data layer for external tools — user-added links to tools that
 * live outside the app. They're listed on the Tools page next to the built-in
 * (native) tools and launched in a new browser tab. Same optimistic pattern as
 * links/areas: write to PGlite immediately, then to the FastAPI API, and let
 * Electric stream the authoritative row back.
 */
import * as api from '../lib/api'
import { getDb } from './pglite'

export interface ExtToolRow {
  id: string
  name: string
  url: string
  description: string
  sort_order: number
  embed: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export async function addExtTool(input: {
  name: string
  url: string
  description?: string
  embed?: boolean
}) {
  const db = await getDb()
  const id = crypto.randomUUID()
  const description = input.description ?? ''
  const embed = input.embed ?? false
  const sortOrder = Date.now()
  await db.query(
    `INSERT INTO ext_tools (id, name, url, description, sort_order, embed) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.name, input.url, description, sortOrder, embed],
  )
  await api.apiCreateExtTool({
    id,
    name: input.name,
    url: input.url,
    description,
    sort_order: sortOrder,
    embed,
  })
  return id
}

export async function updateExtTool(
  id: string,
  patch: { name?: string; url?: string; description?: string; embed?: boolean },
) {
  const db = await getDb()
  const sets: string[] = []
  const vals: unknown[] = [id]
  for (const key of ['name', 'url', 'description', 'embed'] as const) {
    const v = patch[key]
    if (v !== undefined) {
      vals.push(v)
      sets.push(`${key} = $${vals.length}`)
    }
  }
  if (sets.length === 0) return
  await db.query(`UPDATE ext_tools SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals)
  await api.apiUpdateExtTool(id, patch)
}

export async function removeExtTool(id: string) {
  const db = await getDb()
  await db.query(`UPDATE ext_tools SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
  await api.apiDeleteExtTool(id)
}
