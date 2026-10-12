import { useState } from 'react'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { addLink, removeLink, updateLink, type LinkRow } from '../db/links'
import { type EntityType } from '../db/notes'
import { LinkIcon, PencilIcon, TrashIcon } from './icons'

function normalizeUrl(u: string) {
  const v = u.trim()
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

/** Named links (label + url) for any entity — add as many as you like. */
export default function LinksPanel({
  entityType,
  entityId,
}: {
  entityType: EntityType
  entityId: string
}) {
  const links =
    useLiveQuery<LinkRow>(
      `SELECT * FROM links WHERE entity_type = $1 AND entity_id = $2 AND deleted_at IS NULL ORDER BY sort_order, created_at`,
      [entityType, entityId],
    )?.rows ?? []

  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')

  async function add() {
    const u = url.trim()
    if (!u) return
    await addLink(entityType, entityId, label.trim() || 'Link', normalizeUrl(u))
    setLabel('')
    setUrl('')
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint">
        <LinkIcon /> Links · {links.length}
      </h2>

      <ul className="mb-3 space-y-1.5">
        {links.length === 0 && <li className="text-sm text-ink-faint">No links yet.</li>}
        {links.map((l) => (
          <LinkItem key={l.id} link={l} />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. SFDC)"
          className="w-32 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink placeholder:text-ink-faint"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="https://…"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink placeholder:text-ink-faint"
        />
        <button
          onClick={add}
          disabled={!url.trim()}
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-ink disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </section>
  )
}

function LinkItem({ link }: { link: LinkRow }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(link.label)
  const [url, setUrl] = useState(link.url)

  async function save() {
    setEditing(false)
    await updateLink(link.id, { label: label.trim() || 'Link', url: normalizeUrl(url) })
  }

  if (editing) {
    return (
      <li className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-32 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
        />
        <button
          onClick={save}
          className="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-ink"
        >
          Save
        </button>
      </li>
    )
  }

  return (
    <li className="group flex items-center gap-2">
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        title={link.url}
        className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
      >
        <LinkIcon />
        {link.label}
      </a>
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">{link.url}</span>
      <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
        <button onClick={() => setEditing(true)} aria-label="Edit link" className="text-ink-faint hover:text-ink">
          <PencilIcon size={13} />
        </button>
        <button onClick={() => removeLink(link.id)} aria-label="Delete link" className="text-ink-faint hover:text-danger">
          <TrashIcon size={13} />
        </button>
      </div>
    </li>
  )
}
