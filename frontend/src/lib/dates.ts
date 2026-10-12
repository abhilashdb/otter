/**
 * Due dates are plain calendar days. PGlite returns timestamptz columns as Date
 * objects (Electric-synced ones can arrive as strings), so normalize everything
 * through these helpers. We anchor day values at UTC midnight so a picked day
 * never shifts across timezones (e.g. IST) on the round-trip.
 */

/** Normalize a due value (Date | ISO string | null) to a 'YYYY-MM-DD' key. */
export function dateKey(due: unknown): string {
  if (!due) return ''
  const d = due instanceof Date ? due : new Date(String(due))
  return Number.isNaN(d.getTime()) ? String(due).slice(0, 10) : d.toISOString().slice(0, 10)
}

/** ISO instant (UTC midnight) for a <input type="date"> value, or null. */
export function isoFromInput(v: string): string | null {
  return v ? new Date(`${v}T00:00:00Z`).toISOString() : null
}

/** Local "today" as a 'YYYY-MM-DD' key (compared against day keys as strings). */
export function todayKey(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** Shift a 'YYYY-MM-DD' key by n days, returning a new key (UTC-anchored). */
export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** ISO instant (UTC midnight) for a day key — for writing back a due date. */
export function isoFromKey(key: string): string {
  return `${key}T00:00:00.000Z`
}

/** End of the week (Sunday) for a day key, optionally N weeks ahead — used by
 *  the "this week" / "this + next" focus horizons. */
export function endOfWeek(key: string, weeksAhead = 0): string {
  const d = new Date(`${key}T00:00:00Z`)
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay() // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + (7 - iso) + weeksAhead * 7)
  return d.toISOString().slice(0, 10)
}

/** Relative day label: 'Today', 'Tomorrow', 'Yesterday', weekday if within a week, else date. */
export function relativeDay(key: string): string {
  if (!key) return ''
  const t = todayKey()
  if (key === t) return 'Today'
  if (key === addDays(t, 1)) return 'Tomorrow'
  if (key === addDays(t, -1)) return 'Yesterday'
  const d = new Date(`${key}T00:00:00Z`)
  const diff = Math.round((d.getTime() - new Date(`${t}T00:00:00Z`).getTime()) / 86400000)
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })
  return formatDate(key)
}

/** Human short label for a day key, e.g. 'Sep 21'. */
export function formatDate(key: string): string {
  const d = new Date(`${key}T00:00:00Z`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Full local date + time for a real timestamp (Date | ISO string), e.g. 'Sep 19, 2:45 PM'. */
export function formatDateTime(v: unknown): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
