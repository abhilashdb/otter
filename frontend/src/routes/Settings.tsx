import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  API_URL,
  apiBackupList,
  apiBackupRestore,
  apiBackupRun,
  apiBackupStatus,
  apiDatabricksAuth,
  apiGoogleDisconnect,
  apiGoogleStatus,
  apiGoogleSync,
  googleConnectUrl,
  type AuthDep,
  type BackupArchive,
  type BackupStatus,
  type DatabricksAuth,
  type GoogleStatus,
  type SyncResult,
} from '../lib/api'
import { useConfirm } from '../components/ConfirmProvider'
import { formatDateTime } from '../lib/dates'
import { resetLocalDb } from '../db/pglite'

export default function Settings() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
      <GoogleTasksCard />
      <WorkspaceAccessCard />
      <QuickCaptureCard />
      <BackupCard />
      <LocalDataCard />
    </div>
  )
}

/** Shows whether Otter can currently mint tokens for each Databricks workspace
 *  it depends on (FMAPI/Slack + MLflow). OAuth sessions expire ~daily, so this
 *  is the signal to re-run scripts/db-auth.sh. Checking never opens a browser. */
function WorkspaceAccessCard() {
  const [status, setStatus] = useState<DatabricksAuth | null>(null)
  const [busy, setBusy] = useState(false)
  const [reachable, setReachable] = useState(true)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await apiDatabricksAuth())
      setReachable(true)
    } catch {
      setReachable(false)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const allOk = status?.ok ?? false

  return (
    <section className="max-w-xl rounded-xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-ink">Workspace access</h2>
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded-md border border-line px-2.5 py-1 text-sm text-ink-soft hover:text-ink disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Recheck'}
        </button>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Otter mints tokens from your Databricks CLI logins. OAuth sessions expire periodically —
        when one lapses, re-run{' '}
        <code className="font-mono text-[12px] text-ink">./scripts/db-auth.sh</code>.
      </p>

      {!reachable ? (
        <p className="mt-4 text-sm text-ink-faint">Backend unreachable — can’t check right now.</p>
      ) : !status ? (
        <p className="mt-4 text-sm text-ink-faint">Checking…</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {status.deps.map((d) => (
              <AuthDepRow key={d.name} dep={d} />
            ))}
          </ul>
          {!allOk && (
            <p className="mt-3 text-[12px] text-ink-soft">
              Run the command shown above (or{' '}
              <code className="font-mono text-ink">./scripts/db-auth.sh</code>), then Recheck.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function AuthDepRow({ dep }: { dep: AuthDep }) {
  let host = dep.workspace
  try {
    host = dep.workspace.startsWith('http') ? new URL(dep.workspace).host : dep.workspace
  } catch {
    /* keep as-is */
  }
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] leading-none ${
          dep.ok ? 'bg-accent text-accent-ink' : 'bg-danger text-danger-ink'
        }`}
        aria-hidden
      >
        {dep.ok ? '✓' : '!'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-ink">{dep.name}</span>
          <span className={`font-mono text-[11px] ${dep.ok ? 'text-ink-faint' : 'text-danger'}`}>
            {dep.ok ? 'connected' : 'expired'}
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{host}</div>
        {!dep.ok && dep.hint && (
          <code className="mt-1 block overflow-x-auto rounded-md bg-surface-sunken px-2 py-1 font-mono text-[11px] text-ink">
            {dep.hint}
          </code>
        )}
      </div>
    </li>
  )
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function BackupCard() {
  const confirm = useConfirm()
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [archives, setArchives] = useState<BackupArchive[]>([])
  const [busy, setBusy] = useState<null | 'run' | 'restore'>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([apiBackupStatus(), apiBackupList()])
      setStatus(s)
      setArchives(l.backups)
    } catch {
      /* backend unreachable */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function backupNow() {
    setBusy('run')
    setMsg(null)
    try {
      const r = await apiBackupRun()
      setMsg(r.ok ? `Backed up ${r.rows ?? 0} rows → ${r.file}` : `Backup failed: ${r.error ?? ''}`)
      await refresh()
    } catch {
      setMsg('Backup failed — check the backend logs.')
    } finally {
      setBusy(null)
    }
  }

  async function restore(a: BackupArchive) {
    if (
      !(await confirm({
        title: 'Restore from backup',
        message: `Replace ALL current data with the snapshot from ${a.name}? This overwrites everything in the app with the archive's contents, then re-syncs this device. Cannot be undone.`,
        confirmLabel: 'Restore',
        danger: true,
      }))
    )
      return
    setBusy('restore')
    try {
      await apiBackupRestore(a.name)
      await resetLocalDb() // navigates away (reload) to re-hydrate from restored Postgres
    } catch {
      setMsg('Restore failed — check the backend logs.')
      setBusy(null)
    }
  }

  const cadence =
    status && status.interval_seconds > 0
      ? status.interval_seconds % 86400 === 0
        ? `every ${status.interval_seconds / 86400} day(s)`
        : `every ${Math.round(status.interval_seconds / 3600)}h`
      : 'manual only'

  return (
    <section className="max-w-xl rounded-xl border border-line bg-surface p-6">
      <h2 className="text-lg font-medium text-ink">Backups</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Snapshots of your data (the authoritative database — not the local cache) are written to a
        folder on this machine. Point Google Drive for Desktop (or another sync) at that folder to
        keep copies off-machine.
      </p>

      {status && (
        <dl className="mt-4 space-y-1 text-xs text-ink-faint">
          <div>
            Folder: <span className="font-mono text-ink-soft">{status.dir}</span>
          </div>
          <div>
            Schedule: {cadence} · keeps {status.keep} · {status.archive_count} archive
            {status.archive_count === 1 ? '' : 's'}
          </div>
          <div>
            Last backup:{' '}
            {status.last_backup_at ? formatDateTime(status.last_backup_at) : 'never'}
            {status.last_error && <span className="text-danger"> · error: {status.last_error}</span>}
          </div>
        </dl>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={backupNow}
          disabled={busy !== null}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
        >
          {busy === 'run' ? 'Backing up…' : 'Back up now'}
        </button>
        {msg && <span className="text-xs text-ink-soft">{msg}</span>}
      </div>

      {archives.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            Restore from an archive
          </div>
          <div className="space-y-1">
            {archives.slice(0, 8).map((a) => (
              <div key={a.name} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate font-mono text-ink-soft" title={a.name}>
                  {a.name}
                </span>
                <span className="shrink-0 text-ink-faint">{fmtBytes(a.size)}</span>
                <button
                  onClick={() => restore(a)}
                  disabled={busy !== null}
                  className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink-soft hover:text-danger disabled:opacity-40"
                >
                  {busy === 'restore' ? '…' : 'Restore'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function QuickCaptureCard() {
  const endpoint = `${API_URL}/api/quick-capture`
  const [copied, setCopied] = useState(false)
  const [showSteps, setShowSteps] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the URL is visible to copy manually */
    }
  }

  return (
    <section className="max-w-xl rounded-xl border border-line bg-surface p-6">
      <h2 className="text-lg font-medium text-ink">Quick capture</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Jot a task from anywhere with a global hotkey — no need to open Otter. It lands as an
        unfiled to-do you can triage later.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <code className="flex-1 truncate rounded-md border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-xs text-ink">
          POST {endpoint}
        </code>
        <button
          onClick={copy}
          className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-soft hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowSteps((s) => !s)}
        aria-expanded={showSteps}
        className="mt-5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint hover:text-ink"
      >
        <span className="text-[10px] leading-none">{showSteps ? '▾' : '▸'}</span>
        Set up the macOS hotkey
      </button>

      {showSteps && (
        <>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-ink-soft">
        <li>
          Open the <span className="text-ink">Shortcuts</span> app → <span className="text-ink">＋</span> new
          shortcut.
        </li>
        <li>
          Add <span className="text-ink">“Ask for Input”</span> (type: Text, prompt: “New task”).
        </li>
        <li>
          Add the <span className="text-ink">“URL”</span> action and set it to the URL above. (Using a
          real URL action avoids the “couldn’t convert Rich Text to URL” error you get if the text
          variable lands in the URL field.)
        </li>
        <li>
          Add <span className="text-ink">“Get Contents of URL”</span> → set its URL to the{' '}
          <span className="text-ink">URL</span> variable from the previous step; method{' '}
          <span className="font-mono text-xs">POST</span>; Request Body{' '}
          <span className="font-mono text-xs">JSON</span>; add one field{' '}
          <span className="font-mono text-xs">title</span> (Text) whose{' '}
          <span className="text-ink">value</span> is the <span className="text-ink">Provided Input</span>{' '}
          variable.
        </li>
        <li>
          (Optional) add <span className="text-ink">“Show Notification”</span> → “Captured ✓”.
        </li>
        <li>
          Name it <span className="text-ink">Otter Capture</span>, then in the shortcut’s details
          add a <span className="text-ink">keyboard shortcut</span> (e.g. ⌃⌥Space).
        </li>
      </ol>

      <p className="mt-4 text-xs text-ink-faint">
        Prefer the terminal? <span className="font-mono">scripts/capture.sh &quot;your task&quot;</span> hits
        the same endpoint.
      </p>
      </>
      )}
    </section>
  )
}

function LocalDataCard() {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)

  async function resync() {
    if (
      !(await confirm({
        title: 'Re-sync local data',
        message:
          'Clears this device’s local copy and re-downloads everything from the server. Safe — your data lives on the server. The page will reload.',
        confirmLabel: 'Re-sync',
      }))
    )
      return
    setBusy(true)
    await resetLocalDb() // navigates away (reload)
  }

  return (
    <section className="max-w-xl rounded-xl border border-line bg-surface p-6">
      <h2 className="text-lg font-medium text-ink">Local data</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Otter keeps a local copy that syncs from the server. If something looks stale or missing
        (e.g. after a server restart), re-sync to rebuild it from scratch.
      </p>
      <button
        onClick={resync}
        disabled={busy}
        className="mt-4 rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-40"
      >
        {busy ? 'Re-syncing…' : 'Re-sync local data'}
      </button>
    </section>
  )
}

function GoogleTasksCard() {
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiGoogleStatus())
    } catch {
      setError('Could not reach the backend.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Surface the OAuth round-trip result, then clear it from the URL.
  useEffect(() => {
    const g = params.get('google')
    if (g === 'error') setError('Google connection failed or was cancelled.')
    if (g === 'connected' || g === 'error') {
      const p = new URLSearchParams(params)
      p.delete('google')
      setParams(p, { replace: true })
    }
  }, [params, setParams])

  async function sync() {
    setSyncing(true)
    setError(null)
    setResult(null)
    try {
      const r = await apiGoogleSync()
      if (r.error) setError(r.error)
      else setResult(r)
      await refresh()
    } catch {
      setError('Sync failed. Check the backend logs.')
    } finally {
      setSyncing(false)
    }
  }

  async function disconnect() {
    if (
      !(await confirm({
        title: 'Disconnect Google',
        message: 'Otter will stop syncing. Already-imported tasks stay. Reconnect anytime.',
        confirmLabel: 'Disconnect',
        danger: true,
      }))
    )
      return
    await apiGoogleDisconnect()
    setResult(null)
    await refresh()
  }

  return (
    <section className="max-w-xl rounded-xl border border-line bg-surface p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-ink">Google</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Import open Google Tasks (title, due &amp; notes stay in sync from Google; completing one
            here marks it done there). Read access to Gmail &amp; Calendar also powers task
            suggestions.
          </p>
        </div>
        <StatusBadge status={status} loading={loading} />
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-danger bg-surface-sunken px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      {result && (result.imported != null || result.pushed != null) && (
        <p className="mt-4 rounded-md border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
          Synced — imported {result.imported ?? 0}, updated {result.updated ?? 0}, pushed{' '}
          {result.pushed ?? 0} status change{(result.pushed ?? 0) === 1 ? '' : 's'}.
        </p>
      )}

      {status?.connected && status.needs_reconnect && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-sunken px-3 py-2">
          <p className="text-xs text-ink-soft">
            Reconnect to grant Gmail &amp; Calendar read access — needed for task suggestions.
          </p>
          <a
            href={googleConnectUrl()}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink"
          >
            Reconnect
          </a>
        </div>
      )}

      <div className="mt-6">
        {loading ? null : !status?.configured ? (
          <NotConfigured />
        ) : status.connected ? (
          <div className="space-y-4">
            <dl className="space-y-1.5 text-sm">
              <Row label="Account" value={status.email ?? 'connected'} />
              <Row
                label="Last synced"
                value={status.last_sync_at ? formatDateTime(status.last_sync_at) : 'never'}
              />
            </dl>
            {status.last_sync_error && (
              <p className="text-xs text-danger">Last error: {status.last_sync_error}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={sync}
                disabled={syncing}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                onClick={disconnect}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <a
            href={googleConnectUrl()}
            className="inline-flex rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
          >
            Connect Google Tasks
          </a>
        )}
      </div>
    </section>
  )
}

function StatusBadge({ status, loading }: { status: GoogleStatus | null; loading: boolean }) {
  const [label, tone] = loading
    ? ['…', 'muted']
    : status?.connected
      ? ['Connected', 'ok']
      : status?.configured
        ? ['Not connected', 'muted']
        : ['Setup needed', 'muted']
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
        tone === 'ok' ? 'border-accent text-accent' : 'border-line text-ink-faint'
      }`}
    >
      {label}
    </span>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-ink-faint">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className="rounded-md border border-line bg-surface-sunken px-4 py-3 text-sm text-ink-soft">
      <p className="mb-2 font-medium text-ink">Setup needed</p>
      <p>
        Add your Google OAuth credentials to the repo-root <code className="font-mono text-xs">.env</code>{' '}
        (<code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> /{' '}
        <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code>) and restart the backend. See{' '}
        <code className="font-mono text-xs">.env.example</code> for the Google Cloud Console steps.
      </p>
    </div>
  )
}
