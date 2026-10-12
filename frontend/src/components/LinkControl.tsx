import { useState } from 'react'

function LinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  )
}

/** Attach / open / edit a URL (e.g. a Salesforce use-case link). */
export default function LinkControl({
  url,
  onChange,
  addLabel = 'Link SFDC',
  openLabel = 'SFDC',
}: {
  url: string | null
  onChange: (u: string | null) => void
  addLabel?: string
  openLabel?: string
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(url ?? '')

  function commit() {
    const v = val.trim()
    if (v === '') {
      onChange(null)
    } else {
      onChange(/^https?:\/\//i.test(v) ? v : `https://${v}`)
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="https://…"
          className="w-48 rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={commit}
          className="rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-ink"
        >
          set
        </button>
      </span>
    )
  }
  if (url) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={url}
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <LinkIcon /> {openLabel}
        </a>
        <button
          type="button"
          onClick={() => {
            setVal(url)
            setEditing(true)
          }}
          className="text-[11px] text-ink-faint hover:text-ink"
        >
          edit
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => {
        setVal('')
        setEditing(true)
      }}
      className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
    >
      <LinkIcon /> {addLabel}
    </button>
  )
}
