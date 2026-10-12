import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { useOpenTask } from './TaskDrawerProvider'
import { addTask, type TaskRow } from '../db/tasks'
import { type AreaRow } from '../db/areas'
import { type ProjectRow } from '../db/projects'
import { launchTool, useAllTools } from '../tools/useTools'

interface Item {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

/** Global ⌘K palette: search tasks / areas / projects / tools, jump around, or
 *  create a task from the query. Mounted once in the app shell. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const openTask = useOpenTask()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    function onOpenEvent() {
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('otter:palette', onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('otter:palette', onOpenEvent)
    }
  }, [])

  const tasks =
    useLiveQuery<TaskRow>(
      `SELECT id, title, status, area_id, project_id FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`,
    )?.rows ?? []
  const areas = useLiveQuery<AreaRow>(`SELECT * FROM areas WHERE deleted_at IS NULL`)?.rows ?? []
  const projects =
    useLiveQuery<ProjectRow>(`SELECT * FROM projects WHERE deleted_at IS NULL`)?.rows ?? []
  const allTools = useAllTools()

  const query = q.trim().toLowerCase()

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const nav: Item[] = [
      { id: 'nav-overview', label: 'Go to Overview', group: 'Go', run: () => navigate('/overview') },
      { id: 'nav-tasks', label: 'Go to Tasks', group: 'Go', run: () => navigate('/tasks') },
      { id: 'nav-focus', label: 'Today’s focus', group: 'Go', run: () => navigate('/tasks?focus=today') },
      { id: 'nav-suggestions', label: 'Go to Suggestions', group: 'Go', run: () => navigate('/suggestions') },
      { id: 'nav-tools', label: 'Go to Tools', group: 'Go', run: () => navigate('/tools') },
    ]
    const toolItems: Item[] = allTools.map((t) => ({
      id: `tool-${t.key}`,
      label: t.name,
      hint: t.kind === 'external' ? 'Tool ↗' : 'Tool',
      group: 'Tools',
      run: () => launchTool(t, navigate),
    }))

    if (!query) {
      out.push(...nav, ...toolItems)
      tasks.slice(0, 6).forEach((t) =>
        out.push({ id: `task-${t.id}`, label: t.title, hint: 'Task', group: 'Recent tasks', run: () => openTask(t.id) }),
      )
      return out
    }

    tasks
      .filter((t) => t.title.toLowerCase().includes(query))
      .slice(0, 8)
      .forEach((t) =>
        out.push({ id: `task-${t.id}`, label: t.title, hint: 'Task', group: 'Tasks', run: () => openTask(t.id) }),
      )
    areas
      .filter((a) => a.name.toLowerCase().includes(query))
      .forEach((a) =>
        out.push({ id: `area-${a.id}`, label: a.name, hint: 'Area', group: 'Areas', run: () => navigate(`/tasks?area=${a.id}`) }),
      )
    projects
      .filter((p) => p.name.toLowerCase().includes(query))
      .forEach((p) =>
        out.push({ id: `proj-${p.id}`, label: p.name, hint: 'Project', group: 'Projects', run: () => navigate(`/tasks?project=${p.id}`) }),
      )
    toolItems.filter((t) => t.label.toLowerCase().includes(query)).forEach((t) => out.push(t))
    nav.filter((n) => n.label.toLowerCase().includes(query)).forEach((n) => out.push(n))
    out.push({
      id: 'create',
      label: `Create task “${q.trim()}”`,
      group: 'Actions',
      run: () => {
        void addTask({ title: q.trim() })
      },
    })
    return out
  }, [query, q, tasks, areas, projects, allTools, navigate, openTask])

  useEffect(() => {
    setActive(0)
  }, [query])

  function activate(i: number) {
    const it = items[i]
    if (!it) return
    it.run()
    setOpen(false)
    setQ('')
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              activate(active)
            }
          }}
          placeholder="Search tasks, areas, projects, tools… or type to create"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-ink-faint">No matches</li>
          )}
          {items.map((it, i) => {
            const showGroup = i === 0 || items[i - 1].group !== it.group
            return (
              <li key={it.id}>
                {showGroup && (
                  <div className="px-4 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                    {it.group}
                  </div>
                )}
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => activate(i)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                    i === active ? 'bg-surface-sunken text-ink' : 'text-ink-soft'
                  }`}
                >
                  <span className="truncate">{it.label}</span>
                  {it.hint && <span className="shrink-0 font-mono text-[10px] text-ink-faint">{it.hint}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
