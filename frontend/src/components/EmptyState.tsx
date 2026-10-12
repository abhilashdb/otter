import { type ReactNode } from 'react'

/**
 * A calm, consistent empty state: a faint glyph, a title, an optional hint, and
 * room for a single action. Uses a soft dashed hairline so it reads as a
 * placeholder without competing with real content (Wama: airy, not boxed-in).
 */
export default function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center">
      {icon && (
        <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-surface-sunken text-ink-faint">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-sm text-ink-soft">{hint}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
