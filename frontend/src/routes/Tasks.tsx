import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLiveQuery } from '@electric-sql/pglite-react'
import {
  addTask,
  assignTask,
  removeTask,
  setDue,
  setPriority,
  setStatus,
  type TaskRow,
} from '../db/tasks'
import { AREA_KINDS, type AreaRow } from '../db/areas'
import { type ProjectRow } from '../db/projects'
import ContextPicker, { type Selection } from '../components/ContextPicker'
import { useOpenTask } from '../components/TaskDrawerProvider'
import KindMark from '../components/KindMark'
import EmptyState from '../components/EmptyState'
import { InboxIcon } from '../components/icons'
import { useConfirm } from '../components/ConfirmProvider'
import { dateKey, endOfWeek, formatDate, isoFromInput, todayKey } from '../lib/dates'

/** A delete handler that asks first (in-app dialog), consistent with Overview. */
function useDeleteTask() {
  const confirm = useConfirm()
  return async (task: TaskRow) => {
    if (
      await confirm({
        title: 'Delete task',
        message: `Delete “${task.title}”? This can’t be undone — to just hide it, open the task and Archive it instead.`,
        confirmLabel: 'Delete',
        danger: true,
      })
    )
      await removeTask(task.id)
  }
}

const PRIORITIES = ['p0', 'p1', 'p2', 'p3']

const COLUMNS: { status: string; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
]

type View = 'board' | 'list'
// Board is the default view. The key is versioned (:v2) so an older saved
// "list" preference is dropped once — board becomes the effective default
// again, while any *new* explicit toggle still persists under the v2 key.
const VIEW_KEY = 'otter-tasks-view:v2'
function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    if (v === 'board' || v === 'list') return v
  } catch {
    /* ignore */
  }
  return 'board'
}

type Filter =
  | { kind: 'all' }
  | { kind: 'unfiled' }
  | { kind: 'kind'; areaKind: string }
  | { kind: 'due'; due: 'today' | 'overdue' }
  | { kind: 'area'; areaId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'archived' }

export default function Tasks() {
  const [params, setParams] = useSearchParams()
  const [title, setTitle] = useState('')
  const [addPriority, setAddPriority] = useState('p2')
  const [addDue, setAddDue] = useState<string | null>(null)
  const [view, setView] = useState<View>(loadView)
  const [addTarget, setAddTarget] = useState<Selection>({ areaId: null, projectId: null })
  const openTask = useOpenTask()

  // Sustain the active filter across navigations (e.g. opening a task's detail
  // page and returning, or coming back via the nav). The filter lives in the URL
  // query; we mirror it to sessionStorage and, when we land on /tasks with no
  // query, restore the last one. Captured at first render so the save effect
  // below can't clobber it before we read it. An explicit "Clear" writes an empty
  // string, so a deliberately-cleared view stays cleared.
  const search = params.toString()
  const savedFilter = useRef<string | null>(null)
  if (savedFilter.current === null) {
    try {
      savedFilter.current = sessionStorage.getItem('otter-tasks-filter') ?? ''
    } catch {
      savedFilter.current = ''
    }
  }
  useEffect(() => {
    try {
      sessionStorage.setItem('otter-tasks-filter', search)
    } catch {
      /* storage unavailable — filter just won't persist */
    }
  }, [search])
  useEffect(() => {
    if (!search && savedFilter.current) {
      setParams(new URLSearchParams(savedFilter.current), { replace: true })
    }
    // Restore once, on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  function chooseView(v: View) {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }

  const areas =
    useLiveQuery<AreaRow>(`SELECT * FROM areas WHERE deleted_at IS NULL`)?.rows ?? []
  const projects =
    useLiveQuery<ProjectRow>(`SELECT * FROM projects WHERE deleted_at IS NULL`)?.rows ?? []

  // Derive the filter from the URL (so Overview links deep-link into a view).
  const areaParam = params.get('area')
  const projectParam = params.get('project')
  const kindParam = params.get('kind')
  const dueParam = params.get('due')
  const archivedParam = params.get('archived')
  const filter: Filter = archivedParam === '1'
    ? { kind: 'archived' }
    : projectParam
      ? { kind: 'project', projectId: projectParam }
      : areaParam === 'none'
        ? { kind: 'unfiled' }
        : areaParam
          ? { kind: 'area', areaId: areaParam }
          : kindParam
            ? { kind: 'kind', areaKind: kindParam }
            : dueParam === 'today' || dueParam === 'overdue'
              ? { kind: 'due', due: dueParam }
              : { kind: 'all' }

  // Build the live query for the active filter.
  let where = 'deleted_at IS NULL'
  const qp: unknown[] = []
  if (filter.kind === 'unfiled') where += ' AND area_id IS NULL'
  else if (filter.kind === 'area') {
    qp.push(filter.areaId)
    where += ` AND area_id = $${qp.length}`
  } else if (filter.kind === 'project') {
    qp.push(filter.projectId)
    where += ` AND project_id = $${qp.length}`
  } else if (filter.kind === 'kind') {
    qp.push(filter.areaKind)
    where += ` AND area_id IN (SELECT id FROM areas WHERE kind = $${qp.length} AND deleted_at IS NULL)`
  }
  // Archived tasks are hidden everywhere except the archive view.
  where += filter.kind === 'archived' ? ' AND archived_at IS NOT NULL' : ' AND archived_at IS NULL'
  // Order: open before done, then by priority (p0→p3 sort ascending), then oldest
  // first within a priority. Drives both the list and the kanban columns.
  const rows =
    useLiveQuery<TaskRow>(
      `SELECT * FROM tasks WHERE ${where} ORDER BY (status = 'done'), priority, sort_order, created_at`,
      qp,
    )?.rows ?? []
  // "Due" filters are date-relative, so apply them client-side (timezone-consistent).
  const dueFiltered =
    filter.kind === 'due'
      ? rows.filter((t) => {
          if (t.status === 'done') return false
          const k = dateKey(t.due_at)
          if (!k) return false
          return filter.due === 'today' ? k === todayKey() : k < todayKey()
        })
      : rows

  // Focus horizon: an additive filter (combines with kind/area). A horizon quick
  // pick (today / this week / next 2 weeks) or custom date keeps open, dated tasks
  // due on or before it — always including anything overdue. "Overdue" is a
  // special pick that keeps ONLY past-due open tasks.
  const focusParam = params.get('focus')
  const overdueOnly = focusParam === 'overdue'
  const horizonKey = overdueOnly ? null : focusHorizon(focusParam)
  const horizonFiltered = overdueOnly
    ? dueFiltered.filter((t) => {
        if (t.status === 'done') return false
        const k = dateKey(t.due_at)
        return k !== '' && k < todayKey()
      })
    : horizonKey
      ? dueFiltered.filter((t) => {
          if (t.status === 'done') return false
          const k = dateKey(t.due_at)
          return k !== '' && k <= horizonKey
        })
      : dueFiltered

  // Priority filter: an additive, multi-select filter over P0–P3.
  const prioParam = params.get('prio')
  const prioSet = prioParam
    ? new Set(prioParam.split(',').filter((p) => PRIORITIES.includes(p)))
    : null
  const tasks =
    prioSet && prioSet.size
      ? horizonFiltered.filter((t) => prioSet.has(t.priority))
      : horizonFiltered
  const openCount = tasks.filter((t) => t.status !== 'done').length

  // Empty state, tuned to why the view is empty (fresh vs filtered vs archived).
  const isFiltered = filter.kind !== 'all' || !!focusParam || !!(prioSet && prioSet.size)
  const emptyEl = (
    <EmptyState
      icon={<InboxIcon />}
      title={
        filter.kind === 'archived'
          ? 'No archived tasks'
          : isFiltered
            ? 'Nothing in this view'
            : 'No tasks yet'
      }
      hint={
        filter.kind === 'archived'
          ? 'Tasks you archive from their detail page show up here.'
          : isFiltered
            ? 'No tasks match the current filter.'
            : 'Add one above, capture with your macOS hotkey, or accept a suggestion.'
      }
    >
      {isFiltered && (
        <button
          onClick={() => setParams(new URLSearchParams())}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
        >
          Clear filter
        </button>
      )}
    </EmptyState>
  )

  const projById = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects],
  ) as Record<string, ProjectRow>
  const areaById = useMemo(
    () => Object.fromEntries(areas.map((a) => [a.id, a])),
    [areas],
  ) as Record<string, AreaRow>

  // Picker value + change handler for the filter bar.
  const filterValue: Selection =
    filter.kind === 'project'
      ? { areaId: projById[filter.projectId]?.area_id ?? null, projectId: filter.projectId }
      : filter.kind === 'area'
        ? { areaId: filter.areaId, projectId: null }
        : { areaId: null, projectId: null }

  function onFilterChange(sel: Selection) {
    const p = new URLSearchParams()
    if (sel.projectId) p.set('project', sel.projectId)
    else if (sel.areaId) p.set('area', sel.areaId)
    setParams(p)
  }

  function chooseKind(k: string | null) {
    const p = new URLSearchParams()
    if (k) p.set('kind', k)
    if (focusParam) p.set('focus', focusParam) // keep the focus horizon when switching kinds
    if (prioParam) p.set('prio', prioParam) // …and the priority filter
    setParams(p)
  }

  function chooseFocus(f: string | null) {
    const p = new URLSearchParams(params) // additive — preserve the active kind/area filter
    if (f) p.set('focus', f)
    else p.delete('focus')
    setParams(p)
  }

  function choosePriority(next: string[]) {
    const p = new URLSearchParams(params) // additive
    if (next.length) p.set('prio', next.join(','))
    else p.delete('prio')
    setParams(p)
  }

  // The add composer defaults its target to the active filter, but stays editable
  // (so a kind-filtered or unfiled add can still be pointed at a specific area/project).
  useEffect(() => {
    setAddTarget({ areaId: filterValue.areaId, projectId: filterValue.projectId })
  }, [filterValue.areaId, filterValue.projectId])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    const priority = addPriority
    const dueAt = addDue
    setTitle('')
    setAddPriority('p2')
    setAddDue(null)
    await addTask({ title: t, priority, dueAt, areaId: addTarget.areaId, projectId: addTarget.projectId })
  }

  // Group by area in the "all" and kind-filtered views; a focus horizon flattens
  // to a single focused list instead.
  const grouped = (filter.kind === 'all' || filter.kind === 'kind') && !horizonKey && !overdueOnly
  const groups = useMemo(() => {
    if (!grouped) return null
    const byArea = new Map<string | null, TaskRow[]>()
    for (const t of tasks) {
      const k = t.area_id ?? null
      if (!byArea.has(k)) byArea.set(k, [])
      byArea.get(k)!.push(t)
    }
    const named = [...byArea.entries()]
      .filter(([k]) => k !== null)
      .map(([k, ts]) => ({ id: k as string, name: areaById[k as string]?.name ?? 'Area', tasks: ts }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const unfiled = byArea.get(null)
    if (unfiled) named.push({ id: '__none__', name: 'Unfiled', tasks: unfiled })
    return named
  }, [grouped, tasks, areaById])

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Tasks</h1>
        <span className="font-mono text-xs text-ink-faint">{openCount} open</span>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <KindTabs
          active={filter.kind === 'kind' ? filter.areaKind : filter.kind === 'all' ? null : '__x__'}
          onChange={chooseKind}
        />
        <DueFilter active={focusParam} onChange={chooseFocus} />
        <PriorityFilter selected={prioSet ?? new Set<string>()} onChange={choosePriority} />
        <ContextPicker
          mode="filter"
          value={filterValue}
          onChange={onFilterChange}
          kindScope={filter.kind === 'kind' ? filter.areaKind : null}
        />
        {(filter.kind !== 'all' || focusParam || (prioSet && prioSet.size)) && (
          <button
            onClick={() => setParams(new URLSearchParams())}
            className="text-xs text-ink-faint hover:text-ink"
          >
            clear
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() =>
              setParams(filter.kind === 'archived' ? new URLSearchParams() : new URLSearchParams({ archived: '1' }))
            }
            aria-pressed={filter.kind === 'archived'}
            className={`text-xs ${filter.kind === 'archived' ? 'text-ink' : 'text-ink-faint hover:text-ink'}`}
          >
            {filter.kind === 'archived' ? '← Back to tasks' : 'Archived'}
          </button>
          <ViewToggle view={view} onChange={chooseView} />
        </div>
      </div>

      {filter.kind === 'archived' && (
        <p className="mb-5 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
          Showing archived tasks. Open one (↗ icon) to unarchive it.
        </p>
      )}

      {filter.kind !== 'archived' && (
      <form
        onSubmit={submit}
        className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-line-strong"
      >
        <span className="select-none text-base leading-none text-ink-faint" aria-hidden>
          ＋
        </span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task…"
          className="min-w-[10rem] flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          aria-label="New task"
        />
        <select
          value={addPriority}
          onChange={(e) => setAddPriority(e.target.value)}
          aria-label="Priority"
          className="shrink-0 rounded-md border border-line bg-surface px-1.5 py-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.toUpperCase()}
            </option>
          ))}
        </select>
        <DueButton value={dateKey(addDue)} onChange={setAddDue} />
        <ContextPicker
          mode="assign"
          value={addTarget}
          onChange={setAddTarget}
          kindScope={filter.kind === 'kind' ? filter.areaKind : null}
        />
        <button
          type="submit"
          disabled={!title.trim()}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
        >
          Add
        </button>
      </form>
      )}

      {tasks.length === 0 ? (
        emptyEl
      ) : view === 'board' ? (
        <Kanban tasks={tasks} areaById={areaById} projById={projById} onOpen={openTask} />
      ) : grouped && groups ? (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.id}>
              <h2 className="mb-2 font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                {g.name}
              </h2>
              <TaskList tasks={g.tasks} onOpen={openTask} showContext={false} />
            </div>
          ))}
        </div>
      ) : (
        <TaskList tasks={tasks} onOpen={openTask} showContext={true} />
      )}
    </div>
  )
}

function OpenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  )
}

function OpenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open task details"
      className="shrink-0 text-ink-faint transition hover:text-accent"
    >
      <OpenIcon />
    </button>
  )
}

function TaskList({
  tasks,
  onOpen,
  showContext,
}: {
  tasks: TaskRow[]
  onOpen: (id: string) => void
  showContext: boolean
}) {
  return (
    <ul className="divide-y divide-line border-t border-line">
      {tasks.map((t, i) => (
        <TaskItem key={t.id} task={t} index={i + 1} onOpen={onOpen} showContext={showContext} />
      ))}
    </ul>
  )
}

function TaskItem({
  task,
  index,
  onOpen,
  showContext,
}: {
  task: TaskRow
  index: number
  onOpen: (id: string) => void
  showContext: boolean
}) {
  const done = task.status === 'done'
  const deleteTask = useDeleteTask()
  return (
    <li className="group flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap">
      <span className="w-5 text-right font-mono text-xs text-ink-faint">
        {String(index).padStart(2, '0')}
      </span>
      <button
        type="button"
        onClick={() => setStatus(task.id, done ? 'todo' : 'done')}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border text-[10px] leading-none transition-colors ${
          done ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong text-transparent hover:border-accent'
        }`}
      >
        ✓
      </button>
      <span
        className={`min-w-[8rem] flex-1 truncate text-sm ${done ? 'text-ink-faint line-through' : 'text-ink'}`}
      >
        {task.title}
      </span>

      <OpenButton onClick={() => onOpen(task.id)} />
      <DueControl task={task} />

      {showContext && (
        <ContextPicker
          mode="assign"
          value={{ areaId: task.area_id, projectId: task.project_id }}
          onChange={(sel) => assignTask(task.id, sel)}
        />
      )}

      <select
        value={task.priority}
        onChange={(e) => setPriority(task.id, e.target.value)}
        aria-label="Priority"
        className="rounded-md border border-line bg-surface px-1.5 py-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft"
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p.toUpperCase()}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => deleteTask(task)}
        aria-label="Delete task"
        title="Delete task"
        className="text-sm text-ink-faint opacity-0 transition hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
      >
        ✕
      </button>
    </li>
  )
}

function DueControl({ task }: { task: TaskRow }) {
  const dateVal = dateKey(task.due_at)
  const overdue = !!dateVal && dateVal < todayKey() && task.status !== 'done'
  return <DueButton value={dateVal} onChange={(iso) => setDue(task.id, iso)} overdue={overdue} />
}

/**
 * A due-date button that opens the native date picker via a hidden overlaid input.
 * Presentational: takes a 'YYYY-MM-DD' value ('' = none) and reports back an ISO
 * string (or null when cleared). Shared by task rows and the add-task composer.
 */
function DueButton({
  value,
  onChange,
  overdue = false,
  bare = false,
}: {
  value: string
  onChange: (iso: string | null) => void
  overdue?: boolean
  /** Bare = no button chrome, just mono text — for dropping into a card's meta row. */
  bare?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const label = value ? (value === todayKey() ? 'Today' : formatDate(value)) : '＋ due'

  function open(e: ReactMouseEvent) {
    e.stopPropagation() // on a draggable kanban card, keep this a plain click
    const el = ref.current
    if (!el) return
    // showPicker() where supported; otherwise focusing still opens most native pickers.
    if (typeof el.showPicker === 'function') el.showPicker()
    else el.focus()
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={open}
        className={
          bare
            ? `uppercase hover:underline ${overdue ? 'text-danger' : value ? 'text-ink-faint' : 'text-ink-faint/70'}`
            : `rounded-md border border-line px-2 py-1 text-xs ${
                overdue ? 'border-danger text-danger' : value ? 'text-ink-soft' : 'text-ink-faint'
              }`
        }
      >
        {label}
      </button>
      <input
        ref={ref}
        type="date"
        value={value}
        onChange={(e) => onChange(isoFromInput(e.target.value))}
        className="pointer-events-none absolute inset-0 h-0 w-0 opacity-0"
        tabIndex={-1}
      />
    </span>
  )
}

function KindTabs({
  active,
  onChange,
}: {
  active: string | null
  onChange: (k: string | null) => void
}) {
  const tabs: { k: string | null; label: string }[] = [
    { k: null, label: 'All' },
    ...AREA_KINDS.map((x) => ({ k: x.kind, label: x.label })),
  ]
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5"
      role="group"
      aria-label="Filter by kind"
    >
      {tabs.map((t) => (
        <button
          key={t.label}
          type="button"
          onClick={() => onChange(t.k)}
          aria-pressed={active === t.k}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            active === t.k ? 'bg-surface-sunken text-ink' : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// Resolve a focus param to its horizon day key. Quick picks map to today / end
// of this week / end of next week; a raw 'YYYY-MM-DD' is a custom "on or before"
// date. ('next' is the legacy quick-pick key, kept so old links still resolve.)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function focusHorizon(f: string | null): string | null {
  if (!f) return null
  if (f === 'today') return todayKey()
  if (f === 'week') return endOfWeek(todayKey())
  if (f === 'next2' || f === 'next') return endOfWeek(todayKey(), 1)
  if (DATE_RE.test(f)) return f
  return null
}

// A compact filter button that opens a popover, closing on outside-click or Esc.
function FilterMenu({
  label,
  active,
  ariaLabel,
  children,
}: {
  label: ReactNode
  active: boolean
  ariaLabel: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          active ? 'border-accent text-ink' : 'border-line text-ink-faint hover:text-ink-soft'
        }`}
      >
        {label}
        <span aria-hidden className="text-[9px] text-ink-faint">
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-1.5 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children,
  selected,
  onClick,
}: {
  children: ReactNode
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
        selected ? 'bg-surface-sunken text-ink' : 'text-ink-soft hover:bg-surface-sunken hover:text-ink'
      }`}
    >
      {children}
      {selected && (
        <span className="text-accent" aria-hidden>
          ✓
        </span>
      )}
    </button>
  )
}

// Due-date focus: a calendar dropdown with quick picks plus a custom "on or
// before" date. The horizon always includes anything overdue.
function DueFilter({
  active,
  onChange,
}: {
  active: string | null
  onChange: (f: string | null) => void
}) {
  const quick = [
    { k: 'overdue', label: 'Overdue' },
    { k: 'today', label: 'Today' },
    { k: 'week', label: 'This week' },
    { k: 'next2', label: 'Next 2 weeks' },
  ]
  const isDate = !!active && DATE_RE.test(active)
  const label = !active
    ? 'Due'
    : isDate
      ? `Due by ${formatDate(active)}`
      : quick.find((q) => q.k === active)?.label ?? (active === 'next' ? 'Next 2 weeks' : 'Due')
  return (
    <FilterMenu label={label} active={!!active} ariaLabel="Filter by due date">
      {(close) => (
        <div className="space-y-0.5">
          {quick.map((q) => (
            <MenuItem
              key={q.k}
              selected={active === q.k || (q.k === 'next2' && active === 'next')}
              onClick={() => {
                onChange(q.k)
                close()
              }}
            >
              {q.label}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-line" />
          <label className="block px-2 py-1">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              On or before
            </span>
            <input
              type="date"
              value={isDate ? active! : ''}
              onChange={(e) => {
                if (e.target.value) {
                  onChange(e.target.value)
                  close()
                }
              }}
              className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
            />
          </label>
          {active && (
            <>
              <div className="my-1 border-t border-line" />
              <MenuItem
                onClick={() => {
                  onChange(null)
                  close()
                }}
              >
                Clear
              </MenuItem>
            </>
          )}
        </div>
      )}
    </FilterMenu>
  )
}

// Priority: an additive, multi-select filter over P0–P3.
function PriorityFilter({
  selected,
  onChange,
}: {
  selected: Set<string>
  onChange: (next: string[]) => void
}) {
  const label =
    selected.size === 0
      ? 'Priority'
      : `Priority · ${[...selected].sort().map((p) => p.toUpperCase()).join(', ')}`
  function toggle(p: string) {
    const next = new Set(selected)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    onChange([...next])
  }
  return (
    <FilterMenu label={label} active={selected.size > 0} ariaLabel="Filter by priority">
      {() => (
        <div className="space-y-0.5">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                selected.has(p) ? 'text-ink' : 'text-ink-soft hover:bg-surface-sunken hover:text-ink'
              }`}
            >
              <span
                className={`grid h-3.5 w-3.5 place-items-center rounded border text-[9px] leading-none ${
                  selected.has(p)
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line-strong text-transparent'
                }`}
              >
                ✓
              </span>
              <span className="font-mono uppercase tracking-wide">{p.toUpperCase()}</span>
            </button>
          ))}
          {selected.size > 0 && (
            <>
              <div className="my-1 border-t border-line" />
              <MenuItem onClick={() => onChange([])}>Clear</MenuItem>
            </>
          )}
        </div>
      )}
    </FilterMenu>
  )
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5"
      role="group"
      aria-label="View"
    >
      {(['board', 'list'] as View[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
            view === v ? 'bg-surface-sunken text-ink' : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

// Kanban: columns by status, drag a card to another column to change its status.
// (Drag needs a pointer — on touch, use the List view, which has full controls.)
function Kanban({
  tasks,
  areaById,
  projById,
  onOpen,
}: {
  tasks: TaskRow[]
  areaById: Record<string, AreaRow>
  projById: Record<string, ProjectRow>
  onOpen: (id: string) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {COLUMNS.map((col) => (
        <KanbanColumn
          key={col.status}
          col={col}
          tasks={tasks.filter((t) => (t.status || 'todo') === col.status)}
          areaById={areaById}
          projById={projById}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

function KanbanColumn({
  col,
  tasks,
  areaById,
  projById,
  onOpen,
}: {
  col: { status: string; label: string }
  tasks: TaskRow[]
  areaById: Record<string, AreaRow>
  projById: Record<string, ProjectRow>
  onOpen: (id: string) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const id = e.dataTransfer.getData('text/plain')
        if (id) setStatus(id, col.status)
      }}
      className={`rounded-lg border p-2.5 transition-colors ${
        over ? 'border-accent bg-accent-soft' : 'border-line bg-surface-sunken'
      }`}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">{col.label}</span>
        <span className="font-mono text-[11px] text-ink-faint">{tasks.length}</span>
      </div>
      <div className="min-h-[2.5rem] space-y-2">
        {tasks.map((t) => (
          <KanbanCard key={t.id} task={t} areaById={areaById} projById={projById} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}

function KanbanCard({
  task,
  areaById,
  projById,
  onOpen,
}: {
  task: TaskRow
  areaById: Record<string, AreaRow>
  projById: Record<string, ProjectRow>
  onOpen: (id: string) => void
}) {
  const done = task.status === 'done'
  const deleteTask = useDeleteTask()
  const key = dateKey(task.due_at)
  const overdue = key !== '' && key < todayKey() && !done
  const area = task.area_id ? areaById[task.area_id] : undefined
  // Only customers get a colored stripe; Internal/Personal are marked with an icon.
  const stripe = area?.kind === 'customer' ? area?.color ?? null : null
  const ctx = task.project_id ? projById[task.project_id]?.name : area?.name ?? null

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      style={stripe ? { borderLeftColor: stripe, borderLeftWidth: 3 } : undefined}
      className="group cursor-grab rounded-md border border-line bg-surface p-2.5 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          title={task.title}
          className={`line-clamp-2 min-w-0 break-words text-sm leading-snug ${
            done ? 'text-ink-faint line-through' : 'text-ink'
          }`}
        >
          {task.title}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <OpenButton onClick={() => onOpen(task.id)} />
          <button
            type="button"
            onClick={() => deleteTask(task)}
            aria-label="Delete task"
            title="Delete task"
            className="text-xs text-ink-faint opacity-0 transition hover:text-danger group-hover:opacity-100"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-ink-faint">
        <span className="uppercase">{task.priority}</span>
        <DueButton value={key} onChange={(iso) => setDue(task.id, iso)} overdue={overdue} bare />
        {ctx && (
          <span className="flex max-w-[11rem] items-center gap-1 truncate">
            <KindMark area={area} />
            {ctx}
          </span>
        )}
      </div>
    </div>
  )
}
