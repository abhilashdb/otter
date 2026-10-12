import { useEffect, useRef, useState } from 'react'
import { apiGenieViewCall, type McpToolResult } from '../../lib/api'

/**
 * Host for the Genie One MCP App (the interactive view Databricks renders in
 * its own UI: collapsed thinking steps / SQL, charts, tables). The server
 * hands us an HTML page; we run it in a sandboxed iframe and speak the MCP
 * Apps host protocol — JSON-RPC 2.0 over postMessage — by hand (it's small,
 * and this avoids a dependency):
 *
 *   view → host  ui/initialize (req), ui/notifications/initialized,
 *                tools/call (req, proxied to the backend), ui/open-link (req),
 *                ui/notifications/size-changed, ping, ui/message, ...
 *   host → view  ui/notifications/tool-input, ui/notifications/tool-result
 *
 * The iframe is sandboxed WITHOUT allow-same-origin (opaque origin — it can't
 * touch our page, storage or cookies) and the backend injects a CSP <meta>
 * from the resource's declared domains, so the third-party-authored page can
 * only load scripts/styles from Databricks hosts.
 */
export default function GenieView({
  html,
  question,
  conversationId,
  replay,
  onStarted,
}: {
  html: string
  question: string
  conversationId: string | null
  // A past turn's stored view_ask result: skip asking and hand it straight to
  // the view, which re-fetches the answer from Databricks.
  replay?: McpToolResult
  // Fired once view_ask has returned (with the conversation id, if any).
  onStarted: (conversationId: string | null) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const [error, setError] = useState<string | null>(null)
  // Captured once: props may change (conversationId advances) after mount.
  const init = useRef<{
    question: string
    conversationId: string | null
    replay?: McpToolResult
    onStarted: (c: string | null) => void
    started?: Promise<McpToolResult>
  }>({ question, conversationId, replay, onStarted })

  useEffect(() => {
    const { question, conversationId, replay, onStarted } = init.current
    const args: Record<string, unknown> = { question }
    if (conversationId) args.conversation_id = conversationId
    // Kick off the turn immediately; the view's tool-result is sent once it
    // has finished initializing AND this call has returned. Memoized in the
    // ref so a StrictMode double-mount doesn't ask Genie twice.
    if (replay && !init.current.started) init.current.started = Promise.resolve(replay)
    if (!init.current.started) {
      init.current.started = apiGenieViewCall('view_ask', args)
      init.current.started.then(
        (res) => onStarted((res.structuredContent?.conversation_id as string | undefined) ?? null),
        (err) => {
          setError(err instanceof Error ? err.message : String(err))
          onStarted(null)
        },
      )
    }
    const started = init.current.started

    const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, '*')
    const reply = (id: unknown, result: unknown) => post({ jsonrpc: '2.0', id, result })
    const fail = (id: unknown, code: number, message: string) =>
      post({ jsonrpc: '2.0', id, error: { code, message } })

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const hostContext = {
      theme: dark ? 'dark' : 'light',
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      platform: 'web',
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      containerDimensions: { width: frame.current?.clientWidth ?? 800, maxHeight: 4000 },
      toolInfo: { tool: { name: 'view_ask', inputSchema: { type: 'object' } } },
    }

    async function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return
      const isRequest = m.id !== undefined

      switch (m.method) {
        case 'ui/initialize':
          reply(m.id, {
            protocolVersion: m.params?.protocolVersion,
            hostInfo: { name: 'otter', version: '0.1.0' },
            hostCapabilities: { serverTools: {}, openLinks: {} },
            hostContext,
          })
          break
        case 'ui/notifications/initialized':
          post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } })
          try {
            const result = await started
            post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result })
          } catch {
            /* surfaced via `error` above */
          }
          break
        case 'tools/call':
          try {
            reply(m.id, await apiGenieViewCall(String(m.params?.name), m.params?.arguments ?? {}))
          } catch (err) {
            fail(m.id, -32000, err instanceof Error ? err.message : String(err))
          }
          break
        case 'ui/open-link': {
          const url = String(m.params?.url ?? '')
          if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
          reply(m.id, {})
          break
        }
        case 'ui/notifications/size-changed':
          if (typeof m.params?.height === 'number') setHeight(Math.min(Math.max(m.params.height, 60), 4000))
          break
        case 'ui/request-display-mode':
          reply(m.id, { mode: 'inline' })
          break
        case 'ping':
        case 'ui/message':
          if (isRequest) reply(m.id, {})
          break
        default:
          if (isRequest) fail(m.id, -32601, `Method not found: ${m.method}`)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (error) {
    return (
      <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-danger">
        Genie couldn’t answer that: {error}
      </div>
    )
  }
  return (
    <iframe
      ref={frame}
      title="Genie"
      srcDoc={html}
      sandbox="allow-scripts allow-forms"
      style={{ height }}
      className="w-full rounded-lg border border-line bg-surface"
    />
  )
}
