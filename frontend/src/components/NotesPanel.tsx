import { useState } from 'react'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { addNote, editNote, removeNote, type EntityType, type NoteRow } from '../db/notes'
import { formatDateTime } from '../lib/dates'
import { linkify } from '../lib/linkify'
import { NotepadIcon } from './icons'

/** Timestamped notes for any entity (task/area/project), newest first. */
export default function NotesPanel({
  entityType,
  entityId,
}: {
  entityType: EntityType
  entityId: string
}) {
  const [draft, setDraft] = useState('')
  const notes =
    useLiveQuery<NoteRow>(
      `SELECT * FROM notes WHERE entity_type = $1 AND entity_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [entityType, entityId],
    )?.rows ?? []

  async function add() {
    const b = draft.trim()
    if (!b) return
    setDraft('')
    await addNote(entityType, entityId, b)
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint">
        <NotepadIcon /> Notes · {notes.length}
      </h2>
      <div className="mb-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') add()
          }}
          placeholder="Add a note…  (⌘/Ctrl+Enter)"
          rows={3}
          className="w-full resize-y rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={add}
            disabled={!draft.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
          >
            Add note
          </button>
        </div>
      </div>
      <ul className="space-y-3">
        {notes.length === 0 && <li className="text-sm text-ink-faint">No notes yet.</li>}
        {notes.map((n) => (
          <NoteItem key={n.id} note={n} entityType={entityType} entityId={entityId} />
        ))}
      </ul>
    </section>
  )
}

function NoteItem({
  note,
  entityType,
  entityId,
}: {
  note: NoteRow
  entityType: EntityType
  entityId: string
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(note.body)

  async function save() {
    const b = val.trim()
    setEditing(false)
    if (b && b !== note.body) await editNote(note.id, entityType, entityId, b)
    else setVal(note.body)
  }

  return (
    <li className="group rounded-md border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <time className="font-mono text-[10px] text-ink-faint">{formatDateTime(note.created_at)}</time>
        <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
          {!editing && (
            <button
              onClick={() => {
                setVal(note.body)
                setEditing(true)
              }}
              className="text-[11px] text-ink-faint hover:text-ink"
            >
              edit
            </button>
          )}
          <button
            onClick={() => removeNote(note.id)}
            aria-label="Delete note"
            className="text-xs text-ink-faint hover:text-danger"
          >
            ✕
          </button>
        </div>
      </div>
      {editing ? (
        <div className="mt-1">
          <textarea
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
              if (e.key === 'Escape') {
                setEditing(false)
                setVal(note.body)
              }
            }}
            rows={3}
            className="w-full resize-y rounded-md border border-line bg-surface-sunken px-2 py-1.5 text-sm text-ink"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              onClick={() => {
                setEditing(false)
                setVal(note.body)
              }}
              className="text-xs text-ink-faint hover:text-ink"
            >
              cancel
            </button>
            <button
              onClick={save}
              className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-accent-ink"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{linkify(note.body)}</p>
      )}
    </li>
  )
}
