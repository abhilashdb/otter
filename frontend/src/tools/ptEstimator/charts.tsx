/**
 * Lightweight inline-SVG charts for the PT estimator. No charting dependency —
 * these draw to a fixed viewBox and scale responsively. Colors come from the
 * design tokens via `currentColor` + Tailwind text-* classes so both themes work.
 */
import { useState, type MouseEvent } from 'react'
import { fmtTokens, fmtUsd } from './calc'

const W = 640
const H = 200
const PAD = { top: 12, right: 12, bottom: 22, left: 46 }
const IW = W - PAD.left - PAD.right
const IH = H - PAD.top - PAD.bottom

/** Map a mouse event over the chart to the nearest data index (0..len-1), or
 *  null when the pointer is outside the plot area. Converts CSS pixels to the
 *  fixed viewBox via the rendered width, so it works at any responsive size. */
function hoverIndex(e: MouseEvent<SVGSVGElement>, len: number): number | null {
  if (len <= 0) return null
  const rect = e.currentTarget.getBoundingClientRect()
  if (rect.width === 0) return null
  const vbX = ((e.clientX - rect.left) / rect.width) * W
  const f = (vbX - PAD.left) / IW
  if (f < -0.03 || f > 1.03) return null
  return Math.round(Math.min(1, Math.max(0, f)) * (len - 1))
}

/** The time string for a hovered downsampled bin, sampled from the original
 *  (time-ordered) timestamps. null when the dataset has no timestamps. */
function timeAt(times: (number | null)[] | undefined, dsIdx: number, dsLen: number): string | null {
  if (!times || times.length < 2) return null
  const valid = times.filter((t): t is number => t != null && Number.isFinite(t))
  if (valid.length < 2) return null
  const f = dsLen <= 1 ? 0 : dsIdx / (dsLen - 1)
  const t = times[Math.round(f * (times.length - 1))]
  if (t == null || !Number.isFinite(t)) return null
  return fmtAxisTime(t, Math.max(1, valid[valid.length - 1] - valid[0]))
}

/** Small floating value box, clamped inside the plot so it never clips an edge. */
function TooltipBox({ x, lines }: { x: number; lines: string[] }) {
  const charW = 5.7
  const boxW = Math.max(46, ...lines.map((l) => l.length * charW)) + 12
  const lh = 12
  const boxH = lines.length * lh + 8
  const bx = Math.min(Math.max(PAD.left, x - boxW / 2), PAD.left + IW - boxW)
  const by = PAD.top + 2
  return (
    <g pointerEvents="none">
      <rect x={bx} y={by} width={boxW} height={boxH} rx={4} className="fill-surface stroke-line" strokeWidth={1} />
      {lines.map((l, i) => (
        <text key={i} x={bx + 6} y={by + 13 + i * lh} className="fill-ink text-[9px]">
          {l}
        </text>
      ))}
    </g>
  )
}

/** Downsample to at most `max` bins, keeping the peak in each bin so spikes
 *  (which drive bursts) stay visible. */
function downsample(values: number[], max = 600): number[] {
  if (values.length <= max) return values
  const binSize = values.length / max
  const out: number[] = []
  for (let i = 0; i < max; i++) {
    const start = Math.floor(i * binSize)
    const end = Math.min(values.length, Math.floor((i + 1) * binSize))
    let peak = -Infinity
    for (let j = start; j < end; j++) if (values[j] > peak) peak = values[j]
    out.push(peak === -Infinity ? 0 : peak)
  }
  return out
}

/** Format an epoch-ms tick for the x-axis, scaled to the window span. */
function fmtAxisTime(ms: number, spanMs: number): string {
  const d = new Date(ms)
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  if (spanMs <= 36 * 3600_000) return spanMs <= 12 * 3600_000 ? hm : `${md} ${hm}`
  return md
}

/** Bottom time axis: ~5 evenly-spaced tick labels sampled from the (time-ordered)
 *  point timestamps. Renders nothing when the dataset carries no timestamps. */
function XAxis({ times }: { times?: (number | null)[] }) {
  if (!times || times.length < 2) return null
  const valid = times.filter((t): t is number => t != null && Number.isFinite(t))
  if (valid.length < 2) return null
  const first = valid[0]
  const last = valid[valid.length - 1]
  const span = Math.max(1, last - first)
  const n = times.length
  const segs = 4
  const els: JSX.Element[] = []
  for (let i = 0; i <= segs; i++) {
    const f = i / segs
    const t = times[Math.round(f * (n - 1))]
    if (t == null || !Number.isFinite(t)) continue
    els.push(
      <text
        key={i}
        x={PAD.left + f * IW}
        y={H - 6}
        textAnchor={i === 0 ? 'start' : i === segs ? 'end' : 'middle'}
        className="fill-ink-faint text-[9px]"
      >
        {fmtAxisTime(t, span)}
      </text>,
    )
  }
  return <>{els}</>
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  // Fine steps so the axis hugs the data (e.g. a 30M peak → 35M, not 50M).
  const step =
    n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3
    : n <= 3.5 ? 3.5 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10
  return step * pow
}

/**
 * Usage over time, with optional PT-capacity and spike-cap reference lines.
 * The area above the capacity line (the burst) is shaded so it reads at a glance.
 */
export function UsageChart({
  values,
  capacity,
  cap,
  yLabel,
  fmtY = fmtTokens,
  times,
  migrated,
}: {
  values: number[]
  capacity?: number
  cap?: number
  yLabel: string
  fmtY?: (n: number) => string
  times?: (number | null)[]
  migrated?: number[] // per-index migrated-in portion of `values` (traffic migration)
}) {
  const [hi, setHi] = useState<number | null>(null)
  const data = downsample(values)
  // Migrated-in portion, aligned to the downsampled total and clamped so the
  // stacked band never pokes above the demand line.
  const migDs = migrated ? downsample(migrated) : null
  const hasMig = !!migDs && migDs.some((v) => v > 0)
  const migAt = (i: number) => (migDs ? Math.min(Math.max(0, migDs[i] ?? 0), data[i]) : 0)
  const baseAt = (i: number) => data[i] - migAt(i)
  // Base the axis on real demand + the reservation line, with a little headroom
  // so the peak doesn't touch the top edge. Include the spike cap only when it's
  // near demand (≤2× peak), so a high test-cap doesn't flatten everything.
  const dataMax = Math.max(1, ...data, capacity ?? 0)
  const includeCap = cap != null && cap <= dataMax * 2
  const top = niceMax((includeCap ? Math.max(dataMax, cap as number) : dataMax) * 1.05)
  const x = (i: number) => PAD.left + (data.length <= 1 ? 0 : (i / (data.length - 1)) * IW)
  const y = (v: number) => PAD.top + IH - (Math.min(v, top) / top) * IH

  const linePts = data.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const areaPts = `${PAD.left},${PAD.top + IH} ${linePts} ${PAD.left + IW},${PAD.top + IH}`
  // Stacked split (only when a blend is active): base area on the bottom, the
  // migrated-in band on top, so migrated traffic reads as its own color.
  const baseLinePts = data.map((_, i) => `${x(i)},${y(baseAt(i))}`)
  const baseAreaPts = `${PAD.left},${PAD.top + IH} ${baseLinePts.join(' ')} ${PAD.left + IW},${PAD.top + IH}`
  const migBandPts = `${linePts} ${[...baseLinePts].reverse().join(' ')}`

  // Burst polygon: the usage line clamped up to the capacity floor.
  let burstArea = ''
  if (capacity != null && capacity < top) {
    const yc = y(capacity)
    const pts = data.map((v, i) => `${x(i)},${Math.min(y(v), yc)}`)
    burstArea = `${pts.join(' ')} ${x(data.length - 1)},${yc} ${x(0)},${yc}`
  }

  const hv = hi != null && hi >= 0 && hi < data.length ? hi : null
  const hvTime = hv != null ? timeAt(times, hv, data.length) : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={yLabel}
        onMouseMove={(e) => setHi(hoverIndex(e, data.length))}
        onMouseLeave={() => setHi(null)}
      >
        {/* gridlines + y labels */}
        {[0, 0.5, 1].map((f) => {
          const gy = PAD.top + IH - f * IH
          return (
            <g key={f}>
              <line
                x1={PAD.left}
                x2={PAD.left + IW}
                y1={gy}
                y2={gy}
                className="text-line"
                stroke="currentColor"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={gy + 3}
                textAnchor="end"
                className="fill-ink-faint text-[9px]"
              >
                {fmtY(top * f)}
              </text>
            </g>
          )
        })}
        {/* usage area + line — split into base + migrated band when blending */}
        {hasMig ? (
          <>
            <polygon points={baseAreaPts} className="text-accent" fill="currentColor" opacity={0.12} />
            <polygon points={migBandPts} className="text-violet-500" fill="currentColor" opacity={0.3} />
            <polyline points={baseLinePts.join(' ')} fill="none" className="text-accent" stroke="currentColor" strokeWidth={1} opacity={0.6} />
          </>
        ) : (
          <polygon points={areaPts} className="text-accent" fill="currentColor" opacity={0.12} />
        )}
        <polyline
          points={linePts}
          fill="none"
          className={hasMig ? 'text-violet-500' : 'text-accent'}
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {/* burst shading */}
        {burstArea && (
          <polygon points={burstArea} className="text-danger" fill="currentColor" opacity={0.22} />
        )}
        {/* capacity line */}
        {capacity != null && capacity < top && (
          <line
            x1={PAD.left}
            x2={PAD.left + IW}
            y1={y(capacity)}
            y2={y(capacity)}
            className="text-ink"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeDasharray="4 3"
          />
        )}
        {/* cap line */}
        {cap != null && cap < top && (
          <line
            x1={PAD.left}
            x2={PAD.left + IW}
            y1={y(cap)}
            y2={y(cap)}
            className="text-danger"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        )}
        <XAxis times={times} />
        {/* hover guide + marker + value box */}
        {hv != null && (
          <g pointerEvents="none">
            <line x1={x(hv)} x2={x(hv)} y1={PAD.top} y2={PAD.top + IH} className="text-ink-faint" stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hv)} cy={y(data[hv])} r={3} className={hasMig ? 'fill-violet-500' : 'fill-accent'} />
            {hasMig && <circle cx={x(hv)} cy={y(baseAt(hv))} r={2.5} className="fill-accent" />}
            <TooltipBox
              x={x(hv)}
              lines={[
                ...(hvTime ? [hvTime] : []),
                ...(hasMig
                  ? [`total ${fmtY(data[hv])}`, `base ${fmtY(baseAt(hv))}`, `migrated ${fmtY(migAt(hv))}`]
                  : [fmtY(data[hv])]),
              ]}
            />
          </g>
        )}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <Legend swatch="bg-accent" label={hasMig ? 'Base traffic' : yLabel} />
        {hasMig && <Legend swatch="bg-violet-500" label="Migrated traffic" />}
        {capacity != null && <Legend swatch="border border-ink border-dashed" label="PT reservation" />}
        {burstArea && <Legend swatch="bg-danger/40" label="Burst / over-cap" />}
        {cap != null && <Legend swatch="border border-danger border-dashed" label="Burst ceiling (reservation + cap)" />}
      </figcaption>
    </figure>
  )
}

/** A single metric over time — a clean line+area with no capacity/burst overlays.
 *  Thin wrapper over UsageChart for series like requests/min. */
export function LineChart({
  values,
  yLabel,
  fmtY = fmtTokens,
  times,
}: {
  values: number[]
  yLabel: string
  fmtY?: (n: number) => string
  times?: (number | null)[]
}) {
  return <UsageChart values={values} yLabel={yLabel} fmtY={fmtY} times={times} />
}

/** Two labeled series on one axis (e.g. avg input vs output tokens/request). */
export function TwoLineChart({
  a,
  b,
  yLabel,
  fmtY = fmtTokens,
  times,
}: {
  a: { values: number[]; label: string; line: string; swatch: string }
  b: { values: number[]; label: string; line: string; swatch: string }
  yLabel: string
  fmtY?: (n: number) => string
  times?: (number | null)[]
}) {
  const [hi, setHi] = useState<number | null>(null)
  const da = downsample(a.values)
  const db = downsample(b.values)
  const len = Math.max(da.length, db.length)
  const top = niceMax(Math.max(1, ...da, ...db) * 1.05)
  const x = (i: number) => PAD.left + (len <= 1 ? 0 : (i / (len - 1)) * IW)
  const y = (v: number) => PAD.top + IH - (Math.min(v, top) / top) * IH
  const xy = (arr: number[]) => arr.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const hv = hi != null && hi >= 0 && hi < len ? hi : null
  const hvTime = hv != null ? timeAt(times, hv, len) : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={yLabel}
        onMouseMove={(e) => setHi(hoverIndex(e, len))}
        onMouseLeave={() => setHi(null)}
      >
        {[0, 0.5, 1].map((f) => {
          const gy = PAD.top + IH - f * IH
          return (
            <g key={f}>
              <line x1={PAD.left} x2={PAD.left + IW} y1={gy} y2={gy} className="text-line" stroke="currentColor" strokeWidth={1} />
              <text x={PAD.left - 6} y={gy + 3} textAnchor="end" className="fill-ink-faint text-[9px]">
                {fmtY(top * f)}
              </text>
            </g>
          )
        })}
        <polyline points={xy(da)} fill="none" className={a.line} stroke="currentColor" strokeWidth={1.5} />
        <polyline points={xy(db)} fill="none" className={b.line} stroke="currentColor" strokeWidth={1.5} />
        <XAxis times={times} />
        {hv != null && (
          <g pointerEvents="none">
            <line x1={x(hv)} x2={x(hv)} y1={PAD.top} y2={PAD.top + IH} className="text-ink-faint" stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" />
            {da[hv] != null && <circle cx={x(hv)} cy={y(da[hv])} r={3} className={a.line} fill="currentColor" />}
            {db[hv] != null && <circle cx={x(hv)} cy={y(db[hv])} r={3} className={b.line} fill="currentColor" />}
            <TooltipBox
              x={x(hv)}
              lines={[
                ...(hvTime ? [hvTime] : []),
                `${a.label}: ${fmtY(da[hv] ?? 0)}`,
                `${b.label}: ${fmtY(db[hv] ?? 0)}`,
              ]}
            />
          </g>
        )}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <Legend swatch={a.swatch} label={a.label} />
        <Legend swatch={b.swatch} label={b.label} />
      </figcaption>
    </figure>
  )
}

/** Total cost as the reserved baseline (MUs) sweeps from 0 (PPT-only) upward. */
export function SweepChart({
  points,
  recommendedMus,
  currentMus,
}: {
  points: { mus: number; total: number }[]
  recommendedMus: number
  currentMus?: number
}) {
  const [hi, setHi] = useState<number | null>(null)
  const maxMus = Math.max(...points.map((p) => p.mus), 1)
  const top = niceMax(Math.max(...points.map((p) => p.total), 1))
  const x = (mus: number) => PAD.left + (mus / maxMus) * IW
  const y = (v: number) => PAD.top + IH - (Math.min(v, top) / top) * IH
  if (points.length < 2) return null
  const linePts = points.map((p) => `${x(p.mus)},${y(p.total)}`).join(' ')
  // Nearest point to the pointer, matched by MU (points are spaced by MU, not evenly indexed).
  function nearest(e: MouseEvent<SVGSVGElement>): number | null {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return null
    const f = (((e.clientX - rect.left) / rect.width) * W - PAD.left) / IW
    if (f < -0.03 || f > 1.03) return null
    const target = Math.min(1, Math.max(0, f)) * maxMus
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].mus - target)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return bi
  }
  const hv = hi != null && hi >= 0 && hi < points.length ? hi : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Total cost vs reserved baseline"
        onMouseMove={(e) => setHi(nearest(e))}
        onMouseLeave={() => setHi(null)}
      >
        {[0, 0.5, 1].map((f) => {
          const gy = PAD.top + IH - f * IH
          return (
            <g key={f}>
              <line x1={PAD.left} x2={PAD.left + IW} y1={gy} y2={gy} className="text-line" stroke="currentColor" strokeWidth={1} />
              <text x={PAD.left - 6} y={gy + 3} textAnchor="end" className="fill-ink-faint text-[9px]">
                {fmtUsd(top * f)}
              </text>
            </g>
          )
        })}
        <polyline points={linePts} fill="none" className="text-accent" stroke="currentColor" strokeWidth={1.5} />
        {/* recommended (min-cost) marker */}
        <line x1={x(recommendedMus)} x2={x(recommendedMus)} y1={PAD.top} y2={PAD.top + IH} className="text-accent" stroke="currentColor" strokeWidth={1} strokeDasharray="4 3" />
        {currentMus != null && Math.abs(currentMus - recommendedMus) > 1e-6 && (
          <line x1={x(currentMus)} x2={x(currentMus)} y1={PAD.top} y2={PAD.top + IH} className="text-ink-faint" stroke="currentColor" strokeWidth={1} strokeDasharray="2 3" />
        )}
        <text x={PAD.left} y={H - 6} className="fill-ink-faint text-[9px]">0 MU (PPT-only)</text>
        <text x={PAD.left + IW} y={H - 6} textAnchor="end" className="fill-ink-faint text-[9px]">{maxMus.toFixed(0)} MU</text>
        {hv != null && (
          <g pointerEvents="none">
            <line x1={x(points[hv].mus)} x2={x(points[hv].mus)} y1={PAD.top} y2={PAD.top + IH} className="text-ink-faint" stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(points[hv].mus)} cy={y(points[hv].total)} r={3} className="fill-accent" />
            <TooltipBox x={x(points[hv].mus)} lines={[`${points[hv].mus.toFixed(1)} MU`, fmtUsd(points[hv].total)]} />
          </g>
        )}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <Legend swatch="bg-accent" label="Total cost" />
        <Legend swatch="border-l-2 border-accent border-dashed" label="Recommended baseline" />
        {currentMus != null && <Legend swatch="border-l-2 border-ink-faint border-dashed" label="Current baseline" />}
      </figcaption>
    </figure>
  )
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${swatch}`} aria-hidden />
      {label}
    </span>
  )
}
