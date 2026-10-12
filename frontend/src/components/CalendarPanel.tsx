/**
 * Overview calendar — a Google-Calendar-style single-day view for the right rail.
 * A vertical hour grid shows the selected day's events as blocks positioned and
 * sized by time (overlapping events split into side-by-side columns), all-day
 * events sit in a strip on top, and a red line marks the current time on today.
 * ← / → step days; "Today" jumps back. The feed is external read-only data (not
 * synced through Electric), so each day is fetched from the API and today polls.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiCalendarEvents, type CalendarEvent } from '../lib/api'
import { addDays, todayKey } from '../lib/dates'

const POLL_MS = 5 * 60 * 1000
const HOUR_H = 44 // px per hour in the grid
const MIN_EVENT_H = 22 // px, so short meetings stay readable
const GUTTER = 38 // px, hour-label column width

interface Placed {
  ev: CalendarEvent
  startMin: number
  endMin: number
  col: number
  cols: number
}

/** Minutes from local midnight of `dayKey` for an ISO datetime, clamped to the day. */
function minutesInDay(iso: string, dayKey: string): number {
  const day0 = new Date(`${dayKey}T00:00:00`).getTime()
  const m = (new Date(iso).getTime() - day0) / 60000
  return Math.max(0, Math.min(1440, m))
}

/** Pack timed events into columns so overlapping ones sit side by side. */
function layout(events: CalendarEvent[], dayKey: string): Placed[] {
  const timed = events
    .filter((e) => !e.all_day)
    .map((e) => {
      const startMin = minutesInDay(e.start, dayKey)
      const endMin = Math.max(
        startMin + 15,
        e.end ? minutesInDay(e.end, dayKey) : startMin + 30,
      )
      return { ev: e, startMin, endMin }
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

  const out: Placed[] = []
  let cluster: typeof timed = []
  let clusterEnd = -Infinity
  const flush = () => {
    const colEnds: number[] = []
    const cols: number[] = []
    for (const e of cluster) {
      let c = 0
      while (c < colEnds.length && colEnds[c] > e.startMin) c++
      colEnds[c] = e.endMin
      cols.push(c)
    }
    const nCols = colEnds.length
    cluster.forEach((e, i) => out.push({ ...e, col: cols[i], cols: nCols }))
    cluster = []
  }
  for (const e of timed) {
    if (cluster.length && e.startMin >= clusterEnd) {
      flush()
      clusterEnd = -Infinity
    }
    cluster.push(e)
    clusterEnd = Math.max(clusterEnd, e.endMin)
  }
  if (cluster.length) flush()
  return out
}

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

function timeRange(ev: CalendarEvent): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return ev.end ? `${fmt(ev.start)} – ${fmt(ev.end)}` : fmt(ev.start)
}

export default function CalendarPanel() {
  const [offset, setOffset] = useState(0) // days from today
  const [feed, setFeed] = useState<{ connected: boolean; events: CalendarEvent[] } | null>(null)
  const [error, setError] = useState(false)
  const grid = useRef<HTMLDivElement>(null)

  const dayKey = useMemo(() => addDays(todayKey(), offset), [offset])
  const isToday = offset === 0

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const f = await apiCalendarEvents(dayKey, 1)
        if (alive) {
          setFeed(f)
          setError(false)
        }
      } catch {
        if (alive) setError(true)
      }
    }
    setFeed(null)
    load()
    // Only the live (today) view needs polling; other days are static.
    const timer = isToday ? setInterval(load, POLL_MS) : null
    const onFocus = () => isToday && load()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [dayKey, isToday])

  const allDay = feed?.events.filter((e) => e.all_day) ?? []
  const placed = useMemo(() => (feed ? layout(feed.events, dayKey) : []), [feed, dayKey])

  const nowMin = isToday ? (() => {
    const n = new Date()
    return n.getHours() * 60 + n.getMinutes()
  })() : null

  // Scroll the grid to the current time (or 8am on other days) once loaded.
  useEffect(() => {
    const el = grid.current
    if (!el || !feed || !feed.connected) return
    const focusMin = nowMin ?? 8 * 60
    el.scrollTop = Math.max(0, (focusMin / 60) * HOUR_H - el.clientHeight / 3)
  }, [feed, nowMin])

  const label = isToday
    ? 'Today'
    : offset === 1
      ? 'Tomorrow'
      : offset === -1
        ? 'Yesterday'
        : ''
  const dateStr = new Date(`${dayKey}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  return (
    <section aria-label="Calendar">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            {label || dateStr}
          </h2>
          {label && <span className="truncate text-[11px] text-ink-faint">{dateStr}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isToday && (
            <button
              type="button"
              onClick={() => setOffset(0)}
              className="rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-faint transition-colors hover:text-accent"
            >
              Today
            </button>
          )}
          <button
            type="button"
            onClick={() => setOffset((o) => o - 1)}
            aria-label="Previous day"
            className="grid h-6 w-6 place-items-center rounded-md border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setOffset((o) => o + 1)}
            aria-label="Next day"
            className="grid h-6 w-6 place-items-center rounded-md border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            ›
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {feed && !feed.connected ? (
          <p className="px-4 py-6 text-sm leading-relaxed text-ink-soft">
            Connect Google in{' '}
            <Link to="/settings" className="text-accent hover:underline">
              Settings
            </Link>{' '}
            to see your calendar here.
          </p>
        ) : error && !feed ? (
          <p className="px-4 py-6 text-sm text-ink-faint">Couldn’t load your calendar.</p>
        ) : !feed ? (
          <p className="px-4 py-6 text-sm text-ink-faint">Loading…</p>
        ) : (
          <>
            {allDay.length > 0 && (
              <div className="space-y-1 border-b border-line p-2">
                {allDay.map((ev) => (
                  <AllDayChip key={ev.id} ev={ev} />
                ))}
              </div>
            )}
            <div ref={grid} className="relative max-h-[30rem] overflow-y-auto">
              {/* hour grid */}
              <div className="relative" style={{ height: HOUR_H * 24 }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute left-0 right-0" style={{ top: h * HOUR_H }}>
                    {/* label sits in the gutter, centered on the line, left of it */}
                    {h !== 0 && (
                      <span
                        className="absolute left-0 -translate-y-1/2 pr-1.5 text-right font-mono text-[9px] text-ink-faint"
                        style={{ width: GUTTER }}
                      >
                        {hourLabel(h)}
                      </span>
                    )}
                    {/* the hour line starts after the gutter, so it never crosses the label */}
                    <div
                      className="absolute right-0 top-0 border-t border-line"
                      style={{ left: GUTTER }}
                    />
                  </div>
                ))}

                {/* current-time line */}
                {nowMin !== null && (
                  <div
                    className="pointer-events-none absolute z-10 flex items-center"
                    style={{ top: (nowMin / 60) * HOUR_H, left: GUTTER - 4, right: 4 }}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
                    <span className="h-px flex-1 bg-danger" />
                  </div>
                )}

                {/* events */}
                {placed.map((p) => {
                  const top = (p.startMin / 60) * HOUR_H
                  const height = Math.max(MIN_EVENT_H, ((p.endMin - p.startMin) / 60) * HOUR_H)
                  const colW = `calc((100% - ${GUTTER}px) / ${p.cols})`
                  return (
                    <EventBlock
                      key={p.ev.id}
                      ev={p.ev}
                      style={{
                        top,
                        height,
                        left: `calc(${GUTTER}px + ${p.col} * ${colW})`,
                        width: `calc(${colW} - 3px)`,
                      }}
                    />
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function AllDayChip({ ev }: { ev: CalendarEvent }) {
  const body = (
    <span className="block truncate rounded-md border border-line bg-surface-sunken px-2 py-1 text-[11px] text-ink">
      {ev.title}
    </span>
  )
  return ev.url ? (
    <a href={ev.url} target="_blank" rel="noopener noreferrer" className="block hover:opacity-90">
      {body}
    </a>
  ) : (
    body
  )
}

function EventBlock({ ev, style }: { ev: CalendarEvent; style: React.CSSProperties }) {
  const inner = (
    <div className="h-full overflow-hidden rounded-md border border-accent bg-accent-soft px-1.5 py-0.5 text-left">
      <span className="block truncate text-[11px] font-medium leading-tight text-ink">
        {ev.title}
      </span>
      <span className="block truncate text-[9px] leading-tight text-ink-soft">{timeRange(ev)}</span>
    </div>
  )
  return (
    <div className="absolute" style={style}>
      {ev.url ? (
        <a
          href={ev.url}
          target="_blank"
          rel="noopener noreferrer"
          title={ev.title}
          className="block h-full transition-opacity hover:opacity-90"
        >
          {inner}
        </a>
      ) : (
        inner
      )}
    </div>
  )
}
