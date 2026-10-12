/**
 * The unified tool list: built-in ("native") tools from the registry plus the
 * user's external link-out tools (synced from `ext_tools`). One shape so the
 * Tools page, the Overview "Most used" section, and the ⌘K palette all treat
 * them the same. Launch tracking (per-device) runs through `launchTool`.
 */
import { useMemo } from 'react'
import { useLiveQuery } from '@electric-sql/pglite-react'
import type { NavigateFunction } from 'react-router-dom'
import { TOOLS } from './registry'
import { type ExtToolRow } from '../db/tools'
import { recordToolLaunch, toolKey } from '../lib/toolUsage'

export interface UnifiedTool {
  key: string // namespaced usage key (see toolKey)
  kind: 'native' | 'external'
  id: string
  name: string
  description?: string
  to?: string // native: in-app route
  url?: string // external: launch target
  embed?: boolean // external: open in an in-app iframe instead of a new tab
}

const NATIVE_TOOLS: UnifiedTool[] = TOOLS.map((t) => ({
  key: toolKey('native', t.id),
  kind: 'native',
  id: t.id,
  name: t.name,
  description: t.description,
  to: `/tools/${t.id}`,
}))

/** Prepend https:// when the user omitted a scheme, so it launches as a real URL. */
export function normalizeToolUrl(raw: string): string {
  const url = raw.trim()
  if (!url) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
}

/** Live external tools, in display order. */
export function useExtTools(): ExtToolRow[] {
  return (
    useLiveQuery<ExtToolRow>(
      `SELECT * FROM ext_tools WHERE deleted_at IS NULL ORDER BY sort_order, name`,
    )?.rows ?? []
  )
}

/** Native + external tools as one list (native first, then external by order). */
export function useAllTools(): UnifiedTool[] {
  const ext = useExtTools()
  return useMemo(
    () => [
      ...NATIVE_TOOLS,
      ...ext.map<UnifiedTool>((t) => ({
        key: toolKey('external', t.id),
        kind: 'external',
        id: t.id,
        name: t.name,
        description: t.description || undefined,
        url: t.url,
        embed: t.embed,
      })),
    ],
    [ext],
  )
}

/**
 * Record a launch, then open the tool: an embeddable external tool opens in the
 * in-app iframe viewer, a plain external tool in a new tab, a native tool routes
 * to its in-app page.
 */
export function launchTool(tool: UnifiedTool, navigate: NavigateFunction) {
  recordToolLaunch(tool.key)
  if (tool.kind === 'external') {
    if (tool.embed) {
      navigate(`/tools/ext/${tool.id}`)
      return
    }
    const url = normalizeToolUrl(tool.url ?? '')
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  } else if (tool.to) {
    navigate(tool.to)
  }
}
