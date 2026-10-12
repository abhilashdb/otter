import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { AREA_KINDS, addArea, removeArea, renameArea, setAreaColor, type AreaRow } from '../db/areas'
import { addProject, removeProject, renameProject, type ProjectRow } from '../db/projects'
import { LinkIcon, NotepadIcon, PencilIcon, TrashIcon } from '../components/icons'
import { type TaskRow } from '../db/tasks'
import { dateKey, todayKey } from '../lib/dates'
import { useConfirm } from '../components/ConfirmProvider'
import { launchTool, useAllTools, type UnifiedTool } from '../tools/useTools'
import { useToolUsage } from '../lib/toolUsage'
import LakehouseBuilder from '../components/LakehouseBuilder'
import CalendarPanel from '../components/CalendarPanel'

function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(`otter-ov-collapse:${key}`) === '1'
  } catch {
    return false
  }
}
function saveCollapsed(key: string, v: boolean) {
  try {
    localStorage.setItem(`otter-ov-collapse:${key}`, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export default function Overview() {
  const areas =
    useLiveQuery<AreaRow>(`SELECT * FROM areas WHERE deleted_at IS NULL ORDER BY sort_order, name`)
      ?.rows ?? []
  const projects =
    useLiveQuery<ProjectRow>(`SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY sort_order, name`)
      ?.rows ?? []
  const tasks =
    useLiveQuery<TaskRow>(
      `SELECT id, title, status, priority, due_at, area_id, project_id FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL`,
    )?.rows ?? []

  const t0 = todayKey()
  const open = tasks.filter((t) => t.status !== 'done')
  const dueToday = open.filter((t) => dateKey(t.due_at) === t0)
  const overdue = open.filter((t) => {
    const k = dateKey(t.due_at)
    return k !== '' && k < t0
  })
  const openInArea = (id: string | null) => open.filter((t) => (t.area_id ?? null) === id).length
  const openInProject = (id: string) => open.filter((t) => t.project_id === id).length
  const unfiled = openInArea(null)

  return (
    <div className="lg:flex lg:items-start lg:gap-8">
      <div className="min-w-0 lg:flex-1">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Overview</h1>

      <LakehouseBuilder />

      <div className="mb-10 grid grid-cols-3 gap-6">
        <Stat label="Open" value={open.length} to="/tasks" />
        <Stat label="Due today" value={dueToday.length} to="/tasks?focus=today" />
        <Stat
          label="Overdue"
          value={overdue.length}
          tone={overdue.length ? 'danger' : undefined}
          to="/tasks?focus=overdue"
        />
      </div>

      <MostUsedTools />

      <div className="mb-4 border-t border-line pt-6">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Areas &amp; projects
        </h2>
      </div>

      <div className="grid items-start gap-x-8 gap-y-6 md:grid-cols-2 lg:grid-cols-3">
        {AREA_KINDS.map((k) => {
          const singular = k.label.replace(/s$/, '').toLowerCase()
          return (
            <AreaSection
              key={k.kind}
              title={k.label}
              addPlaceholder={`New ${singular}…`}
              areas={areas.filter((a) => a.kind === k.kind)}
              projects={projects}
              openInArea={openInArea}
              openInProject={openInProject}
              onAddArea={(name) => addArea({ name, kind: k.kind })}
            />
          )
        })}
      </div>

      {unfiled > 0 && (
        <section className="border-t border-line pt-4">
          <Link
            to="/tasks?area=none"
            className="text-sm text-ink-soft underline-offset-4 hover:text-ink hover:underline"
          >
            {unfiled} task{unfiled === 1 ? '' : 's'} with no area →
          </Link>
        </section>
      )}
      </div>
      <aside className="mt-10 lg:mt-0 lg:w-80 lg:shrink-0 xl:w-96">
        <CalendarPanel />
      </aside>
    </div>
  )
}

/** Top 5 most-launched tools (native + external) for this device. Hidden until
 *  at least one tool has been launched, so it never shows an empty shell. */
function MostUsedTools() {
  const navigate = useNavigate()
  const tools = useAllTools()
  const usage = useToolUsage()

  const ranked = useMemo(() => {
    return tools
      .map((t) => ({ tool: t, use: usage[t.key] }))
      .filter((r) => r.use && r.use.count > 0)
      .sort((a, b) => b.use!.count - a.use!.count || b.use!.last - a.use!.last)
      .slice(0, 5)
  }, [tools, usage])

  if (ranked.length === 0) return null

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Most used tools
        </h2>
        <Link to="/tools" className="text-xs text-ink-faint underline-offset-4 hover:text-ink hover:underline">
          All tools →
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ranked.map(({ tool, use }) => (
          <MostUsedTile
            key={tool.key}
            tool={tool}
            count={use!.count}
            onLaunch={() => launchTool(tool, navigate)}
          />
        ))}
      </div>
    </section>
  )
}

function MostUsedTile({
  tool,
  count,
  onLaunch,
}: {
  tool: UnifiedTool
  count: number
  onLaunch: () => void
}) {
  return (
    <button
      type="button"
      onClick={onLaunch}
      className="group flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 text-left transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-sm"
    >
      <span className="flex min-w-0 items-center gap-2">
        {tool.kind === 'external' && <LinkIcon size={13} />}
        <span className="truncate text-sm font-medium text-ink">{tool.name}</span>
        {tool.kind === 'external' && (
          <span className="shrink-0 text-ink-faint transition-colors group-hover:text-accent" aria-hidden>
            ↗
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        {count} launch{count === 1 ? '' : 'es'}
      </span>
    </button>
  )
}

function AreaSection({
  title,
  addPlaceholder,
  areas,
  projects,
  openInArea,
  openInProject,
  onAddArea,
}: {
  title: string
  addPlaceholder: string
  areas: AreaRow[]
  projects: ProjectRow[]
  openInArea: (id: string | null) => number
  openInProject: (id: string) => number
  onAddArea: (name: string) => void | Promise<unknown>
}) {
  const confirm = useConfirm()
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(title))
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            const v = !collapsed
            setCollapsed(v)
            saveCollapsed(title, v)
          }}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-ink-faint hover:text-ink"
        >
          <span className="font-mono text-[10px] leading-none">{collapsed ? '▸' : '▾'}</span>
          <span className="font-mono text-xs uppercase tracking-[0.15em]">{title}</span>
        </button>
        <span className="font-mono text-[10px] text-ink-faint">{areas.length}</span>
        <InlineAdd label="＋ Add" placeholder={addPlaceholder} onAdd={onAddArea} />
      </div>

      {!collapsed &&
        (areas.length === 0 ? (
          <p className="text-sm text-ink-faint">None yet.</p>
        ) : (
        <div className="border-t border-line">
          {areas.map((a) => {
            const aProjects = projects.filter((p) => p.area_id === a.id)
            return (
              <div key={a.id} className="border-b border-line py-4">
                <EditableRow
                  level="area"
                  name={a.name}
                  to={`/tasks?area=${a.id}`}
                  count={openInArea(a.id)}
                  color={a.color}
                  onColor={(hex) => setAreaColor(a.id, hex)}
                  detailTo={`/areas/${a.id}`}
                  onRename={(n) => renameArea(a.id, n)}
                  onDelete={async () => {
                    if (
                      await confirm({
                        title: 'Delete area',
                        message: `Delete “${a.name}”? Its projects are removed and its tasks move to Unfiled.`,
                        confirmLabel: 'Delete',
                        danger: true,
                      })
                    )
                      removeArea(a.id)
                  }}
                />

                {aProjects.length > 0 && (
                  <div className="mt-2 space-y-1.5 pl-4">
                    {aProjects.map((p) => (
                      <EditableRow
                        key={p.id}
                        level="project"
                        name={p.name}
                        to={`/tasks?project=${p.id}`}
                        count={openInProject(p.id)}
                        detailTo={`/projects/${p.id}`}
                        onRename={(n) => renameProject(p.id, n)}
                        onDelete={async () => {
                          if (
                            await confirm({
                              title: 'Delete project',
                              message: `Delete project “${p.name}”? Its tasks stay but lose the project.`,
                              confirmLabel: 'Delete',
                              danger: true,
                            })
                          )
                            removeProject(p.id)
                        }}
                      />
                    ))}
                  </div>
                )}

                <div className="mt-2 pl-4">
                  <InlineAdd
                    label="＋ Add project"
                    placeholder="Project name…"
                    onAdd={(name) => addProject({ name, areaId: a.id })}
                  />
                </div>
              </div>
            )
          })}
        </div>
        ))}
    </section>
  )
}

function EditableRow({
  level,
  name,
  to,
  count,
  color,
  onColor,
  detailTo,
  onRename,
  onDelete,
}: {
  level: 'area' | 'project'
  name: string
  to: string
  count: number
  color?: string | null
  onColor?: (hex: string | null) => void
  detailTo: string
  onRename: (n: string) => void | Promise<unknown>
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(name)

  async function save() {
    setEditing(false)
    const n = val.trim()
    if (n && n !== name) await onRename(n)
    else setVal(name)
  }

  const nameCls = level === 'area' ? 'text-base font-medium text-ink' : 'text-sm text-ink-soft'
  const countCls = level === 'area' ? 'text-xs' : 'text-[10px]'

  return (
    <div className="group flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {onColor && <ColorSwatch color={color ?? null} onChange={onColor} />}
        {editing ? (
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                setEditing(false)
                setVal(name)
              }
            }}
            onBlur={save}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-0.5 text-sm text-ink"
          />
        ) : (
          <>
            <Link to={to} className={`truncate underline-offset-4 hover:underline ${nameCls}`}>
              {name}
            </Link>
            <Link
              to={detailTo}
              aria-label="Notes & links"
              className="shrink-0 text-ink-faint transition hover:text-ink"
            >
              <NotepadIcon size={13} />
            </Link>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`font-mono text-ink-faint ${countCls}`}>
          {count}
          {level === 'area' ? ' open' : ''}
        </span>
        {!editing && (
          <span className="flex items-center gap-2.5 text-ink-faint opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              aria-label="Rename"
              onClick={() => {
                setVal(name)
                setEditing(true)
              }}
              className="hover:text-ink"
            >
              <PencilIcon size={13} />
            </button>
            <button type="button" aria-label="Delete" onClick={onDelete} className="hover:text-danger">
              <TrashIcon size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function ColorSwatch({ color, onChange }: { color: string | null; onChange: (hex: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState(color ?? '')

  function commit() {
    const raw = val.trim()
    if (raw === '') {
      onChange(null)
      setOpen(false)
      return
    }
    const hex = raw.startsWith('#') ? raw : `#${raw}`
    if (HEX_RE.test(hex)) {
      onChange(hex)
      setOpen(false)
    }
  }

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setVal(color ?? '')
          setOpen((o) => !o)
        }}
        aria-label="Set color"
        className="block h-3.5 w-3.5 rounded-full border border-line-strong"
        style={color ? { backgroundColor: color } : undefined}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 z-20 mt-1.5 flex items-center gap-1.5 rounded-md border border-line bg-surface p-2 shadow-lg">
            <input
              type="color"
              value={HEX_RE.test(val) && val.length === 7 ? val : '#3b82f6'}
              onChange={(e) => {
                setVal(e.target.value)
                onChange(e.target.value)
              }}
              className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
              aria-label="Pick color"
            />
            <input
              autoFocus
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder="#3b82f6"
              className="w-24 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs text-ink"
            />
            <button
              type="button"
              onClick={commit}
              className="rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-ink"
            >
              set
            </button>
            {color && (
              <button
                type="button"
                onClick={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className="text-xs text-ink-faint hover:text-danger"
              >
                clear
              </button>
            )}
          </div>
        </>
      )}
    </span>
  )
}

function Stat({
  label,
  value,
  tone,
  to,
}: {
  label: string
  value: number
  tone?: 'danger'
  to: string
}) {
  return (
    <Link
      to={to}
      className="-m-1 block rounded-md p-1 transition-colors hover:bg-surface-sunken"
    >
      <div className={`text-3xl font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>
        {value}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
    </Link>
  )
}

function InlineAdd({
  label,
  placeholder,
  onAdd,
}: {
  label: string
  placeholder: string
  onAdd: (name: string) => void | Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  async function submit() {
    const n = name.trim()
    if (!n) return
    setName('')
    setOpen(false)
    await onAdd(n)
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-ink-faint hover:text-ink">
        {label}
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setOpen(false)
            setName('')
          }
        }}
        placeholder={placeholder}
        className="w-44 rounded-md border border-line bg-surface px-2.5 py-1 text-sm text-ink placeholder:text-ink-faint"
      />
      <button
        type="button"
        onClick={submit}
        className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-accent-ink"
      >
        Add
      </button>
    </span>
  )
}
