/** Thin client for the FastAPI write API. Writes are authoritative here; the
 *  result streams back into PGlite via Electric. */
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

async function req(path: string, init: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new Error(`${init.method} ${path} → ${res.status}`)
  return res.json()
}

const get = (path: string) => req(path, { method: 'GET' })
const post = (path: string, body: unknown) =>
  req(path, { method: 'POST', body: JSON.stringify(body) })
const patch = (path: string, body: unknown) =>
  req(path, { method: 'PATCH', body: JSON.stringify(body) })
const del = (path: string) => req(path, { method: 'DELETE' })

// ── Tasks ─────────────────────────────────────────────────────────────────────
export interface NewTask {
  id: string
  title: string
  priority?: string
  due_at?: string | null
  area_id?: string | null
  project_id?: string | null
  sort_order?: number
}

export type TaskPatch = Partial<{
  title: string
  body: string
  status: string
  priority: string
  due_at: string | null
  area_id: string | null
  project_id: string | null
  sfdc_url: string | null
  archived_at: string | null
  sort_order: number
}>

export const apiCreateTask = (t: NewTask) => post('/api/tasks', t)
export const apiUpdateTask = (id: string, p: TaskPatch) => patch(`/api/tasks/${id}`, p)
export const apiDeleteTask = (id: string) => del(`/api/tasks/${id}`)

// ── Areas ─────────────────────────────────────────────────────────────────────
export interface NewArea {
  id: string
  name: string
  kind?: string
  color?: string | null
  sort_order?: number
}
export const apiCreateArea = (a: NewArea) => post('/api/areas', a)
export const apiUpdateArea = (id: string, p: Partial<NewArea>) => patch(`/api/areas/${id}`, p)
export const apiDeleteArea = (id: string) => del(`/api/areas/${id}`)

// ── Projects ──────────────────────────────────────────────────────────────────
export interface NewProject {
  id: string
  name: string
  area_id?: string | null
  sfdc_url?: string | null
  sort_order?: number
}
export const apiCreateProject = (p: NewProject) => post('/api/projects', p)
export const apiUpdateProject = (id: string, p: Partial<NewProject>) =>
  patch(`/api/projects/${id}`, p)
export const apiDeleteProject = (id: string) => del(`/api/projects/${id}`)

// ── Notes (any entity) ────────────────────────────────────────────────────────
export const apiCreateNote = (n: {
  id: string
  entity_type: string
  entity_id: string
  body: string
}) => post('/api/notes', n)
export const apiDeleteNote = (id: string) => del(`/api/notes/${id}`)

// ── Links (any entity) ──────────────────────────────────────────────────────────
export const apiCreateLink = (l: {
  id: string
  entity_type: string
  entity_id: string
  label: string
  url: string
  sort_order?: number
}) => post('/api/links', l)
export const apiUpdateLink = (id: string, p: Partial<{ label: string; url: string }>) =>
  patch(`/api/links/${id}`, p)
export const apiDeleteLink = (id: string) => del(`/api/links/${id}`)

// ── External tools (user-added links to tools outside the app) ────────────────
export interface NewExtTool {
  id: string
  name: string
  url: string
  description?: string
  sort_order?: number
  embed?: boolean
}
export const apiCreateExtTool = (t: NewExtTool) => post('/api/ext-tools', t)
export const apiUpdateExtTool = (
  id: string,
  p: Partial<{ name: string; url: string; description: string; sort_order: number; embed: boolean }>,
) => patch(`/api/ext-tools/${id}`, p)
export const apiDeleteExtTool = (id: string) => del(`/api/ext-tools/${id}`)

// ── Google Calendar feed (read-only, not synced through Electric) ───────────
export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO datetime, or 'YYYY-MM-DD' for all-day
  end: string | null
  all_day: boolean
  location: string | null
  url: string | null
}
export interface CalendarFeed {
  connected: boolean
  events: CalendarEvent[]
}
export const apiCalendarEvents = (start?: string, days = 1): Promise<CalendarFeed> =>
  get(`/api/calendar/events?days=${days}${start ? `&start=${start}` : ''}`)

// ── Databricks auth health (which workspace logins Otter can mint tokens for) ──
export interface AuthDep {
  name: string
  workspace: string
  ok: boolean
  detail: string
  hint: string | null // command to re-login when not ok
}
export interface DatabricksAuth {
  ok: boolean
  deps: AuthDep[]
}
export const apiDatabricksAuth = (): Promise<DatabricksAuth> => get('/api/auth/databricks')

// ── Google Tasks integration ────────────────────────────────────────────────
export interface GoogleStatus {
  configured: boolean
  connected: boolean
  email: string | null
  last_sync_at: string | null
  last_sync_error: string | null
  /** Connected before Gmail/Calendar scopes existed — must re-consent for suggestions. */
  needs_reconnect?: boolean
}
export interface SyncResult {
  connected: boolean
  imported?: number
  updated?: number
  pushed?: number
  error?: string
}
export const apiGoogleStatus = (): Promise<GoogleStatus> => get('/api/google/status')
export const apiGoogleSync = (): Promise<SyncResult> => post('/api/google/sync', {})
export const apiGoogleDisconnect = () => post('/api/google/disconnect', {})
/** Full-page redirect target that kicks off the OAuth consent flow. */
export const googleConnectUrl = () => `${API_URL}/api/google/oauth/start`

// ── Task suggestions (email + calendar → proposed tasks via FMAPI) ───────────
export interface SuggestStatus {
  connected: boolean
  llm_configured: boolean
  llm_model: string
  needs_reconnect: boolean
  sources: Record<string, { last_scan_at: string | null; last_error: string | null }>
  pending: number
  scanning: boolean // a background scan is currently in flight
}
/** /scan now returns immediately — the scan runs in the background. */
export interface ScanStart {
  scanning: boolean
  started: boolean // false when a scan was already running
  already_running?: boolean
}
export interface AcceptSuggestion {
  title?: string
  due_at?: string | null
  area_id?: string | null
  project_id?: string | null
}
export const apiSuggestStatus = (): Promise<SuggestStatus> => get('/api/suggestions/status')
export const apiSuggestScan = (): Promise<ScanStart> => post('/api/suggestions/scan', {})
export const apiSuggestAccept = (id: string, edits: AcceptSuggestion = {}) =>
  post(`/api/suggestions/${id}/accept`, edits)
export const apiSuggestDismiss = (id: string) => post(`/api/suggestions/${id}/dismiss`, {})

// ── Genie One (Databricks MCP natural-language Q&A over governed data) ──────
export interface GenieSource {
  title?: string | null
  url: string
}
export interface GenieTable {
  columns: string[]
  rows: unknown[][]
}
export interface GenieAskResult {
  conversation_id: string
  response_id: string
  status: string
  text: string
  sources: GenieSource[]
  table: GenieTable | null
}
export const apiGenieStatus = (): Promise<{ configured: boolean; host: string }> =>
  get('/api/genie/status')
export const apiGenieAsk = (question: string, conversationId?: string | null): Promise<GenieAskResult> =>
  post('/api/genie/ask', { question, conversation_id: conversationId ?? null })

// MCP App (interactive view) — see tools/genie/GenieView.tsx.
export interface McpToolResult {
  content?: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [k: string]: unknown
}
export const apiGenieApp = (): Promise<{ html: string }> => get('/api/genie/app')
export const apiGenieViewCall = (name: string, args: Record<string, unknown>): Promise<McpToolResult> =>
  post('/api/genie/view/call', { name, arguments: args })
export interface GenieConversationSummary {
  conversation_id: string
  title: string
  turn_count: number
  updated_at: string
}
export interface GenieStoredTurn {
  question: string
  // The original view_ask result; replayed into the view to re-fetch the answer.
  result: McpToolResult
}
export const apiGenieConversations = (): Promise<GenieConversationSummary[]> => get('/api/genie/conversations')
export const apiGenieConversation = (
  id: string,
): Promise<{ conversation_id: string; title: string; turns: GenieStoredTurn[] }> =>
  get(`/api/genie/conversations/${encodeURIComponent(id)}`)
export const apiGenieDeleteConversation = (id: string) =>
  del(`/api/genie/conversations/${encodeURIComponent(id)}`)

// ── Reserved PT estimator (models / usage datasets / simulations) ─────────────
// Writes are authoritative here; the tool reads rows from PGlite via Electric.
export const apiPtCreateModel = (m: Record<string, unknown> & { id: string; name: string }) =>
  post('/api/pt/models', m)
export const apiPtUpdateModel = (id: string, p: Record<string, unknown>) =>
  patch(`/api/pt/models/${id}`, p)
export const apiPtDeleteModel = (id: string) => del(`/api/pt/models/${id}`)

export const apiPtCreateUsage = (u: Record<string, unknown> & { id: string; name: string }) =>
  post('/api/pt/usage', u)
export const apiPtUpdateUsage = (id: string, p: Record<string, unknown>) =>
  patch(`/api/pt/usage/${id}`, p)
export const apiPtDeleteUsage = (id: string) => del(`/api/pt/usage/${id}`)

export const apiPtCreateScenario = (s: Record<string, unknown> & { id: string; name: string }) =>
  post('/api/pt/scenarios', s)
export const apiPtUpdateScenario = (id: string, p: Record<string, unknown>) =>
  patch(`/api/pt/scenarios/${id}`, p)
export const apiPtDeleteScenario = (id: string) => del(`/api/pt/scenarios/${id}`)

// ── Backups (authoritative Postgres → local archive folder) ──────────────────
export interface BackupStatus {
  configured: boolean
  dir: string
  interval_seconds: number
  keep: number
  last_backup_at: string | null
  last_file: string | null
  last_error: string | null
  archive_count: number
}
export interface BackupArchive {
  name: string
  size: number
  modified_at: string
}
export const apiBackupStatus = (): Promise<BackupStatus> => get('/api/backup/status')
export const apiBackupRun = (): Promise<{ ok: boolean; file?: string; rows?: number; error?: string }> =>
  post('/api/backup/run', {})
export const apiBackupList = (): Promise<{ backups: BackupArchive[] }> => get('/api/backup/list')
export const apiBackupRestore = (filename: string): Promise<{ ok: boolean; restored?: Record<string, number> }> =>
  post('/api/backup/restore', { filename })
