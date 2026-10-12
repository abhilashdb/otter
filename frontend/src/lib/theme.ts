/** Theme control: 'system' follows the OS; 'light'/'dark' force a mode.
 *  Applied by toggling data-theme on <html> (see tokens.css). Persisted per-browser. */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'otter-theme'

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage may be unavailable (private window) */
  }
  return 'system'
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* ignore */
  }
}
