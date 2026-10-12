/**
 * The Otter mark — "Ink" variant. Monochrome: the head/eyes take `currentColor`
 * (so set text color on the parent), the light muzzle uses the surface token, so
 * it themes automatically in light and dark.
 */
export default function OtterMark({
  className = '',
  title = 'Otter',
}: {
  className?: string
  title?: string
}) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label={title}>
      {/* ears */}
      <circle cx="19" cy="15" r="7.5" fill="currentColor" />
      <circle cx="45" cy="15" r="7.5" fill="currentColor" />
      <circle cx="19" cy="15" r="3" fill="var(--surface)" />
      <circle cx="45" cy="15" r="3" fill="var(--surface)" />
      {/* head */}
      <ellipse cx="32" cy="33" rx="20" ry="19" fill="currentColor" />
      {/* light muzzle / face */}
      <ellipse cx="32" cy="40" rx="14" ry="12.5" fill="var(--surface)" />
      {/* whiskers */}
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.65" fill="none">
        <path d="M26 40 L14.5 38.5" />
        <path d="M26 42 L14.5 43" />
        <path d="M38 40 L49.5 38.5" />
        <path d="M38 42 L49.5 43" />
      </g>
      {/* eyes */}
      <circle cx="24.5" cy="31" r="2.9" fill="currentColor" />
      <circle cx="39.5" cy="31" r="2.9" fill="currentColor" />
      <circle cx="25.4" cy="30.1" r="0.9" fill="var(--surface)" />
      <circle cx="40.4" cy="30.1" r="0.9" fill="var(--surface)" />
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
