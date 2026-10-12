import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useLiveQuery } from '@electric-sql/pglite-react'
import ThemeToggle from '../components/ThemeToggle'
import OtterMark from '../components/OtterMark'
import OtterWatcher from '../components/OtterWatcher'
import CommandPalette from '../components/CommandPalette'
import { todayKey } from '../lib/dates'

// Persistent nav stays small; browsing lives in the Overview page.
const NAV = [
  { to: '/overview', label: 'Overview', index: '01' },
  { to: '/tasks', label: 'Tasks', index: '02' },
  { to: '/suggestions', label: 'Suggestions', index: '03' },
  { to: '/tools', label: 'Tools', index: '04' },
  { to: '/settings', label: 'Settings', index: '05' },
]

/** Count of open tasks due today or overdue — the ambient reminder badge. */
function useDueCount(): number {
  const rows = useLiveQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks
     WHERE deleted_at IS NULL AND archived_at IS NULL AND status <> 'done'
       AND due_at IS NOT NULL AND due_at < $1`,
    [`${todayKey()}T23:59:59.999Z`],
  )
  return rows?.rows?.[0]?.n ?? 0
}

/** Count of pending task suggestions awaiting review. */
function useSuggestCount(): number {
  const rows = useLiveQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM suggestions WHERE status = 'pending' AND deleted_at IS NULL`,
  )
  return rows?.rows?.[0]?.n ?? 0
}

export default function AppShell() {
  const dueCount = useDueCount()
  const suggestCount = useSuggestCount()
  const { pathname } = useLocation()
  // Overview (columnar areas), the Tasks board, and tool pages (dashboards,
  // charts, embeds) want the full width; reading-oriented pages stay narrow
  // for legibility.
  const wide =
    pathname === '/overview' ||
    pathname === '/tasks' ||
    pathname === '/tools' ||
    pathname.startsWith('/tools/')
  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 border-r border-line px-3 py-5 sm:block">
        <div className="mb-8 flex items-center gap-2 px-2">
          <OtterMark className="h-6 w-6 text-ink" />
          <span className="text-lg font-semibold tracking-tight">otter</span>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive ? 'bg-surface-sunken text-ink' : 'text-ink-soft hover:text-ink'
                }`
              }
            >
              <span className="font-mono text-xs text-ink-faint">{n.index}</span>
              {n.label}
              {n.to === '/tasks' && dueCount > 0 && (
                <span
                  className="ml-auto grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-accent px-1 font-mono text-[10px] font-medium text-accent-ink"
                  title={`${dueCount} due or overdue`}
                >
                  {dueCount}
                </span>
              )}
              {n.to === '/suggestions' && suggestCount > 0 && (
                <span
                  className="ml-auto grid h-5 min-w-[1.25rem] place-items-center rounded-full border border-line px-1 font-mono text-[10px] font-medium text-ink-soft"
                  title={`${suggestCount} pending suggestion${suggestCount === 1 ? '' : 's'}`}
                >
                  {suggestCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="otter-sweep flex items-center gap-2.5 border-b border-line px-6 py-2.5">
          <OtterWatcher className="h-11 w-11 text-ink" />
          <span className="font-semibold tracking-tight sm:hidden">otter</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('otter:palette'))}
            className="ml-auto flex items-center gap-2 rounded-md border border-line px-2.5 py-1 text-xs text-ink-faint hover:text-ink"
          >
            Search
            <kbd className="rounded border border-line bg-surface-sunken px-1 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>
          </button>
          <ThemeToggle />
        </header>

        <CommandPalette />
        <main className="flex-1 overflow-y-auto px-6 py-8">
          {/* Keyed by route so each navigation replays the gentle rise-in. */}
          <div key={pathname} className={`otter-rise mx-auto ${wide ? 'max-w-6xl' : 'max-w-content'}`}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
