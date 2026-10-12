import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  danger?: boolean
}
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void }

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false)

/** In-app confirm dialog styled with the app tokens (replaces window.confirm).
 *  Usage: const confirm = useConfirm(); if (await confirm({ message })) { … } */
export function useConfirm() {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback(
    (o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })),
    [],
  )

  function close(ok: boolean) {
    pending?.resolve(ok)
    setPending(null)
  }

  useEffect(() => {
    if (!pending) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => close(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-sm rounded-xl border border-line bg-surface p-5 shadow-xl"
          >
            {pending.title && (
              <h2 className="mb-1 text-base font-semibold text-ink">{pending.title}</h2>
            )}
            <p className="text-sm leading-relaxed text-ink-soft">{pending.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(false)}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => close(true)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  pending.danger ? 'bg-danger text-danger-ink' : 'bg-accent text-accent-ink'
                }`}
              >
                {pending.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
