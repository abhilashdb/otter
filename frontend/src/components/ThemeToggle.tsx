import { useState } from 'react'
import { applyTheme, getStoredTheme, type Theme } from '../lib/theme'

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme)

  function choose(t: Theme) {
    setTheme(t)
    applyTheme(t)
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5"
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => choose(o.value)}
          aria-pressed={theme === o.value}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            theme === o.value
              ? 'bg-surface-sunken text-ink'
              : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
