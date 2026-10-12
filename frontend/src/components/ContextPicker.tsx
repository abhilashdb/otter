import { useMemo, useState } from 'react'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { AREA_KINDS, addArea, type AreaRow } from '../db/areas'
import { addProject, type ProjectRow } from '../db/projects'

export interface Selection {
  areaId: string | null
  projectId: string | null
}

interface Props {
  value: Selection
  onChange: (s: Selection) => void
  mode?: 'filter' | 'assign'
  className?: string
  /** When set, restrict the list (and inline-create) to areas of this kind. */
  kindScope?: string | null
}

/** Compact searchable picker for an Area (+ optional Project), with inline create.
 *  Scales by typing rather than by a growing sidebar. */
export default function ContextPicker({
  value,
  onChange,
  mode = 'assign',
  className = '',
  kindScope = null,
}: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const areas =
    useLiveQuery<AreaRow>(`SELECT * FROM areas WHERE deleted_at IS NULL ORDER BY kind, sort_order, name`)
      ?.rows ?? []
  const projects =
    useLiveQuery<ProjectRow>(`SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY sort_order, name`)
      ?.rows ?? []

  const areaById = useMemo(
    () => Object.fromEntries(areas.map((a) => [a.id, a])),
    [areas],
  ) as Record<string, AreaRow>

  const label = (() => {
    if (value.projectId) {
      const p = projects.find((x) => x.id === value.projectId)
      if (!p) return 'Project'
      const a = p.area_id ? areaById[p.area_id] : undefined
      return `${a ? a.name + ' / ' : ''}${p.name}`
    }
    if (value.areaId) return areaById[value.areaId]?.name ?? 'Area'
    return mode === 'filter' ? 'All areas' : 'Unfiled'
  })()

  const query = q.trim().toLowerCase()
  const pool = kindScope ? areas.filter((a) => a.kind === kindScope) : areas
  const listedAreas = pool.filter(
    (a) =>
      !query ||
      a.name.toLowerCase().includes(query) ||
      projects.some((p) => p.area_id === a.id && p.name.toLowerCase().includes(query)),
  )
  const exactArea = pool.some((a) => a.name.toLowerCase() === query)

  function close() {
    setOpen(false)
    setQ('')
  }
  function pick(s: Selection) {
    onChange(s)
    close()
  }
  async function createArea(kind: string) {
    const name = q.trim()
    if (!name) return
    pick({ areaId: await addArea({ name, kind }), projectId: null })
  }
  async function createProject(areaId: string) {
    const name = q.trim()
    if (!name) return
    pick({ areaId, projectId: await addProject({ name, areaId }) })
  }

  const rowCls =
    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-sunken'

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-sm text-ink-soft hover:text-ink"
      >
        <span className="truncate">{label}</span>
        <span className="text-ink-faint">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} aria-hidden />
          <div className="absolute left-0 z-20 mt-1 w-72 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter or type to create…"
              className="w-full border-b border-line bg-transparent px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <div className="max-h-72 overflow-y-auto py-1">
              <button className={rowCls} onClick={() => pick({ areaId: null, projectId: null })}>
                <span className="text-ink">{mode === 'filter' ? 'All areas' : 'Unfiled'}</span>
              </button>

              {listedAreas.map((a) => {
                const aProjects = projects.filter((p) => p.area_id === a.id)
                const showCreateProject =
                  !!query &&
                  (a.name.toLowerCase().includes(query) || value.areaId === a.id) &&
                  !aProjects.some((p) => p.name.toLowerCase() === query)
                return (
                  <div key={a.id}>
                    <button className={rowCls} onClick={() => pick({ areaId: a.id, projectId: null })}>
                      <span className="truncate text-ink">{a.name}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                        {a.kind}
                      </span>
                    </button>
                    {aProjects.map((p) => (
                      <button
                        key={p.id}
                        className={`${rowCls} pl-6`}
                        onClick={() => pick({ areaId: a.id, projectId: p.id })}
                      >
                        <span className="truncate text-ink-soft">{p.name}</span>
                      </button>
                    ))}
                    {showCreateProject && (
                      <button
                        className={`${rowCls} pl-6 text-accent`}
                        onClick={() => createProject(a.id)}
                      >
                        ＋ Project “{q.trim()}”
                      </button>
                    )}
                  </div>
                )
              })}

              {query && !exactArea && (
                <div className="mt-1 border-t border-line px-3 pb-1 pt-2">
                  {kindScope ? (
                    <button
                      onClick={() => createArea(kindScope)}
                      className="text-xs text-accent hover:underline"
                    >
                      ＋ Create “{q.trim()}”
                    </button>
                  ) : (
                    <>
                      <div className="pb-1 text-xs text-ink-faint">Create area “{q.trim()}” as</div>
                      <div className="flex flex-wrap gap-1">
                        {AREA_KINDS.map((k) => (
                          <button
                            key={k.kind}
                            onClick={() => createArea(k.kind)}
                            className="rounded border border-line px-2 py-0.5 text-xs text-ink-soft hover:border-accent hover:text-ink"
                          >
                            {k.label.replace(/s$/, '')}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
