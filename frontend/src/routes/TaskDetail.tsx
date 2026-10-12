import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from '@electric-sql/pglite-react'
import {
  archiveTask,
  assignTask,
  removeTask,
  setDue,
  setPriority,
  setStatus,
  setTitle,
  unarchiveTask,
  type TaskRow,
} from '../db/tasks'
import { dateKey, isoFromInput } from '../lib/dates'
import ContextPicker from '../components/ContextPicker'
import NotesPanel from '../components/NotesPanel'
import LinksPanel from '../components/LinksPanel'
import { useConfirm } from '../components/ConfirmProvider'

const PRIORITIES = ['p0', 'p1', 'p2', 'p3']
const STATUSES = [
  { v: 'todo', label: 'To do' },
  { v: 'doing', label: 'Doing' },
  { v: 'done', label: 'Done' },
]
const selectCls = 'rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-soft'

export default function TaskDetail() {
  const { taskId } = useParams()
  const id = taskId ?? ''
  const res = useLiveQuery<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [id])
  const task = res?.rows?.[0]
  const navigate = useNavigate()
  const confirm = useConfirm()

  async function deleteTask() {
    if (!task) return
    if (
      await confirm({
        title: 'Delete task',
        message: `Delete “${task.title}”? This can’t be undone — to just hide it, Archive it instead.`,
        confirmLabel: 'Delete',
        danger: true,
      })
    ) {
      await removeTask(id)
      navigate('/tasks')
    }
  }

  // Hydrate the title draft once, when the task for this id first loads — NOT on
  // every change to the live query. Otherwise any background write to the tasks
  // table (Google sync, a suggestion scan, another optimistic edit) re-runs the
  // query and clobbers what the user is typing. Navigating to another task
  // (id change) re-hydrates.
  const [titleDraft, setTitleDraft] = useState('')
  const hydratedFor = useRef<string | null>(null)
  useEffect(() => {
    if (task && hydratedFor.current !== id) {
      setTitleDraft(task.title)
      hydratedFor.current = id
    }
  }, [id, task])

  // Auto-grow the title box to fit the whole title (usually 1–2 lines) so a long
  // title is fully visible, instead of being clipped to one scrolling line.
  const titleEl = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = titleEl.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [titleDraft])

  const backLink = (
    <Link to="/tasks" className="text-sm text-ink-faint underline-offset-4 hover:text-ink hover:underline">
      ← Tasks
    </Link>
  )

  if (res && !task) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="text-sm text-ink-faint">Task not found.</p>
      </div>
    )
  }

  function saveTitle() {
    const t = titleDraft.trim()
    if (t && task && t !== task.title) setTitle(id, t)
  }

  const archived = !!task?.archived_at

  return (
    <div className="space-y-5">
      {backLink}

      <textarea
        ref={titleEl}
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            saveTitle()
            e.currentTarget.blur()
          }
        }}
        rows={1}
        className="w-full resize-none overflow-hidden bg-transparent text-2xl font-semibold tracking-tight text-ink focus:outline-none"
        placeholder="Task title"
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-5">
        <select value={task?.status ?? 'todo'} onChange={(e) => setStatus(id, e.target.value)} className={selectCls} aria-label="Status">
          {STATUSES.map((s) => (
            <option key={s.v} value={s.v}>
              {s.label}
            </option>
          ))}
        </select>
        <select value={task?.priority ?? 'p2'} onChange={(e) => setPriority(id, e.target.value)} className={`${selectCls} font-mono uppercase`} aria-label="Priority">
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.toUpperCase()}
            </option>
          ))}
        </select>
        <input type="date" value={dateKey(task?.due_at)} onChange={(e) => setDue(id, isoFromInput(e.target.value))} className={selectCls} aria-label="Due date" />
        <ContextPicker
          mode="assign"
          value={{ areaId: task?.area_id ?? null, projectId: task?.project_id ?? null }}
          onChange={(sel) => assignTask(id, sel)}
        />
        <button
          onClick={() => (archived ? unarchiveTask(id) : archiveTask(id))}
          className="ml-auto rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:text-ink"
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          onClick={deleteTask}
          className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-danger hover:text-danger"
        >
          Delete
        </button>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <NotesPanel entityType="task" entityId={id} />
        <LinksPanel entityType="task" entityId={id} />
      </div>
    </div>
  )
}
