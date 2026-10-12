import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from '@electric-sql/pglite-react'
import {
  apiSuggestScan,
  apiSuggestStatus,
  googleConnectUrl,
  type SuggestStatus,
} from '../lib/api'
import { acceptSuggestion, dismissSuggestion, type SuggestionRow } from '../db/suggestions'
import { type AreaRow } from '../db/areas'
import { type ProjectRow } from '../db/projects'
import { dateKey, formatDate, formatDateTime } from '../lib/dates'
import EmptyState from '../components/EmptyState'
import { SparkIcon } from '../components/icons'

const SOURCE_LABEL: Record<string, string> = {
  calendar: 'Meetings',
  email: 'Email',
  slack: 'Slack',
  filing: 'Unfiled tasks',
}

/** Turn a raw scan error into an actionable hint, distinguishing a broken auth
 *  (needs a human to re-login/reconnect) from a transient failure (self-heals on
 *  the next background scan). */
function errorHint(source: string, msg: string): string | null {
  const m = msg.toLowerCase()
  const googleSource = source === 'calendar' || source === 'email'
  if (googleSource && /invalid_grant|refresh|unauthor|\b401\b|403/.test(m))
    return 'Google access looks revoked — reconnect Google in Settings.'
  if (/databricks|auth token|cli|token failed|not found on path/.test(m))
    return 'Databricks login expired — run `databricks auth login` in your terminal, then scan again.'
  return 'Transient error — it will retry on the next background scan.'
}

export default function Suggestions() {
  const rows =
    useLiveQuery<SuggestionRow>(
      `SELECT * FROM suggestions WHERE status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC`,
    )?.rows ?? []
  const areas =
    useLiveQuery<AreaRow>(`SELECT id, name, kind, color FROM areas WHERE deleted_at IS NULL`)
      ?.rows ?? []
  const projects =
    useLiveQuery<ProjectRow>(`SELECT id, name, area_id FROM projects WHERE deleted_at IS NULL`)
      ?.rows ?? []

  const areaById = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas])
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // Group by source; meetings soonest-first, email newest-first.
  const groups = useMemo(() => {
    const by: Record<string, SuggestionRow[]> = {}
    for (const r of rows) (by[r.source] ??= []).push(r)
    for (const [src, list] of Object.entries(by)) {
      list.sort((a, b) => {
        const ta = a.source_at ? new Date(a.source_at).getTime() : 0
        const tb = b.source_at ? new Date(b.source_at).getTime() : 0
        return src === 'calendar' ? ta - tb : tb - ta
      })
    }
    return by
  }, [rows])

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Suggestions</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Tasks Otter spotted across your email, calendar, and Slack. Accept the useful ones —
            they land as real tasks, filed and linked back to the source.
          </p>
        </div>
      </div>

      <ScanBar pending={rows.length} />

      {rows.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<SparkIcon />}
            title="You're all caught up"
            hint="No suggestions right now. Otter scans your email, calendar, and Slack in the background — new ones will land here, or run a scan above."
          />
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {Object.entries(groups).map(([source, list]) => (
            <section key={source}>
              <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
                {SOURCE_LABEL[source] ?? source} · {list.length}
              </h2>
              <div className="border-t border-line">
                {list.map((s) => (
                  <SuggestionCard
                    key={s.id}
                    s={s}
                    areas={areas}
                    projects={projects}
                    areaById={areaById}
                    projectById={projectById}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function ScanBar({ pending }: { pending: number }) {
  const [status, setStatus] = useState<SuggestStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [justFinished, setJustFinished] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiSuggestStatus())
    } catch {
      /* backend unreachable — leave status null */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The scan runs server-side, so `status.scanning` is the source of truth and
  // survives navigating away and back. `starting` covers the brief gap between
  // the trigger and the first status refresh reflecting it.
  const scanning = starting || !!status?.scanning

  // While a scan is in flight, poll status so the indicator clears itself when
  // the server finishes — even if the user left and returned.
  useEffect(() => {
    if (!scanning) return
    const id = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(id)
  }, [scanning, refresh])

  // Surface a transient "complete" note when a scan we saw running has finished.
  const wasScanning = useRef(false)
  useEffect(() => {
    if (wasScanning.current && !scanning) setJustFinished(true)
    wasScanning.current = scanning
  }, [scanning])

  async function scan() {
    setError(null)
    setJustFinished(false)
    setStarting(true)
    try {
      await apiSuggestScan()
      await refresh()
    } catch {
      setError('Scan failed — check the backend logs.')
    } finally {
      setStarting(false)
    }
  }

  const lastScan = status
    ? Object.values(status.sources)
        .map((s) => s.last_scan_at)
        .filter(Boolean)
        .sort()
        .at(-1)
    : null
  // Every source that errored on its last run — one failing source never sinks
  // the others, so surface each so a broken connection is obvious.
  const sourceErrors = status
    ? Object.entries(status.sources).filter(([, s]) => s.last_error)
    : []
  const needsReconnect = status?.needs_reconnect || error === 'reconnect'

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      {needsReconnect ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-soft">
            Reconnect Google to grant read access to Gmail &amp; Calendar so Otter can scan them.
          </p>
          <a
            href={googleConnectUrl()}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
          >
            Reconnect Google
          </a>
        </div>
      ) : status && !status.connected ? (
        <p className="text-sm text-ink-soft">
          Connect Google in <span className="font-medium text-ink">Settings</span> to enable
          suggestions.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-ink-faint">
            <span className="text-ink-soft">
              {pending} pending
              {status && !status.llm_configured ? ' · LLM not configured (basic mode)' : ''}
            </span>
            {lastScan && <span> · last scan {formatDateTime(lastScan)}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {scanning && (
              <span className="font-mono text-[11px] text-ink-faint">runs in the background</span>
            )}
            <button
              onClick={scan}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-60"
            >
              {scanning && (
                <span
                  className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent-ink/40 border-t-accent-ink"
                  aria-hidden
                />
              )}
              {scanning ? 'Scanning…' : 'Scan now'}
            </button>
          </div>
        </div>
      )}

      {sourceErrors.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-line pt-3">
          {sourceErrors.map(([src, s]) => (
            <p key={src} className="text-xs text-danger">
              <span className="font-medium">{SOURCE_LABEL[src] ?? src}</span> couldn&apos;t scan:{' '}
              <span className="text-ink-soft">{errorHint(src, s.last_error ?? '')}</span>
            </p>
          ))}
        </div>
      )}

      {scanning && !error && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-soft">
          Scanning in the background — you can leave this page; new suggestions appear here as
          they’re found.
        </p>
      )}
      {justFinished && !scanning && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-soft">
          Scan complete — any new suggestions are listed below.
        </p>
      )}
      {error && error !== 'reconnect' && <p className="mt-3 text-xs text-danger">{error}</p>}
    </div>
  )
}

function SuggestionCard({
  s,
  areas,
  projects,
  areaById,
  projectById,
}: {
  s: SuggestionRow
  areas: AreaRow[]
  projects: ProjectRow[]
  areaById: Map<string, AreaRow>
  projectById: Map<string, ProjectRow>
}) {
  const [busy, setBusy] = useState<null | 'accept' | 'dismiss'>(null)
  const [editing, setEditing] = useState(false)
  // The filing the user will accept with — starts from the LLM's proposal, and
  // the user can override it here before accepting.
  const [areaId, setAreaId] = useState<string | null>(s.suggested_area_id)
  const [projectId, setProjectId] = useState<string | null>(s.suggested_project_id)
  const due = s.suggested_due ? dateKey(s.suggested_due) : ''
  const filing = s.source === 'filing'

  const area = areaId ? areaById.get(areaId) : undefined
  const project = projectId ? projectById.get(projectId) : undefined
  // Projects belong to an area; only offer ones under the chosen area.
  const areaProjects = useMemo(
    () => (areaId ? projects.filter((p) => p.area_id === areaId) : []),
    [projects, areaId],
  )

  async function accept() {
    setBusy('accept')
    try {
      // Always send the (possibly edited) filing explicitly so a changed area
      // can't leave a stale project attached.
      await acceptSuggestion(s.id, { area_id: areaId, project_id: projectId })
    } catch {
      setBusy(null)
    }
  }
  async function dismiss() {
    setBusy('dismiss')
    try {
      await dismissSuggestion(s.id)
    } catch {
      setBusy(null)
    }
  }

  function chooseArea(id: string | null) {
    setAreaId(id)
    // Drop the project if it no longer belongs to the newly chosen area.
    if (id === null) setProjectId(null)
    else if (projectId && projectById.get(projectId)?.area_id !== id) setProjectId(null)
  }

  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-4">
      <div className="min-w-0">
        <p className="font-medium text-ink">{s.title}</p>
        {s.reason && <p className="mt-0.5 text-sm text-ink-soft">{s.reason}</p>}
        {s.detail && <p className="mt-1 text-xs text-ink-faint">{s.detail}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Chip>
            {area ? (
              <>
                {area.color && (
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: area.color }}
                    aria-hidden
                  />
                )}
                {area.name}
                {project ? ` / ${project.name}` : ''}
              </>
            ) : (
              <span className="text-ink-faint">Unfiled</span>
            )}
          </Chip>
          <button
            onClick={() => setEditing((v) => !v)}
            className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint hover:text-ink"
          >
            {editing ? 'Done' : 'Change filing'}
          </button>
          {due && <Chip>{formatDate(due)}</Chip>}
          {s.link_url && (
            <a
              href={s.link_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint hover:text-ink"
            >
              Open source ↗
            </a>
          )}
        </div>
        {editing && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={areaId ?? ''}
              onChange={(e) => chooseArea(e.target.value || null)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
            >
              <option value="">Unfiled</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value || null)}
              disabled={!areaId || areaProjects.length === 0}
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
            >
              <option value="">No project</option>
              {areaProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={accept}
          disabled={busy !== null}
          className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-accent-ink disabled:opacity-40"
        >
          {busy === 'accept' ? (filing ? 'Filing…' : 'Adding…') : filing ? 'File' : 'Accept'}
        </button>
        <button
          onClick={dismiss}
          disabled={busy !== null}
          className="rounded-md border border-line px-2.5 py-1 text-sm text-ink-soft hover:text-ink disabled:opacity-40"
        >
          {filing ? 'Keep unfiled' : 'Dismiss'}
        </button>
      </div>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft">
      {children}
    </span>
  )
}
