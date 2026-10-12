import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  apiGenieApp,
  apiGenieAsk,
  apiGenieConversation,
  apiGenieConversations,
  apiGenieDeleteConversation,
  apiGenieStatus,
  type GenieAskResult,
  type GenieConversationSummary,
  type McpToolResult, type GenieSource,
  type GenieTable,
} from '../../lib/api'
import { linkify } from '../../lib/linkify'
import EmptyState from '../../components/EmptyState'
import { SparkIcon } from '../../components/icons'
import GenieView from './GenieView'

interface Turn {
  id: number
  question: string
  // Set once the answer lands; absent while a turn is in flight.
  result?: GenieAskResult
  error?: string
  // Rendered by the Genie MCP App iframe (GenieView) rather than from `result`.
  view?: boolean
  // Set when reopening a stored conversation: the original view_ask result.
  replay?: McpToolResult
}

/**
 * Genie One — ask a natural-language question over whatever Unity-Catalog-
 * governed data you can see, via the Databricks-hosted Genie One MCP. No
 * space to pick: Genie One is governed metastore-wide, so this is just a
 * chat box. Ephemeral — the conversation lives in this tab only; refresh and
 * it's gone (it isn't synced to PGlite/Electric like the rest of the app).
 */
export default function Genie() {
  const [status, setStatus] = useState<{ configured: boolean; host: string } | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  // HTML of the Genie MCP App view. null until loaded; stays null if the
  // server can't provide it, in which case turns fall back to the text path.
  const [appHtml, setAppHtml] = useState<string | null>(null)
  const [conversations, setConversations] = useState<GenieConversationSummary[]>([])
  const [activeCid, setActiveCid] = useState<string | null>(null)
  const conversationId = useRef<string | null>(null)
  const nextId = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiGenieStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, host: '' }))
  }, [])

  // In-flight load of the view, so a question submitted before it lands waits
  // for it instead of racing into the text fallback.
  const appReq = useRef<Promise<string | null> | null>(null)
  useEffect(() => {
    appReq.current = apiGenieApp()
      .then((a) => a.html)
      .catch(() => null)
    appReq.current.then(setAppHtml)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const q = question.trim()
    if (!q || busy) return
    setQuestion('')
    const id = nextId.current++
    const html = appHtml ?? (await appReq.current)
    if (html) {
      // The view asks + polls on its own; busy clears once the turn has a
      // conversation id (see onStarted below) so follow-ups thread correctly.
      setTurns((ts) => [...ts, { id, question: q, view: true }])
      setBusy(true)
      return
    }
    setTurns((ts) => [...ts, { id, question: q }])
    setBusy(true)
    try {
      const result = await apiGenieAsk(q, conversationId.current)
      conversationId.current = result.conversation_id
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, result } : t)))
    } catch (err) {
      setTurns((ts) =>
        ts.map((t) => (t.id === id ? { ...t, error: err instanceof Error ? err.message : String(err) } : t)),
      )
    } finally {
      setBusy(false)
    }
  }

  function refreshConversations() {
    apiGenieConversations()
      .then(setConversations)
      .catch(() => {})
  }
  useEffect(refreshConversations, [])

  function newConversation() {
    conversationId.current = null
    setActiveCid(null)
    setBusy(false)
    setTurns([])
  }

  async function openConversation(cid: string) {
    if (cid === activeCid) return
    try {
      const conv = await apiGenieConversation(cid)
      conversationId.current = cid
      setActiveCid(cid)
      setBusy(false)
      setTurns(conv.turns.map((t) => ({ id: nextId.current++, question: t.question, view: true, replay: t.result })))
    } catch {
      refreshConversations()
    }
  }

  async function removeConversation(cid: string) {
    await apiGenieDeleteConversation(cid).catch(() => {})
    if (cid === activeCid) newConversation()
    refreshConversations()
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <ConversationList
        items={conversations}
        activeId={activeCid}
        onOpen={openConversation}
        onDelete={removeConversation}
      />
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Genie</h1>
          <p className="mt-1 max-w-prose text-sm text-ink-soft">
            Ask a natural-language question over whatever Unity Catalog data you can see — via the
            Databricks-hosted Genie One MCP.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={newConversation}
            className="shrink-0 rounded-md border border-line px-2.5 py-1 text-sm text-ink-soft hover:text-ink"
          >
            New conversation
          </button>
        )}
      </header>

      {status && !status.configured ? (
        <EmptyState
          icon={<SparkIcon />}
          title="Genie isn't configured"
          hint="Set GENIE_HOST (and log in with the Databricks CLI) in the repo-root .env, then restart the backend."
        />
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-2">
            {turns.length === 0 && (
              <EmptyState
                icon={<SparkIcon />}
                title="Ask Genie anything"
                hint="e.g. “How many open P0 tasks do I have this week?”"
              />
            )}
            {turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                appHtml={appHtml}
                conversationId={conversationId.current}
                onStarted={(cid) => {
                  if (cid) {
                    conversationId.current = cid
                    setActiveCid(cid)
                    refreshConversations()
                  }
                  setBusy(false)
                }}
              />
            ))}
            <div ref={bottomRef} />
          </div>

          <form
            onSubmit={submit}
            className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-line-strong"
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question about your data…"
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
              aria-label="Ask Genie"
            />
            <button
              type="submit"
              disabled={!question.trim() || busy}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
            >
              {busy ? 'Asking…' : 'Ask'}
            </button>
          </form>
        </>
      )}
      </div>
    </div>
  )
}

function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString()
}

function ConversationList({
  items,
  activeId,
  onOpen,
  onDelete,
}: {
  items: GenieConversationSummary[]
  activeId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col md:flex" aria-label="Past conversations">
      <h2 className="mb-2 px-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">Conversations</h2>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {items.length === 0 && <p className="px-1 text-xs text-ink-faint">Nothing yet — your questions will be listed here.</p>}
        {items.map((c) => (
          <div
            key={c.conversation_id}
            className={`group flex items-start gap-1 rounded-md px-2 py-1.5 ${
              c.conversation_id === activeId ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'
            }`}
          >
            <button type="button" onClick={() => onOpen(c.conversation_id)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm text-ink">{c.title}</div>
              <div className="text-[11px] text-ink-faint">
                {relativeTime(c.updated_at)} · {c.turn_count} {c.turn_count === 1 ? 'turn' : 'turns'}
              </div>
            </button>
            <button
              type="button"
              onClick={() => onDelete(c.conversation_id)}
              aria-label={`Delete conversation ${c.title}`}
              className="shrink-0 rounded px-1 text-ink-faint opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}

function TurnView({
  turn,
  appHtml,
  conversationId,
  onStarted,
}: {
  turn: Turn
  appHtml: string | null
  conversationId: string | null
  onStarted: (conversationId: string | null) => void
}) {
  if (turn.view && appHtml) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink">{turn.question}</div>
        </div>
        <GenieView
          html={appHtml}
          question={turn.question}
          conversationId={conversationId}
          replay={turn.replay}
          onStarted={onStarted}
        />
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink">{turn.question}</div>
      </div>
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
          {turn.error ? (
            <span className="text-danger">Genie couldn’t answer that: {turn.error}</span>
          ) : !turn.result ? (
            <span className="text-ink-faint">Thinking…</span>
          ) : (
            <GenieAnswer result={turn.result} />
          )}
        </div>
      </div>
    </div>
  )
}

function GenieAnswer({ result }: { result: GenieAskResult }) {
  const pending = !['completed'].includes(result.status.toLowerCase())
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap leading-relaxed">
        {result.text ? linkify(result.text) : pending ? 'Still working — try asking again in a moment.' : '(no answer text)'}
      </p>
      {result.table && <GenieResultTable table={result.table} />}
      {result.sources.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {result.sources.map((s, i) => (
            <SourceLink key={i} source={s} />
          ))}
        </div>
      )}
      {pending && (
        <div className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{result.status}</div>
      )}
    </div>
  )
}

function SourceLink({ source }: { source: GenieSource }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-soft hover:border-line-strong hover:text-ink"
    >
      {source.title || 'source'} ↗
    </a>
  )
}

function GenieResultTable({ table }: { table: GenieTable }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-surface-sunken text-ink-faint">
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} className="px-2 py-1 font-mono font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono text-ink">
          {table.rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((v, j) => (
                <td key={j} className="px-2 py-1">
                  {v === null || v === undefined ? '' : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
