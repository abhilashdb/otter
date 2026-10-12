/**
 * Task suggestions: proposed tasks the backend derives from email + calendar
 * (and later Slack). The rows sync in via Electric, read-only from the client's
 * perspective; accepting/dismissing goes through the API. We optimistically flip
 * the local row's status so the card leaves the inbox instantly, then the server
 * row (and, for accept, the new task) streams back to reconcile.
 */
import * as api from '../lib/api'
import { getDb } from './pglite'

export interface SuggestionRow {
  id: string
  source: string // email | calendar | slack
  source_ref: string
  title: string
  reason: string
  detail: string | null
  link_url: string | null
  suggested_due: string | null
  suggested_area_id: string | null
  suggested_project_id: string | null
  status: string // pending | accepted | dismissed
  created_task_id: string | null
  source_at: string | null
  created_at: string
  updated_at: string
}

async function setLocalStatus(id: string, status: string) {
  const db = await getDb()
  await db.query(`UPDATE suggestions SET status = $2, updated_at = now() WHERE id = $1`, [
    id,
    status,
  ])
}

export async function acceptSuggestion(id: string, edits: api.AcceptSuggestion = {}) {
  await setLocalStatus(id, 'accepted')
  await api.apiSuggestAccept(id, edits)
}

export async function dismissSuggestion(id: string) {
  await setLocalStatus(id, 'dismissed')
  await api.apiSuggestDismiss(id)
}
