/**
 * A small diorama for the Overview: an otter assembling a brick lakehouse.
 *
 * Bricks drop into place bottom-up (staggered via a per-brick `--d` delay),
 * then the roof / door / windows fade in; the otter bobs, the flag waves, and
 * the lake shimmers forever. All motion lives behind
 * `prefers-reduced-motion: no-preference` in index.css — the static base state
 * is the finished lakehouse, so reduced-motion viewers just see it built.
 *
 * Pure SVG + CSS, no dependency. Colors come from the design tokens so it works
 * in both themes. It replays on every visit because the Overview's content
 * wrapper is keyed by route (see AppShell).
 */

// Brick wall geometry (SVG user units; viewBox is 340×150).
const COLS = 5
const ROWS = 5
const BW = 22
const BH = 10
const STEPX = 24
const STEPY = 12
const WALL_X = 150
const WALL_TOP = 66
const GROUND = 124
const CLIP_W = 94 // visible wall width (bricks overflow this and are clipped)

interface Brick {
  x: number
  y: number
  d: number // animation delay (ms)
}

const BRICKS: Brick[] = (() => {
  const out: Brick[] = []
  for (let r = 0; r < ROWS; r++) {
    // r = 0 is the bottom row (laid first). Odd rows shift half a brick for a
    // running-bond pattern; the wall group is clipped so half-bricks look clean.
    const startX = WALL_X - (r % 2 ? STEPX / 2 : 0)
    const y = GROUND - BH - r * STEPY
    for (let c = 0; c < COLS; c++) {
      out.push({ x: startX + c * STEPX, y, d: 250 + (r * COLS + c) * 95 })
    }
  }
  return out
})()

// Roughly when the last brick has settled — the roof and trim follow.
const AFTER_WALL = 250 + ROWS * COLS * 95

/** A repeating wavelet polyline wider than the viewBox, so a -24 drift loops
 *  seamlessly. */
function wavePath(y: number): string {
  let d = `M -24 ${y} q 6 -5 12 0`
  for (let x = -12; x < 352; x += 12) d += ` t 12 0`
  return d
}

export default function LakehouseBuilder() {
  return (
    <div className="relative mb-10 flex items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-sunken/60">
      <span className="pointer-events-none absolute left-4 top-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
        Building your lakehouse
      </span>
      <svg
        viewBox="0 0 340 150"
        className="block h-40 w-auto max-w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="An otter building a brick lakehouse by a lake"
      >
        <defs>
          <clipPath id="lh-wall">
            <rect x={WALL_X} y={WALL_TOP} width={CLIP_W} height={GROUND - WALL_TOP} rx={2} />
          </clipPath>
        </defs>

        {/* Lake */}
        <rect x="0" y={GROUND} width="340" height={150 - GROUND} fill="var(--accent)" opacity="0.1" />
        <line x1="0" x2="340" y1={GROUND} y2={GROUND} stroke="var(--line-strong)" strokeWidth="1" />
        <path
          className="lh-wave"
          d={wavePath(131)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          opacity="0.38"
        />
        <path
          className="lh-wave"
          d={wavePath(138)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          opacity="0.22"
        />

        {/* Brick wall (running bond, clipped to the wall bounds) */}
        <g clipPath="url(#lh-wall)">
          {BRICKS.map((b, i) => (
            <rect
              key={i}
              className="lh-brick"
              style={{ '--d': `${b.d}ms` } as React.CSSProperties}
              x={b.x}
              y={b.y}
              width={BW}
              height={BH}
              rx="1.5"
              fill="var(--ink-soft)"
            />
          ))}
        </g>

        {/* Windows + door (fade in after the wall) */}
        <g className="lh-late" style={{ '--d': `${AFTER_WALL + 120}ms` } as React.CSSProperties}>
          <rect x="159" y="82" width="13" height="13" rx="1.5" fill="var(--accent)" opacity="0.9" />
          <rect x="222" y="82" width="13" height="13" rx="1.5" fill="var(--accent)" opacity="0.9" />
          <rect x="186" y="98" width="22" height={GROUND - 98} rx="2" fill="var(--ink)" />
          <circle cx="203" cy="112" r="1.6" fill="var(--accent)" />
        </g>

        {/* Roof + chimney + flag */}
        <g className="lh-late" style={{ '--d': `${AFTER_WALL}ms` } as React.CSSProperties}>
          <polygon points="140,68 197,34 254,68" fill="var(--accent)" />
          <rect x="226" y="44" width="8" height="16" rx="1" fill="var(--ink-soft)" />
          <line x1="197" y1="35" x2="197" y2="22" stroke="var(--ink)" strokeWidth="1.5" />
          <path className="lh-flag" d="M197 23 L211 26 L197 30 Z" fill="var(--accent)" />
        </g>

        {/* Spare bricks waiting to be laid */}
        <g>
          <rect x="112" y="115" width="18" height="8" rx="1.5" fill="var(--ink-soft)" opacity="0.7" />
          <rect x="118" y="106" width="18" height="8" rx="1.5" fill="var(--ink-soft)" opacity="0.7" />
        </g>

        {/* The otter (bobs gently), carrying a fresh brick */}
        <g className="lh-otter">
          <ellipse cx="86" cy="126" rx="20" ry="3" fill="var(--ink)" opacity="0.08" />
          {/* tail */}
          <path
            d="M100 116 q18 3 22 -8"
            fill="none"
            stroke="var(--ink)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          {/* feet */}
          <ellipse cx="79" cy="123" rx="5" ry="3" fill="var(--ink)" />
          <ellipse cx="93" cy="123" rx="5" ry="3" fill="var(--ink)" />
          {/* body + belly */}
          <ellipse cx="86" cy="100" rx="16" ry="22" fill="var(--ink)" />
          <ellipse cx="86" cy="104" rx="8.5" ry="13" fill="var(--surface)" />
          {/* carried brick + paws */}
          <rect x="76" y="97" width="20" height="9" rx="1.5" fill="var(--accent)" />
          <circle cx="77" cy="101" r="3" fill="var(--ink)" />
          <circle cx="95" cy="101" r="3" fill="var(--ink)" />
          {/* head */}
          <circle cx="86" cy="74" r="12" fill="var(--ink)" />
          <circle cx="77" cy="64" r="3.5" fill="var(--ink)" />
          <circle cx="95" cy="64" r="3.5" fill="var(--ink)" />
          <ellipse cx="86" cy="79" rx="6" ry="4.5" fill="var(--surface)" />
          <circle cx="86" cy="76" r="1.6" fill="var(--ink)" />
          <circle cx="81" cy="71" r="1.7" fill="var(--surface)" />
          <circle cx="91" cy="71" r="1.7" fill="var(--surface)" />
        </g>
      </svg>
    </div>
  )
}
