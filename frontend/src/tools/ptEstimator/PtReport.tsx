/**
 * Customer-shareable report for a single simulation. Rendered into a portal on
 * document.body (id="pt-print-root") so print CSS can hide the app shell and
 * print only this sheet — "Save as PDF" from the browser dialog produces a clean,
 * self-contained handout. Read-only: no sliders, toggles, or edit chrome.
 *
 * The sheet forces the LIGHT token palette (via inline CSS vars) regardless of the
 * user's theme, so the PDF always reads on white with dark ink — and sets
 * print-color-adjust:exact so chart fills/tints survive the print pipeline.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  fmtNum,
  fmtPct,
  fmtPctFine,
  fmtTokens,
  fmtUsd,
  reservedAtPptRates,
  termLabel,
  utilizationSplit,
  type CalcContext,
  type Evaluation,
} from './calc'
import { UsageChart } from './charts'
import type { PtModelRow } from './db'

export interface ReportMeta {
  scenarioName: string
  modelName?: string
  usageName?: string
  granularity: 'tpm' | 'tph'
  blend?: { name: string; pct: number }
  term: string // '1d' | '1w' | '1mo' | '3mo'
  tier: string // 'standard' | 'priority'
  // Request shape from the MU sizing inputs.
  sizing: { rpm: number; avgInput: number; avgOutput: number; cachePct: number; sizedMus: number }
  // Organic-growth uplift applied to the series (per-minute, by day type).
  growth?: { weekdayPct: number; weekendPct: number }
}

export interface ReportInput {
  ctx: CalcContext
  current: Evaluation
  recommended: Evaluation
  pptOnly: Evaluation
}

const MONTH_HOURS = 730

// Light-mode token values (mirrors :root in styles/tokens.css) forced onto the
// sheet so the PDF renders on white no matter the app theme.
const LIGHT_VARS: Record<string, string> = {
  '--bg': '#ffffff',
  '--surface': '#ffffff',
  '--surface-sunken': '#f4f4f5',
  '--ink': '#0f0f10',
  '--ink-soft': '#52525b',
  '--ink-faint': '#a1a1aa',
  '--line': '#e9e9ec',
  '--line-strong': '#d4d4d8',
  '--accent': '#0f766e',
  '--accent-ink': '#ffffff',
  '--accent-soft': '#e7f2f0',
  '--danger': '#c0392b',
  '--danger-ink': '#ffffff',
  '--ok': '#2f7d51',
}

export default function PtReport({
  meta,
  input,
  model,
  onClose,
}: {
  meta: ReportMeta
  input: ReportInput
  model?: PtModelRow
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { ctx, current, pptOnly } = input
  const monthFactor = ctx.windowHours > 0 ? MONTH_HOURS / ctx.windowHours : 0
  const windowDays = ctx.windowHours / 24
  const windowLabel = windowDays >= 1 ? `${fmtNum(windowDays, 1)}-day window` : `${fmtNum(ctx.windowHours, 1)}-hour window`
  const month = (v: number) => v * monthFactor

  const values = ctx.buckets.map((b) => b.tpm)
  const migratedValues = ctx.buckets.map((b) => b.migratedTpm)
  const migratedTokens = ctx.buckets.reduce((a, b) => a + b.migratedTpm * b.minutes, 0)
  const demandTokens = ctx.buckets.reduce((a, b) => a + b.tpm * b.minutes, 0)
  const migratedShare = demandTokens > 0 ? migratedTokens / demandTokens : 0

  const savingsVsPpt = pptOnly.total - current.total
  const cheaper = savingsVsPpt >= 0
  const reservedPpt = reservedAtPptRates(ctx, current.baselineMus)
  const util = utilizationSplit(ctx, current.baselineMus)
  const usedTokens = util.weekday.usedTokens + util.weekend.usedTokens
  const capacityTokens = util.weekday.capacityTokens + util.weekend.capacityTokens
  const showDaySplit = util.hasTimestamps && util.weekday.buckets > 0 && util.weekend.buckets > 0
  const termText = termLabel(meta.term)
  const generated = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  const costRows = [
    { label: pptOnly.feasible ? 'Pay-per-token only' : 'Pay-per-token only (infeasible — see caution)', v: pptOnly.total, strong: false },
    { label: 'Reserved PT (committed)', v: current.reservedCost, strong: false },
    { label: 'PPT burst (spikes over capacity)', v: current.burstCost, strong: false },
    { label: 'Reserved PT + PPT — total', v: current.total, strong: true },
  ]

  return createPortal(
    <div
      id="pt-print-root"
      className="pt-report-overlay fixed inset-0 z-50 overflow-auto bg-black/40 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Toolbar — screen only, hidden in print */}
      <div className="pt-report-toolbar mx-auto mb-4 flex max-w-[820px] items-center justify-between gap-3">
        <span className="text-sm font-medium text-white">Report preview</span>
        <div className="flex gap-2">
          <button
            onClick={() => window.print()}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black shadow hover:bg-white/90"
          >
            Print / Save as PDF
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-white/40 px-3 py-1.5 text-sm text-white hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </div>

      {/* The printable sheet */}
      <article
        className="pt-report mx-auto max-w-[820px] bg-surface p-8 text-ink shadow-2xl"
        style={{ ...(LIGHT_VARS as React.CSSProperties), printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties}
      >
        {/* Header */}
        <header className="mb-6 border-b border-line pb-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-accent">
            Reserved Provisioned Throughput — cost comparison
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">{meta.scenarioName}</h1>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-soft">
            {meta.modelName && <span>Model: <span className="text-ink">{meta.modelName}</span></span>}
            {meta.usageName && (
              <span>
                Usage: <span className="text-ink">{meta.usageName}</span>{' '}
                ({meta.granularity === 'tph' ? 'hourly' : 'per-minute'}, {windowLabel})
              </span>
            )}
            {meta.blend && meta.blend.pct > 0 && (
              <span>Migration: <span className="text-ink">+{fmtNum(meta.blend.pct, 0)}% of {meta.blend.name}</span></span>
            )}
            <span>{termText} term · {meta.tier} PPT</span>
          </div>
        </header>

        {/* Request shape — the sizing inputs behind the MU commitment */}
        <section className="mb-6" style={{ breakInside: 'avoid' }}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Request shape (sizing inputs)
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ShapeStat label="Requests / min" value={fmtNum(meta.sizing.rpm, 0)} />
            <ShapeStat label="Avg input / req" value={fmtTokens(meta.sizing.avgInput)} />
            <ShapeStat label="Avg output / req" value={fmtTokens(meta.sizing.avgOutput)} />
            <ShapeStat label="Cache read %" value={`${fmtNum(meta.sizing.cachePct, 0)}%`} />
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            Sized at {fmtNum(meta.sizing.sizedMus)} MU · reference throughput {fmtTokens(ctx.refTpm)}/min = RPM ×
            (avg input + avg output). These inputs drive the reserved capacity per MU.
          </p>
          {meta.growth && (meta.growth.weekdayPct !== 0 || meta.growth.weekendPct !== 0) && (
            <p className="mt-1 text-[11px] font-medium text-accent">
              Organic growth applied to demand: weekday {meta.growth.weekdayPct >= 0 ? '+' : ''}
              {fmtNum(meta.growth.weekdayPct)}%, weekend {meta.growth.weekendPct >= 0 ? '+' : ''}
              {fmtNum(meta.growth.weekendPct)}% — a per-minute uplift (peaks included), request shape unchanged.
            </p>
          )}
        </section>

        {/* Bottom line */}
        <section className="mb-6" style={{ breakInside: 'avoid' }}>
          <SectionTitle n={1} title="Bottom line — per month" />
          <p className="mb-3 text-[12px] text-ink-soft">
            Projected to a 730-hour billing month (×{fmtNum(monthFactor, 1)} the {windowLabel}), assuming the
            measured window is representative.
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label="Reserved PT + PPT"
              value={fmtUsd(month(current.total))}
              sub={`${fmtUsd(month(current.reservedCost))} reserved + ${fmtUsd(month(current.burstCost))} burst`}
              accent
            />
            <Kpi
              label="Pay-per-token only"
              value={fmtUsd(month(pptOnly.total))}
              sub={pptOnly.feasible ? 'no reservation' : `infeasible — ${fmtPctFine(pptOnly.droppedRequestPct)} of requests dropped`}
              tone={pptOnly.feasible ? undefined : 'danger'}
            />
            <Kpi
              label={cheaper ? 'Reserving saves' : 'Reserving costs extra'}
              value={fmtUsd(Math.abs(month(savingsVsPpt)))}
              sub={cheaper ? 'vs pay-per-token' : 'more than pay-per-token'}
              tone={cheaper ? 'ok' : 'danger'}
            />
            <Kpi
              label="Chosen baseline"
              value={`${fmtNum(current.baselineMus)} MU`}
              sub={`${fmtTokens(current.capacityTpm)}/min reserved capacity`}
            />
          </div>
          {!current.feasible && (
            <p className="mt-2 text-[11px] text-danger">
              Note: at this baseline {fmtTokens(current.droppedTokens)} tokens — about{' '}
              {fmtPctFine(current.droppedRequestPct)} of requests ({fmtNum(current.droppedRequests, 0)}) — exceed
              reservation + spike cap and can’t be served. Raise the baseline or spike cap to serve all demand.
            </p>
          )}
          {!pptOnly.feasible && (
            <p className="mt-2 text-[11px] text-danger">
              Caution: pay-per-token only is <strong>infeasible</strong> for this workload — demand spikes exceed the{' '}
              {fmtTokens(ctx.tpmCap)}/min burst cap, dropping {fmtTokens(pptOnly.droppedTokens)} tokens
              (~{fmtPctFine(pptOnly.droppedRequestPct)} of requests) over the window. Its cost above reflects the
              servable portion only; a reservation is required to serve the peaks.
            </p>
          )}
        </section>

        {/* Usage vs capacity */}
        <section className="mb-6" style={{ breakInside: 'avoid' }}>
          <SectionTitle n={2} title="Measured throughput vs reserved capacity" />
          <UsageChart
            values={values}
            capacity={current.capacityTpm}
            cap={Number.isFinite(ctx.tpmCap) ? current.capacityTpm + ctx.tpmCap : undefined}
            yLabel="Tokens / min"
            times={ctx.buckets.map((b) => b.t)}
            migrated={migratedValues}
          />
          <p className="mt-2 text-[11px] text-ink-soft">
            The dashed line is the reserved capacity ({fmtTokens(current.capacityTpm)}/min). Demand above it (shaded)
            bursts to pay-per-token. Peak demand {fmtTokens(ctx.peakServedTpm)}/min; average {fmtTokens(ctx.avgTpm)}/min.
            {migratedShare > 0 && ` Migrated traffic is ${fmtPct(migratedShare)} of demand.`}
            {meta.granularity === 'tph' && ' Hourly data — sub-hour spikes are smoothed.'}
          </p>
        </section>

        {/* Reserved capacity utilization */}
        <section className="mb-6" style={{ breakInside: 'avoid' }}>
          <SectionTitle n={3} title="Reserved capacity utilization" />
          <p className="mb-3 text-[12px] text-ink-soft">
            Share of the reserved input capacity actually consumed (input served ÷ reserved input capacity). Low
            utilization means the flat reservation sits idle much of the time — capacity you pay for but don’t use.
          </p>
          <div className="mb-3 rounded-lg border border-line p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] text-ink-soft">Overall — input capacity used</span>
              <span className="font-mono text-xl font-semibold text-ink">{fmtPct(current.utilizationPct)}</span>
            </div>
            <UtilBar pct={current.utilizationPct} />
            <div className="mt-1 text-[11px] text-ink-faint">
              {fmtTokens(usedTokens)} of {fmtTokens(capacityTokens)} reserved input tokens used ·{' '}
              {fmtTokens(current.wastedTokens)} idle over the {windowLabel}.
            </div>
          </div>
          {showDaySplit && (
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Weekday (Mon–Fri)', d: util.weekday },
                { label: 'Weekend (Sat/Sun)', d: util.weekend },
              ].map(({ label, d }) => (
                <div key={label}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] text-ink-soft">{label}</span>
                    <span className="font-mono text-lg text-ink">{fmtPct(d.utilizationPct)}</span>
                  </div>
                  <UtilBar pct={d.utilizationPct} />
                  <div className="mt-1 text-[11px] text-ink-faint">
                    {fmtTokens(d.usedTokens)} of {fmtTokens(d.capacityTokens)} used · {fmtNum(d.buckets)} buckets
                  </div>
                </div>
              ))}
            </div>
          )}
          {showDaySplit && Math.abs(util.weekday.utilizationPct - util.weekend.utilizationPct) > 0.15 && (
            <p className="mt-3 text-[11px] text-ink-soft">
              A {fmtPct(Math.abs(util.weekday.utilizationPct - util.weekend.utilizationPct))} weekday/weekend gap means
              a flat reservation is idle part of the week — worth weighing against the burst savings.
            </p>
          )}
        </section>

        {/* Cost breakdown */}
        <section className="mb-6" style={{ breakInside: 'avoid' }}>
          <SectionTitle n={4} title="Cost breakdown" />
          <table className="w-full text-left text-[12px]">
            <thead className="text-ink-faint">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-3 font-normal">Cost</th>
                <th className="py-1.5 pr-3 text-right font-normal">Usage window ({windowLabel})</th>
                <th className="py-1.5 text-right font-normal">Per month</th>
              </tr>
            </thead>
            <tbody className="font-mono text-ink">
              {costRows.map((r) => (
                <tr key={r.label} className={`border-b border-line/60 ${r.strong ? 'font-semibold' : ''}`}>
                  <td className="py-1.5 pr-3 font-sans text-ink-soft">{r.label}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtUsd(r.v)}</td>
                  <td className="py-1.5 text-right">{fmtUsd(month(r.v))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-ink-soft">
            Reserved PT bills flat committed capacity; PPT bursts price only the spikes that overflow it, using the
            rate card’s per-component rates on the real token mix. Reserved-covered throughput would have cost{' '}
            {fmtUsd(month(reservedPpt.total))}/month on pay-per-token
            {reservedPpt.total >= current.reservedCost ? ' — so the reservation pays off for that portion.' : ' — pay-per-token would be cheaper for that portion.'}
          </p>
        </section>

        {/* Assumptions */}
        <section style={{ breakInside: 'avoid' }}>
          <SectionTitle n={5} title="Assumptions & inputs" />
          <div className="grid gap-x-8 gap-y-1.5 text-[12px] sm:grid-cols-2">
            <Row k="Reserved rate" v={`${fmtNum(ctx.muToDbu, 4)} DBU/MU·h (${termText}) × $${fmtNum(ctx.dbuRate, 4)}/DBU`} />
            <Row k="Reserved $/hour" v={`$${fmtNum(current.baselineMus * ctx.muToDbu * ctx.dbuRate, 2)} at ${fmtNum(current.baselineMus)} MU`} />
            <Row k="Capacity per MU" v={`${fmtTokens(ctx.tpmPerMu)}/min (input ${fmtTokens(ctx.inputTpmPerMu)}/min)`} />
            <Row k="Spike cap (PPT ceiling)" v={Number.isFinite(ctx.tpmCap) ? `${fmtTokens(ctx.tpmCap)}/min over reservation` : 'none'} />
            <Row k="Reference throughput" v={`${fmtTokens(ctx.refTpm)}/min = RPM × (avg in + out), at ${fmtNum(ctx.sizedMus)} MU sized`} />
            <Row k="Window" v={`${fmtNum(ctx.windowHours, 1)} h · peak ${fmtTokens(ctx.peakServedTpm)}/min · avg ${fmtTokens(ctx.avgTpm)}/min`} />
            {model && (
              <Row
                k={`PPT rates (${meta.tier}, DBU/1M)`}
                v={
                  meta.tier === 'priority'
                    ? `in ${fmtNum(model.pri_input_dbu, 3)} · out ${fmtNum(model.pri_output_dbu, 3)} · cache ${fmtNum(model.pri_cache_dbu, 3)}`
                    : `in ${fmtNum(model.std_input_dbu, 3)} · out ${fmtNum(model.std_output_dbu, 3)} · cache ${fmtNum(model.std_cache_dbu, 3)}`
                }
              />
            )}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-6 border-t border-line pt-3 text-[10px] text-ink-faint">
          Monthly = window × (730 ÷ {fmtNum(ctx.windowHours, 1)}). Reserved PT also guarantees capacity and avoids
          rate limits — value beyond this dollar comparison. Generated by the Otter Reserved PT estimator · {generated}.
        </footer>
      </article>
    </div>,
    document.body,
  )
}

function SectionTitle({ n, title }: { n: number; title: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <span className="font-mono text-[11px] text-accent">{n}</span>
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink">{title}</h2>
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  accent,
  tone,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
  tone?: 'ok' | 'danger'
}) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface'}`}>
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-ink">{value}</div>
      {sub && (
        <div className={`mt-0.5 text-[10px] ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink-faint'}`}>
          {sub}
        </div>
      )}
    </div>
  )
}

function ShapeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunken/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-0.5 font-mono text-base font-semibold text-ink">{value}</div>
    </div>
  )
}

function UtilBar({ pct }: { pct: number }) {
  return (
    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-sunken">
      <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }} />
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line/50 py-1">
      <span className="text-ink-soft">{k}</span>
      <span className="text-right font-mono text-ink">{v}</span>
    </div>
  )
}
