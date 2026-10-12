import { useEffect, useRef, useState } from 'react'

/**
 * Interactive otter whose pupils follow the cursor. Same face as the logo mark,
 * but with a light sclera + a dark pupil that tracks the mouse. Honors
 * prefers-reduced-motion (pupils stay centered). Set text color on the parent.
 */
export default function OtterWatcher({ className = '' }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const [off, setOff] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) return

    let raf = 0
    const MAX = 1.4 // pupil travel, in viewBox units (keeps it inside the sclera)

    function onMove(e: MouseEvent) {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height * 0.48 // eyes sit a touch above center
        const dx = e.clientX - cx
        const dy = e.clientY - cy
        const dist = Math.hypot(dx, dy) || 1
        const reach = Math.min(1, dist / 220) * MAX
        setOff({ x: (dx / dist) * reach, y: (dy / dist) * reach })
      })
    }

    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <svg ref={ref} viewBox="0 0 64 64" className={className} role="img" aria-label="Otter">
      {/* ears */}
      <circle cx="19" cy="15" r="7.5" fill="currentColor" />
      <circle cx="45" cy="15" r="7.5" fill="currentColor" />
      <circle cx="19" cy="15" r="3" fill="var(--surface)" />
      <circle cx="45" cy="15" r="3" fill="var(--surface)" />
      {/* head + light muzzle */}
      <ellipse cx="32" cy="33" rx="20" ry="19" fill="currentColor" />
      <ellipse cx="32" cy="40" rx="14" ry="12.5" fill="var(--surface)" />
      {/* whiskers */}
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.65" fill="none">
        <path d="M26 40 L14.5 38.5" />
        <path d="M26 42 L14.5 43" />
        <path d="M38 40 L49.5 38.5" />
        <path d="M38 42 L49.5 43" />
      </g>
      {/* eyes: sclera fixed, pupils follow the cursor */}
      <circle cx="24.5" cy="31" r="3.4" fill="var(--surface)" stroke="currentColor" strokeWidth="0.8" />
      <circle cx="39.5" cy="31" r="3.4" fill="var(--surface)" stroke="currentColor" strokeWidth="0.8" />
      <g transform={`translate(${off.x} ${off.y})`}>
        <circle cx="24.5" cy="31" r="1.9" fill="currentColor" />
        <circle cx="39.5" cy="31" r="1.9" fill="currentColor" />
      </g>
      {/* nose + mouth */}
      <ellipse cx="32" cy="38" rx="3" ry="2.3" fill="currentColor" />
      <path
        d="M32 40.3 v1.8 M32 42.1 q -3 2.1 -5.4 -0.2 M32 42.1 q 3 2.1 5.4 -0.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
