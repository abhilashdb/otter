/**
 * Per-device tool-launch tracking, for the "Most used" section on Overview.
 *
 * Usage counts are intentionally *local* (localStorage, this browser only) —
 * they're a soft ranking signal, not synced data. Native tools (from the
 * registry) and external tools (link-outs) are counted the same way under a
 * namespaced key so the two rank together.
 *
 * Reactive via useSyncExternalStore: recording a launch notifies subscribers so
 * an open "Most used" list re-ranks immediately.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'otter-tool-usage'

export interface ToolUse {
  count: number
  last: number // epoch ms of the most recent launch
}
export type UsageMap = Record<string, ToolUse>

/** Stable key so native + external tools share one ranking namespace. */
export function toolKey(kind: 'native' | 'external', id: string): string {
  return `${kind}:${id}`
}

const EMPTY: UsageMap = {}
let cache: UsageMap = EMPTY
let cacheRaw: string | null = null
const listeners = new Set<() => void>()

function read(): UsageMap {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return EMPTY // storage blocked (private window etc.) — degrade to no history
  }
  if (raw === cacheRaw) return cache // unchanged → same object identity for React
  cacheRaw = raw
  if (!raw) {
    cache = EMPTY
    return cache
  }
  try {
    const parsed = JSON.parse(raw)
    cache = parsed && typeof parsed === 'object' ? (parsed as UsageMap) : EMPTY
  } catch {
    cache = EMPTY
  }
  return cache
}

/** Record one launch of a tool (by its namespaced key). */
export function recordToolLaunch(key: string) {
  const map = { ...read() }
  const prev = map[key]
  map[key] = { count: (prev?.count ?? 0) + 1, last: Date.now() }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* storage blocked — ranking just won't persist this launch */
  }
  cacheRaw = null // force re-read on next snapshot
  read()
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  // Sync ranking across tabs on this device.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cacheRaw = null
      cb()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

/** Reactive read of the usage map. */
export function useToolUsage(): UsageMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}
