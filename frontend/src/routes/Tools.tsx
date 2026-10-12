import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TOOLS } from '../tools/registry'
import { launchTool, normalizeToolUrl, useExtTools } from '../tools/useTools'
import { addExtTool, removeExtTool, updateExtTool, type ExtToolRow } from '../db/tools'
import { LinkIcon, PencilIcon, TrashIcon } from '../components/icons'
import { recordToolLaunch, toolKey } from '../lib/toolUsage'
import { useConfirm } from '../components/ConfirmProvider'

export function ToolsIndex() {
  const navigate = useNavigate()
  const extTools = useExtTools()
  const confirm = useConfirm()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <div>
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Tools</h1>

      {/* Built-in tools */}
      <SectionLabel>Built-in</SectionLabel>
      {TOOLS.length === 0 ? (
        <p className="mb-8 max-w-prose text-sm leading-relaxed text-ink-soft">
          No built-in tools yet. These are small, purpose-built pages registered in{' '}
          <code className="font-mono text-ink">src/tools/registry.ts</code>.
        </p>
      ) : (
        <div className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((t) => (
            <Link
              key={t.id}
              to={`/tools/${t.id}`}
              onClick={() => recordToolLaunch(toolKey('native', t.id))}
              className="group rounded-lg border border-line bg-surface p-4 transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-sm"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{t.name}</span>
                <Badge>Built-in</Badge>
              </div>
              {t.description && <div className="mt-1 text-sm text-ink-soft">{t.description}</div>}
            </Link>
          ))}
        </div>
      )}

      {/* External tools */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionLabel className="mb-0">External</SectionLabel>
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setAdding(true)
            }}
            className="rounded-md border border-line px-2.5 py-1 text-sm text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            ＋ Add tool
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-4 rounded-lg border border-line bg-surface p-4">
          <ToolForm
            submitLabel="Add tool"
            onCancel={() => setAdding(false)}
            onSubmit={async (v) => {
              await addExtTool(v)
              setAdding(false)
            }}
          />
        </div>
      )}

      {extTools.length === 0 && !adding ? (
        <p className="max-w-prose text-sm leading-relaxed text-ink-soft">
          No external tools yet. Add a link to any tool you use outside the app — it shows up here
          and launches in a new tab.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {extTools.map((t) =>
            editing === t.id ? (
              <div key={t.id} className="rounded-lg border border-line bg-surface p-4 sm:col-span-2 lg:col-span-3">
                <ToolForm
                  initial={t}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (v) => {
                    await updateExtTool(t.id, v)
                    setEditing(null)
                  }}
                />
              </div>
            ) : (
              <ExtToolCard
                key={t.id}
                tool={t}
                onLaunch={() =>
                  launchTool(
                    {
                      key: toolKey('external', t.id),
                      kind: 'external',
                      id: t.id,
                      name: t.name,
                      url: t.url,
                      embed: t.embed,
                    },
                    navigate,
                  )
                }
                onEdit={() => {
                  setAdding(false)
                  setEditing(t.id)
                }}
                onDelete={async () => {
                  if (
                    await confirm({
                      title: 'Remove tool',
                      message: `Remove “${t.name}” from your tools? The external tool itself isn’t affected.`,
                      confirmLabel: 'Remove',
                      danger: true,
                    })
                  )
                    await removeExtTool(t.id)
                }}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}

function ExtToolCard({
  tool,
  onLaunch,
  onEdit,
  onDelete,
}: {
  tool: ExtToolRow
  onLaunch: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  let host = ''
  try {
    host = new URL(normalizeToolUrl(tool.url)).host
  } catch {
    host = tool.url
  }
  return (
    <div className="group relative rounded-lg border border-line bg-surface p-4 transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-sm">
      <button type="button" onClick={onLaunch} className="block w-full text-left">
        <div className="flex items-center gap-2 pr-14">
          <LinkIcon size={13} />
          <span className="truncate font-medium text-ink">{tool.name}</span>
          <span className="shrink-0 text-ink-faint transition-colors group-hover:text-accent" aria-hidden>
            {tool.embed ? '⊡' : '↗'}
          </span>
        </div>
        {tool.description && <div className="mt-1 text-sm text-ink-soft">{tool.description}</div>}
        <div className="mt-1 flex items-center gap-2">
          {host && <span className="truncate font-mono text-[11px] text-ink-faint">{host}</span>}
          {tool.embed && <Badge>Embedded</Badge>}
        </div>
      </button>
      <div className="absolute right-3 top-3 flex items-center gap-2.5 text-ink-faint opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
        <button type="button" aria-label="Edit tool" onClick={onEdit} className="hover:text-ink">
          <PencilIcon size={13} />
        </button>
        <button type="button" aria-label="Remove tool" onClick={onDelete} className="hover:text-danger">
          <TrashIcon size={13} />
        </button>
      </div>
    </div>
  )
}

function ToolForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Pick<ExtToolRow, 'name' | 'url' | 'description' | 'embed'>
  submitLabel: string
  onSubmit: (v: {
    name: string
    url: string
    description: string
    embed: boolean
  }) => void | Promise<unknown>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [embed, setEmbed] = useState(initial?.embed ?? false)
  const [busy, setBusy] = useState(false)
  const valid = name.trim() !== '' && url.trim() !== ''

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    try {
      await onSubmit({
        name: name.trim(),
        url: normalizeToolUrl(url),
        description: description.trim(),
        embed,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
            placeholder="e.g. Grafana"
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint"
          />
        </Field>
        <Field label="Link">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
            placeholder="grafana.internal/d/…"
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint"
          />
        </Field>
      </div>
      <Field label="Description (optional)">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="What it’s for"
          className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint"
        />
      </Field>
      <label className="flex items-start gap-2.5 rounded-md border border-line bg-surface-sunken px-3 py-2">
        <input
          type="checkbox"
          checked={embed}
          onChange={(e) => setEmbed(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
        />
        <span className="text-sm text-ink">
          Open embedded in Otter
          <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">
            Show the tool in an in-app panel instead of a new tab. Works for pages that allow
            framing — e.g. a Databricks App (you must be signed in to that workspace).
          </span>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!valid || busy}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-ink-faint hover:text-ink"
        >
          Cancel
        </button>
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {embed ? 'Opens embedded' : 'Opens in a new tab'}
        </span>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      {children}
    </label>
  )
}

function SectionLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={`mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint ${className}`}>
      {children}
    </h2>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-ink-faint">
      {children}
    </span>
  )
}

export function ToolPage() {
  const { toolId } = useParams()
  const tool = TOOLS.find((t) => t.id === toolId)
  if (!tool) {
    return (
      <p className="text-sm text-ink-faint">
        Tool not found.{' '}
        <Link to="/tools" className="text-accent hover:underline">
          Back to tools
        </Link>
      </p>
    )
  }
  const El = tool.element
  return <El />
}

/**
 * Embedded external-tool viewer: renders the tool's URL in a full-height iframe
 * inside the app shell. Framing only works for pages that allow it (Databricks
 * Apps do, for viewers already authenticated to that workspace); a page that
 * sends X-Frame-Options/frame-ancestors will show blank, so we offer a "new
 * tab" escape hatch.
 */
export function ToolEmbed() {
  const { extId } = useParams()
  const tool = useExtTools().find((t) => t.id === extId)
  // Bumping this remounts the iframe — used to retry after signing in to the
  // workspace in another tab (the SSO redirect can't complete inside a frame on
  // a cold session, so it shows a login screen until the session exists).
  const [reloadKey, setReloadKey] = useState(0)
  if (!tool) {
    return (
      <p className="text-sm text-ink-faint">
        Tool not found.{' '}
        <Link to="/tools" className="text-accent hover:underline">
          Back to tools
        </Link>
      </p>
    )
  }
  const url = normalizeToolUrl(tool.url)
  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <div className="mb-2 flex items-center gap-3">
        <Link to="/tools" className="text-sm text-ink-faint hover:text-ink">
          ← Tools
        </Link>
        <h1 className="truncate text-lg font-semibold tracking-tight">{tool.name}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="text-sm text-ink-faint transition-colors hover:text-ink"
          >
            ↻ Reload
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-ink-faint transition-colors hover:text-accent"
          >
            Open in new tab ↗
          </a>
        </div>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-faint">
        <strong>Sign-in screen?</strong> SSO can’t complete inside a frame until you have a
        workspace session — open in a new tab once, then <strong>Reload</strong>.{' '}
        <strong>“Refused to connect”?</strong> The app is blocking framing (X-Frame-Options / CSP
        <code className="mx-1 font-mono">frame-ancestors</code>). Fix it on the app side: drop
        X-Frame-Options and set <code className="font-mono">frame-ancestors</code> to this page’s
        origin — otherwise use “Open in new tab”.
      </p>
      <iframe
        key={reloadKey}
        src={url}
        title={tool.name}
        className="min-h-0 flex-1 rounded-lg border border-line bg-surface"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-top-navigation-by-user-activation"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  )
}
