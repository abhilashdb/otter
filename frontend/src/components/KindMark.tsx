import { type AreaRow } from '../db/areas'

function BriefcaseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}
function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  )
}

/** Identity marker for a task's area: a colored dot for customers (by their color),
 *  a briefcase for Internal, a person for Personal. No color needed for the latter two. */
export default function KindMark({ area }: { area?: AreaRow }) {
  if (!area) return null
  if (area.kind === 'customer') {
    return (
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${area.color ? '' : 'border border-line-strong'}`}
        style={area.color ? { backgroundColor: area.color } : undefined}
        aria-hidden
      />
    )
  }
  if (area.kind === 'internal')
    return (
      <span className="shrink-0 text-ink-faint" title="Internal">
        <BriefcaseIcon />
      </span>
    )
  if (area.kind === 'personal')
    return (
      <span className="shrink-0 text-ink-faint" title="Personal">
        <PersonIcon />
      </span>
    )
  return null
}
