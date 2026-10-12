import { useMemo, useState } from 'react'
import { useLiveQuery } from '@electric-sql/pglite-react'
import { useConfirm } from '../../components/ConfirmProvider'
import {
  blendMismatch,
  blendPoints,
  buildContext,
  evaluate,
  fmtNum,
  fmtPct,
  fmtPctFine,
  fmtTokens,
  fmtUsd,
  growPoints,
  parseUsageCsv,
  muToDbuFor,
  percentile,
  RESERVATION_TERMS,
  reservedAtPptRates,
  SHORT_TERM_MULTIPLIER,
  sweep,
  usageTemplate,
  utilizationSplit,
  type CalcContext,
  type Evaluation,
} from './calc'
import { LineChart, TwoLineChart, UsageChart } from './charts'
import PtReport from './PtReport'
import {
  deleteModel,
  deleteScenario,
  deleteUsage,
  parseUsagePoints,
  saveModel,
  saveScenario,
  saveUsage,
  type ModelInput,
  type PtModelRow,
  type PtScenarioRow,
  type PtUsageRow,
  type ScenarioInput,
  type UsagePoint,
} from './db'

type Tab = 'sims' | 'models' | 'usage'

export default function PtEstimator() {
  const [tab, setTab] = useState<Tab>('sims')
  const models = (useLiveQuery<PtModelRow>(
    `SELECT * FROM pt_models WHERE deleted_at IS NULL ORDER BY name`,
  )?.rows ?? []) as PtModelRow[]
  const usage = (useLiveQuery<PtUsageRow>(
    `SELECT * FROM pt_usage WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  )?.rows ?? []) as PtUsageRow[]
  const scenarios = (useLiveQuery<PtScenarioRow>(
    `SELECT * FROM pt_scenarios WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  )?.rows ?? []) as PtScenarioRow[]

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-3xl font-semibold tracking-tight">Reserved PT estimator</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-soft">
          Size FMAPI reserved throughput against real usage. Define a model rate card, upload
          historical usage, then sweep reserved baselines to find the lowest total cost —
          reserved PT plus pay-per-token bursts — versus pay-per-token alone.
        </p>
      </header>

      <nav className="mb-6 flex gap-1 border-b border-line">
        {(
          [
            ['sims', `Simulations${scenarios.length ? ` · ${scenarios.length}` : ''}`],
            ['models', `Models${models.length ? ` · ${models.length}` : ''}`],
            ['usage', `Usage data${usage.length ? ` · ${usage.length}` : ''}`],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'sims' && <SimulationsTab scenarios={scenarios} models={models} usage={usage} />}
      {tab === 'models' && <ModelsTab models={models} />}
      {tab === 'usage' && <UsageTab usage={usage} />}
    </div>
  )
}

// ── shared compute ────────────────────────────────────────────────────────────
interface Computed {
  ctx: CalcContext
  current: Evaluation
  recommended: Evaluation
  pptOnly: Evaluation
  sweepPoints: { mus: number; total: number }[]
  baselineMus: number
  points: UsagePoint[]
  manual: { rpm: number; avgIn: number; avgOut: number }
}

function computeScenario(
  scn: PtScenarioRow,
  model: PtModelRow | undefined,
  points: UsagePoint[],
  granularity: 'tpm' | 'tph',
): Computed | { error: string } {
  if (!model) return { error: 'Pick a model rate card.' }
  // Project organic growth (per-minute uplift by day type) onto the series before
  // building the context, so peak, capacity, cost, and utilization all reflect it.
  const grown = growPoints(points, scn.growth_weekday_pct, scn.growth_weekend_pct)
  const ctx = buildContext(model, scn, grown, granularity)
  if (!ctx.ok) return { error: ctx.reason ?? 'Incomplete inputs.' }
  const sw = sweep(ctx)
  const baselineMus = scn.baseline_mus ?? sw.recommended.baselineMus
  return {
    ctx,
    current: evaluate(ctx, baselineMus),
    recommended: sw.recommended,
    pptOnly: sw.pptOnly,
    sweepPoints: sw.points,
    baselineMus,
    points,
    manual: { rpm: scn.rpm, avgIn: scn.avg_input_tokens, avgOut: scn.avg_output_tokens },
  }
}

/** The usage series a scenario evaluates against — the base dataset plus, when a
 *  migration blend is configured, `blend_pct`% of the add-on dataset on top.
 *  Returns an error (rather than a misleading index-aligned blend) when the two
 *  datasets don't match: different granularity, bucket count, or timestamps. */
function resolveBlend(
  scn: PtScenarioRow,
  usageById: Map<string, PtUsageRow>,
  pointsByUsage: Map<string, UsagePoint[]>,
): { points: UsagePoint[] } | { error: string } {
  const base = scn.usage_id ? pointsByUsage.get(scn.usage_id) ?? [] : []
  if (!scn.blend_usage_id || scn.blend_pct <= 0 || base.length === 0) return { points: base }
  const addon = pointsByUsage.get(scn.blend_usage_id) ?? []
  const baseU = scn.usage_id ? usageById.get(scn.usage_id) : undefined
  const blendU = usageById.get(scn.blend_usage_id)
  if (baseU && blendU && baseU.granularity !== blendU.granularity)
    return {
      error: `Migration blend: base is ${baseU.granularity} and the add-on “${blendU.name}” is ${blendU.granularity} — re-upload both at the same granularity.`,
    }
  const mismatch = blendMismatch(base, addon)
  if (mismatch) return { error: `Migration blend: ${mismatch}.` }
  return { points: blendPoints(base, addon, scn.blend_pct / 100) }
}

// ── Simulations ───────────────────────────────────────────────────────────────
function SimulationsTab({
  scenarios,
  models,
  usage,
}: {
  scenarios: PtScenarioRow[]
  models: PtModelRow[]
  usage: PtUsageRow[]
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const modelById = useMemo(() => new Map(models.map((m) => [m.id, m])), [models])
  const usageById = useMemo(() => new Map(usage.map((u) => [u.id, u])), [usage])
  const pointsByUsage = useMemo(() => {
    const m = new Map<string, UsagePoint[]>()
    for (const u of usage) m.set(u.id, parseUsagePoints(u))
    return m
  }, [usage])

  function computeFor(scn: PtScenarioRow) {
    const u = scn.usage_id ? usageById.get(scn.usage_id) : undefined
    const blend = resolveBlend(scn, usageById, pointsByUsage)
    if ('error' in blend) return { error: blend.error }
    return computeScenario(
      scn,
      scn.model_id ? modelById.get(scn.model_id) : undefined,
      blend.points,
      u?.granularity ?? 'tpm',
    )
  }

  // Duplicate a saved simulation: same inputs, a new id, name suffixed "(copy)".
  // Stays on the list — the copy syncs in and appears at the top (newest first).
  const [cloningId, setCloningId] = useState<string | null>(null)
  async function clone(s: PtScenarioRow) {
    setCloningId(s.id)
    try {
      const input: ScenarioInput = {
        name: `${s.name} (copy)`,
        model_id: s.model_id,
        usage_id: s.usage_id,
        blend_usage_id: s.blend_usage_id,
        blend_pct: s.blend_pct,
        growth_weekday_pct: s.growth_weekday_pct,
        growth_weekend_pct: s.growth_weekend_pct,
        dbu_rate_discounted: s.dbu_rate_discounted,
        rpm: s.rpm,
        avg_input_tokens: s.avg_input_tokens,
        avg_output_tokens: s.avg_output_tokens,
        cache_pct: s.cache_pct,
        mus: s.mus,
        baseline_mus: s.baseline_mus,
        tpm_cap: s.tpm_cap,
        ppt_tier: s.ppt_tier,
        reservation_term: s.reservation_term,
        notes: s.notes,
      }
      await saveScenario(crypto.randomUUID(), input)
    } finally {
      setCloningId(null)
    }
  }

  if (creating || editingId) {
    const scn = editingId ? scenarios.find((s) => s.id === editingId) : undefined
    return (
      <ScenarioEditor
        scenario={scn}
        models={models}
        usage={usage}
        pointsByUsage={pointsByUsage}
        modelById={modelById}
        usageById={usageById}
        onClose={() => {
          setEditingId(null)
          setCreating(false)
        }}
      />
    )
  }

  if (models.length === 0) {
    return (
      <Notice>
        Add a <strong>model rate card</strong> first (Models tab) — it holds the MU→DBU factor,
        $/DBU, and the PPT rates a simulation needs.
      </Notice>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
        >
          + New simulation
        </button>
      </div>

      {scenarios.length === 0 ? (
        <Notice>No simulations yet. Create one to size a reserved baseline against your usage.</Notice>
      ) : (
        <div className="space-y-2">
          {scenarios.map((s) => {
            const r = computeFor(s)
            return (
              <div
                key={s.id}
                className="flex w-full items-stretch gap-2 rounded-lg border border-line bg-surface transition-colors hover:border-line-strong"
              >
                <button
                  onClick={() => setEditingId(s.id)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 p-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{s.name}</div>
                    <div className="mt-0.5 text-xs text-ink-faint">
                      {s.model_id ? (modelById.get(s.model_id)?.name ?? 'model?') : 'no model'} ·{' '}
                      {s.usage_id ? (usageById.get(s.usage_id)?.name ?? 'usage?') : 'no usage'} ·{' '}
                      {s.ppt_tier} PPT
                    </div>
                  </div>
                  {'error' in r ? (
                    <span className="shrink-0 text-xs text-ink-faint">{r.error}</span>
                  ) : (
                    <div className="shrink-0 space-y-0.5 text-right">
                      <div className="flex items-baseline justify-end gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-ink-faint">PT + PPT</span>
                        <span className="font-mono text-sm font-medium text-ink">{fmtUsd(r.current.total)}</span>
                      </div>
                      <div className="flex items-baseline justify-end gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-ink-faint">PPT only</span>
                        <span className="font-mono text-sm text-ink-soft">{fmtUsd(r.pptOnly.total)}</span>
                      </div>
                      <div className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                        usage-window spend
                      </div>
                      <SavingsPill pptOnly={r.pptOnly.total} total={r.current.total} />
                    </div>
                  )}
                </button>
                <button
                  onClick={() => clone(s)}
                  disabled={cloningId === s.id}
                  title="Duplicate this simulation"
                  className="my-3 mr-3 shrink-0 self-center rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:text-ink disabled:opacity-40"
                >
                  {cloningId === s.id ? 'Cloning…' : 'Clone'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SavingsPill({ pptOnly, total }: { pptOnly: number; total: number }) {
  const save = pptOnly - total
  const good = save > 0
  return (
    <span
      className={`font-mono text-[11px] ${good ? 'text-accent' : 'text-ink-faint'}`}
      title="Savings vs pay-per-token only"
    >
      {good ? '−' : '+'}
      {fmtUsd(Math.abs(save))} vs PPT
    </span>
  )
}

function ScenarioEditor({
  scenario,
  models,
  usage,
  pointsByUsage,
  modelById,
  usageById,
  onClose,
}: {
  scenario?: PtScenarioRow
  models: PtModelRow[]
  usage: PtUsageRow[]
  pointsByUsage: Map<string, UsagePoint[]>
  modelById: Map<string, PtModelRow>
  usageById: Map<string, PtUsageRow>
  onClose: () => void
}) {
  const [id] = useState(scenario?.id ?? crypto.randomUUID())
  const [draft, setDraft] = useState<ScenarioInput>(() => ({
    name: scenario?.name ?? 'New simulation',
    model_id: scenario?.model_id ?? models[0]?.id ?? null,
    usage_id: scenario?.usage_id ?? usage[0]?.id ?? null,
    blend_usage_id: scenario?.blend_usage_id ?? null,
    blend_pct: scenario?.blend_pct ?? 0,
    growth_weekday_pct: scenario?.growth_weekday_pct ?? 0,
    growth_weekend_pct: scenario?.growth_weekend_pct ?? 0,
    dbu_rate_discounted: scenario?.dbu_rate_discounted ?? null,
    rpm: scenario?.rpm ?? 0,
    avg_input_tokens: scenario?.avg_input_tokens ?? 0,
    avg_output_tokens: scenario?.avg_output_tokens ?? 0,
    cache_pct: scenario?.cache_pct ?? 0,
    mus: scenario?.mus ?? 0,
    baseline_mus: scenario?.baseline_mus ?? null,
    tpm_cap: scenario?.tpm_cap ?? 20_000_000,
    ppt_tier: scenario?.ppt_tier ?? 'standard',
    reservation_term: scenario?.reservation_term ?? '1mo',
    notes: scenario?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showReport, setShowReport] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const confirm = useConfirm()

  const set = (patch: Partial<ScenarioInput>) => setDraft((d) => ({ ...d, ...patch }))
  const scnForCalc: PtScenarioRow = {
    ...draft,
    id,
    created_at: '',
    updated_at: '',
    deleted_at: null,
  } as PtScenarioRow

  const u = draft.usage_id ? usageById.get(draft.usage_id) : undefined
  const blend = resolveBlend(scnForCalc, usageById, pointsByUsage)
  const result =
    'error' in blend
      ? blend
      : computeScenario(
          scnForCalc,
          draft.model_id ? modelById.get(draft.model_id) : undefined,
          blend.points,
          u?.granularity ?? 'tpm',
        )

  // Metrics derived from the (blended) series, so a migration can be sized even
  // when the sizing fields are still blank. "Use for sizing" fills RPM/tokens/cache
  // from these; the user then runs the MU sizer and pastes the MUs back.
  const isBlended = !!draft.blend_usage_id && draft.blend_pct > 0
  const derived = 'points' in blend ? deriveSizing(blend.points, u?.granularity ?? 'tpm') : null
  const applyDerived = () => {
    if (!derived) return
    set({
      rpm: round2(derived.rpm),
      avg_input_tokens: Math.round(derived.avgInput),
      avg_output_tokens: Math.round(derived.avgOutput),
      cache_pct: round2(derived.cachePct),
    })
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      await saveScenario(id, draft)
      onClose()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }
  async function remove() {
    if (!scenario) {
      onClose()
      return
    }
    const ok = await confirm({
      title: 'Delete simulation',
      message: `Delete “${scenario.name}”? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await deleteScenario(scenario.id)
    onClose()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button onClick={onClose} className="text-sm text-ink-faint hover:text-ink">
          ← Simulations
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => setShowReport(true)}
            disabled={'error' in result}
            title={'error' in result ? 'Complete the inputs to export a report' : 'Open a customer-shareable report to print or save as PDF'}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-40"
          >
            Export PDF
          </button>
          {scenario && (
            <button
              onClick={remove}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-danger hover:bg-danger/5"
            >
              Delete
            </button>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
          >
            {saving ? 'Saving…' : scenario ? 'Save' : 'Create'}
          </button>
        </div>
      </div>

      {showReport && !('error' in result) && (
        <PtReport
          meta={{
            scenarioName: draft.name,
            modelName: draft.model_id ? modelById.get(draft.model_id)?.name : undefined,
            usageName: u?.name,
            granularity: u?.granularity ?? 'tpm',
            blend:
              isBlended && draft.blend_usage_id
                ? { name: usageById.get(draft.blend_usage_id)?.name ?? 'other dataset', pct: draft.blend_pct }
                : undefined,
            term: draft.reservation_term,
            tier: draft.ppt_tier,
            sizing: {
              rpm: draft.rpm,
              avgInput: draft.avg_input_tokens,
              avgOutput: draft.avg_output_tokens,
              cachePct: draft.cache_pct,
              sizedMus: draft.mus,
            },
            growth: { weekdayPct: draft.growth_weekday_pct, weekendPct: draft.growth_weekend_pct },
          }}
          input={{
            ctx: result.ctx,
            current: result.current,
            recommended: result.recommended,
            pptOnly: result.pptOnly,
          }}
          model={draft.model_id ? modelById.get(draft.model_id) : undefined}
          onClose={() => setShowReport(false)}
        />
      )}

      {saveError && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          Couldn&apos;t save: {saveError}. If this mentions a missing column, re-run{' '}
          <code className="font-mono">alembic upgrade head</code> and recreate the Electric shape.
        </div>
      )}

      <input
        value={draft.name}
        onChange={(e) => set({ name: e.target.value })}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-lg font-medium text-ink"
        placeholder="Simulation name"
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Model rate card">
          <select
            value={draft.model_id ?? ''}
            onChange={(e) => set({ model_id: e.target.value || null })}
            className={selectCls}
          >
            <option value="">— none —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Usage dataset">
          <select
            value={draft.usage_id ?? ''}
            onChange={(e) => set({ usage_id: e.target.value || null })}
            className={selectCls}
          >
            <option value="">— none —</option>
            {usage.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.granularity}, {x.row_count} rows)
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Peek at the attached dataset's metrics + charts without leaving the editor. */}
      {u && (
        <div className="rounded-lg border border-line">
          <button
            type="button"
            onClick={() => setShowUsage((v) => !v)}
            aria-expanded={showUsage}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
          >
            <span className="text-sm text-ink-soft">
              Usage data metrics — <span className="text-ink">{u.name}</span>{' '}
              <span className="font-mono text-xs text-ink-faint">
                ({u.granularity === 'tph' ? 'hourly' : 'per-minute'}, {u.row_count} rows)
              </span>
            </span>
            <span className="shrink-0 font-mono text-xs text-ink-faint">{showUsage ? 'Hide ▲' : 'Show ▼'}</span>
          </button>
          {showUsage && (
            <div className="border-t border-line p-3">
              <UsageCard u={u} showDelete={false} />
            </div>
          )}
        </div>
      )}

      <Fieldset legend="Traffic migration (optional)">
        <p className="mb-3 text-[11px] text-ink-faint">
          Modeling a model that&apos;s absorbing traffic from another? Pick the other model&apos;s
          usage dataset and the share to move in. That portion is added on top of the base series —
          shown in <span className="font-medium text-violet-500">violet</span> on the charts — and
          folded into the cost + capacity math.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Migrate from (dataset)">
            <select
              value={draft.blend_usage_id ?? ''}
              onChange={(e) => set({ blend_usage_id: e.target.value || null })}
              className={selectCls}
            >
              <option value="">— none —</option>
              {usage
                .filter((x) => x.id !== draft.usage_id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.granularity}, {x.row_count} rows)
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Share to migrate in">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.min(100, draft.blend_pct)}
                onChange={(e) => set({ blend_pct: Number(e.target.value) })}
                disabled={!draft.blend_usage_id}
                className="flex-1 accent-accent disabled:opacity-40"
              />
              <input
                type="number"
                min={0}
                step={1}
                value={draft.blend_pct}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v) && v >= 0) set({ blend_pct: v })
                }}
                disabled={!draft.blend_usage_id}
                className="w-16 rounded border border-line bg-surface px-1.5 py-0.5 text-right font-mono text-sm text-ink disabled:opacity-40"
              />
              <span className="text-xs text-ink-faint">%</span>
            </div>
          </Field>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          The add-on must match the base dataset&apos;s granularity, bucket count, and timestamps —
          otherwise the simulation reports a mismatch error instead of a blended result.
        </p>
      </Fieldset>

      <Fieldset legend="PT sizing (from the external MU sizer)">
        {derived && derived.hasReqs && (
          <div className="mb-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-ink">
                Derived from the {isBlended ? 'blended' : 'attached'} data ({derived.buckets.toLocaleString()} buckets)
              </span>
              <button
                type="button"
                onClick={applyDerived}
                className="rounded border border-accent/40 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/10"
              >
                Use for sizing →
              </button>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] text-ink-soft sm:grid-cols-4">
              <span>RPM <span className="text-ink">{fmtNum(derived.rpm, 0)}</span></span>
              <span>In/req <span className="text-ink">{fmtTokens(derived.avgInput)}</span></span>
              <span>Out/req <span className="text-ink">{fmtTokens(derived.avgOutput)}</span></span>
              <span>Cache <span className="text-ink">{fmtNum(derived.cachePct, 0)}%</span></span>
            </div>
            <p className="mt-1.5 text-[10px] text-ink-faint">
              Volume-weighted over the series ({fmtTokens(derived.avgTpm)}/min avg throughput). Feed
              these into the MU sizer, then paste the MUs it returns below — the tool can&apos;t size
              MUs itself.
            </p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumField label="RPM" value={draft.rpm} onChange={(v) => set({ rpm: v })} />
          <NumField
            label="Avg input tokens/req"
            value={draft.avg_input_tokens}
            onChange={(v) => set({ avg_input_tokens: v })}
          />
          <NumField
            label="Avg output tokens/req"
            value={draft.avg_output_tokens}
            onChange={(v) => set({ avg_output_tokens: v })}
          />
          <NumField
            label="Cache %"
            value={draft.cache_pct}
            onChange={(v) => set({ cache_pct: v })}
          />
          <NumField
            label="Sized MUs (pasted)"
            value={draft.mus}
            onChange={(v) => set({ mus: v })}
            hint="MUs the sizer returned for the RPM/tokens above"
          />
          <NumField
            label="Spike cap (TPM)"
            value={draft.tpm_cap}
            onChange={(v) => set({ tpm_cap: v })}
          />
        </div>
        <div className="mt-3 rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs text-ink-soft">
          Derived throughput:{' '}
          <span className="text-ink">
            {fmtTokens(draft.rpm * (draft.avg_input_tokens + draft.avg_output_tokens))} tokens/min
          </span>{' '}
          · {fmtTokens(draft.rpm * (draft.avg_input_tokens + draft.avg_output_tokens) * 60)} tokens/hr
          <span className="text-ink-faint"> — RPM × (avg in + avg out)</span>
        </div>
      </Fieldset>

      <Fieldset legend="Pricing">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="PPT tier for bursts">
            <select
              value={draft.ppt_tier}
              onChange={(e) => set({ ppt_tier: e.target.value })}
              className={selectCls}
            >
              <option value="standard">Standard</option>
              <option value="priority">Priority</option>
            </select>
          </Field>
          <Field label="Reservation term">
            <select
              value={draft.reservation_term}
              onChange={(e) => set({ reservation_term: e.target.value })}
              className={selectCls}
            >
              {RESERVATION_TERMS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <NumField
            label="Discounted $/DBU"
            value={draft.dbu_rate_discounted ?? null}
            onChange={(v) => set({ dbu_rate_discounted: v })}
            nullable
            hint="Blank → use the model's list rate"
          />
        </div>
      </Fieldset>

      {'error' in result ? (
        <Notice>{result.error}</Notice>
      ) : (
        <Results
          result={result}
          usageGranularity={u?.granularity ?? 'tpm'}
          onUseRecommended={() => set({ baseline_mus: round2(result.recommended.baselineMus) })}
          onBaseline={(v) => set({ baseline_mus: v })}
          baselineMus={draft.baseline_mus}
          growthWeekday={draft.growth_weekday_pct}
          growthWeekend={draft.growth_weekend_pct}
          onGrowth={set}
        />
      )}
    </div>
  )
}

function Results({
  result,
  usageGranularity,
  onUseRecommended,
  onBaseline,
  baselineMus,
  growthWeekday,
  growthWeekend,
  onGrowth,
}: {
  result: Computed
  usageGranularity: 'tpm' | 'tph'
  onUseRecommended: () => void
  onBaseline: (v: number) => void
  baselineMus: number | null
  growthWeekday: number
  growthWeekend: number
  onGrowth: (patch: Partial<ScenarioInput>) => void
}) {
  // Show every $ figure for either the raw usage window or a projected billing
  // month. Both scale linearly with the window, so one factor covers all costs.
  const [period, setPeriod] = useState<'window' | 'month'>('window')
  const { ctx, current, recommended, pptOnly, points, manual } = result
  const values = ctx.buckets.map((b) => b.tpm)
  const migratedValues = ctx.buckets.map((b) => b.migratedTpm)
  // Migrated share of demand tokens (for the note under the chart).
  const migratedTokens = ctx.buckets.reduce((a, b) => a + b.migratedTpm * b.minutes, 0)
  const demandTokens = ctx.buckets.reduce((a, b) => a + b.tpm * b.minutes, 0)
  const migratedShare = demandTokens > 0 ? migratedTokens / demandTokens : 0
  const savingsVsPpt = pptOnly.total - current.total
  // Value the reservation-served tokens at PPT rates (split by component), to see
  // whether PT beat PPT for the covered throughput. >0 → PPT would've cost more.
  const reservedPpt = reservedAtPptRates(ctx, current.baselineMus)
  const reservedVsPpt = reservedPpt.total - current.reservedCost
  const util = utilizationSplit(ctx, current.baselineMus)
  const alignRows = [
    { label: 'Requests / min', manual: manual.rpm, stats: metricStats(points, (p) => p.rpm), fmt: (n: number) => fmtNum(n, 0) },
    { label: 'Input tokens / req', manual: manual.avgIn, stats: metricStats(points, (p) => p.avg_input), fmt: fmtTokens },
    { label: 'Output tokens / req', manual: manual.avgOut, stats: metricStats(points, (p) => p.avg_output), fmt: fmtTokens },
    {
      label: 'Throughput (TPM)',
      manual: ctx.refTpm,
      stats: { avg: ctx.avgTpm, p90: percentile(values, 90), peak: ctx.peakServedTpm },
      fmt: fmtTokens,
    },
  ]
  // A billing month is 730h; extrapolating assumes the window is representative
  // and scales every cost by 730/windowHours. The same factor applies to reserved
  // (hours-based) and burst (volume-based) costs, so it's a single multiplier.
  const MONTH_HOURS = 730
  const windowDays = ctx.windowHours / 24
  const windowLabel =
    windowDays >= 1
      ? `~${fmtNum(windowDays, 1)}-day window`
      : `~${fmtNum(ctx.windowHours, 1)}-hour window`
  const monthFactor = ctx.windowHours > 0 ? MONTH_HOURS / ctx.windowHours : 0
  const factor = period === 'month' ? monthFactor : 1
  const periodLabel = period === 'month' ? 'month' : windowLabel
  const usd = (v: number) => fmtUsd(v * factor)

  return (
    <div className="space-y-6">
      {/* 1 · Sizing inputs compared against the real usage series. */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="mb-1 text-sm font-medium text-ink">Calculator inputs vs actual usage</div>
        <p className="mb-3 text-[11px] text-ink-faint">
          Your manual inputs size the reserved MUs. Compare against the attached dataset to check
          they reflect real load — a manual value far below the actual p90/peak means the sizing
          under-represents spikes.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr className="border-b border-line">
                <th className="py-1 pr-3 font-normal">Metric</th>
                <th className="py-1 pr-3 text-right font-normal">Manual (calc)</th>
                <th className="py-1 pr-3 text-right font-normal">Actual avg</th>
                <th className="py-1 pr-3 text-right font-normal">Actual p90</th>
                <th className="py-1 text-right font-normal">Actual peak</th>
              </tr>
            </thead>
            <tbody className="font-mono text-ink">
              {alignRows.map((r) => (
                <tr key={r.label} className="border-b border-line/50">
                  <td className="py-1 pr-3 font-sans text-ink-soft">{r.label}</td>
                  <td className="py-1 pr-3 text-right">{r.manual > 0 ? r.fmt(r.manual) : '—'}</td>
                  <td className="py-1 pr-3 text-right">{r.stats ? r.fmt(r.stats.avg) : '—'}</td>
                  <td className="py-1 pr-3 text-right">{r.stats ? r.fmt(r.stats.p90) : '—'}</td>
                  <td className="py-1 text-right">{r.stats ? r.fmt(r.stats.peak) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {points.every((p) => p.rpm == null) && (
          <p className="mt-2 text-[11px] text-ink-faint">
            This dataset has no rpm / per-request columns, so only throughput can be compared. Re-upload
            with rpm, avg_input_per_request, avg_output_per_request to compare all inputs.
          </p>
        )}
        <Explain>
          <F>Reference throughput = RPM × (avg in + avg out)</F>
          <F>
            = {fmtNum(manual.rpm, 0)} × ({fmtTokens(manual.avgIn)} + {fmtTokens(manual.avgOut)}) ={' '}
            {fmtTokens(ctx.refTpm)}/min
          </F>
          <div>
            Actual avg / p90 / peak are computed per bucket directly from the attached dataset. This
            table only checks your manual sizing inputs against real load — it doesn&apos;t feed cost.
          </div>
        </Explain>
      </div>

      {/* 2 · Pick the reserved baseline. */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium text-ink">Reserved baseline</div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={Math.max(
                recommended.baselineMus * 2,
                ctx.inputTpmPerMu > 0 ? ctx.peakInputTpm / ctx.inputTpmPerMu : ctx.peakServedTpm / ctx.tpmPerMu,
                1,
              )}
              step="any"
              value={current.baselineMus}
              onChange={(e) => onBaseline(Number(e.target.value))}
              className="w-48 accent-accent"
            />
            <span className="flex flex-col leading-tight">
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={Number(current.baselineMus.toFixed(2))}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v) && v >= 0) onBaseline(v)
                  }}
                  className="w-20 rounded border border-line bg-surface px-1.5 py-0.5 text-right font-mono text-sm text-ink focus:border-accent focus:outline-none"
                />
                <span className="text-xs text-ink-faint">MU</span>
              </span>
              <span className="font-mono text-[11px] text-accent">
                {fmtTokens(current.capacityTpm)}/min
              </span>
            </span>
            <button
              onClick={onUseRecommended}
              className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:text-ink"
            >
              Use recommended
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Capacity (TPM)" value={`${fmtTokens(current.capacityTpm)}/min`} />
          <Stat label={`Reserved cost / ${windowLabel}`} value={fmtUsd(current.reservedCost)} />
          <Stat label={`Burst cost / ${windowLabel}`} value={fmtUsd(current.burstCost)} />
          <Stat label="Served coverage" value={fmtPct(current.coveragePct)} />
          <Stat label="Input capacity used" value={fmtPct(current.utilizationPct)} />
        </div>
        {/* Organic growth — projected at THIS reservation, so it moves utilization
            and burst above without touching the MU sizing inputs. */}
        <div className="mt-3 rounded-md border border-line bg-surface-sunken/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">Organic growth</span>
            <span className="text-[11px] text-ink-faint">
              Projects demand at this fixed reservation (peaks included) — watch “Input capacity used” and burst move.
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <PctSlider
              label="Weekday (Mon–Fri)"
              value={growthWeekday}
              onChange={(v) => onGrowth({ growth_weekday_pct: v })}
            />
            <PctSlider
              label="Weekend (Sat/Sun)"
              value={growthWeekend}
              onChange={(v) => onGrowth({ growth_weekend_pct: v })}
            />
          </div>
          {(growthWeekday !== 0 || growthWeekend !== 0) && (
            <p className="mt-2 text-[11px] text-ink-faint">
              Each minute is scaled by its day type; request shape is unchanged. A per-minute uplift can&apos;t
              forecast how concurrency reshapes true peaks — it assumes peaks grow with volume. No-timestamp data is
              treated as weekday.
            </p>
          )}
        </div>
        {!current.feasible && (
          <p className="mt-2 text-[11px] text-danger">
            ⚠ This baseline drops {fmtTokens(current.droppedTokens)} tokens — about{' '}
            {fmtPctFine(current.droppedRequestPct)} of requests ({fmtNum(current.droppedRequests, 0)}) — demand spikes
            above reservation + cap and can't be served. Raise the baseline (or the spike cap) to serve it.
          </p>
        )}
        {baselineMus == null && (
          <p className="mt-2 text-[11px] text-ink-faint">
            Showing the recommended baseline — the cheapest that serves all demand. Drag to explore,
            then Save to lock it in.
          </p>
        )}
        <Explain>
          <F>TPM per MU = reference TPM ÷ sized MUs = {fmtTokens(ctx.refTpm)} ÷ {fmtNum(ctx.sizedMus)} = {fmtTokens(ctx.tpmPerMu)}/MU</F>
          <F>Capacity = baseline MU × TPM per MU = {fmtNum(current.baselineMus)} × {fmtTokens(ctx.tpmPerMu)} = {fmtTokens(current.capacityTpm)}/min</F>
          <F>Reserved rate/MU·h = DBU/MU (selected term) × $/DBU = {fmtNum(ctx.muToDbu, 5)} × ${fmtNum(ctx.dbuRate, 4)} = ${fmtNum(ctx.muToDbu * ctx.dbuRate, 5)}/MU·h</F>
          <F>Reserved $/hour = baseline MU × rate/MU·h = {fmtNum(current.baselineMus)} × ${fmtNum(ctx.muToDbu * ctx.dbuRate, 5)} = ${fmtNum(current.baselineMus * ctx.muToDbu * ctx.dbuRate, 4)}/h</F>
          <F>Window ({windowLabel}) = $/hour × window hours = ${fmtNum(current.baselineMus * ctx.muToDbu * ctx.dbuRate, 4)} × {fmtNum(ctx.windowHours, 1)}h = {fmtUsd(current.reservedCost)}</F>
          <F>Per month = $/hour × 730h = ${fmtNum(current.baselineMus * ctx.muToDbu * ctx.dbuRate, 4)} × 730 = {fmtUsd(current.baselineMus * ctx.muToDbu * ctx.dbuRate * 730)}</F>
          <div>
            Monthly reserved is independent of the window — it&apos;s MU × DBU/MU × $/DBU × 730. Check
            the DBU/MU above matches your calculator&apos;s value for the <em>selected reservation term</em> (1-day,
            1-week, 1-month and 3-month rates differ), and that $/DBU matches (a discounted rate overrides the model&apos;s
            list rate). Reserved capacity is bound by input throughput: input capacity ={' '}
            {fmtTokens(current.baselineMus * ctx.inputTpmPerMu)}/min. Served coverage = fully-served
            buckets ÷ total; input capacity used = input served ÷ reserved input capacity.
          </div>
        </Explain>
      </div>

      {/* 3 · What that baseline covers against real demand. */}
      <ChartCard title="Usage vs PT capacity">
        <UsageChart
          values={values}
          capacity={current.capacityTpm}
          cap={Number.isFinite(ctx.tpmCap) ? current.capacityTpm + ctx.tpmCap : undefined}
          yLabel="Tokens / min"
          times={ctx.buckets.map((b) => b.t)}
          migrated={migratedValues}
        />
        {migratedShare > 0 && (
          <p className="mt-2 text-[11px] text-ink-faint">
            <span className="font-medium text-violet-500">Migrated traffic</span> is{' '}
            {fmtPct(migratedShare)} of demand tokens ({fmtTokens(migratedTokens)}), stacked on top of
            the base series.
          </p>
        )}
        {usageGranularity === 'tph' && (
          <p className="mt-2 text-[11px] text-ink-faint">
            Hourly data — each point is the hour's average TPM, so sub-hour spikes are smoothed.
          </p>
        )}
      </ChartCard>

      {util.hasTimestamps && (util.weekday.buckets > 0 || util.weekend.buckets > 0) && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="mb-3 text-sm font-medium text-ink">
            Capacity utilization — weekday vs weekend
          </div>
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'Weekday (Mon–Fri)', d: util.weekday },
              { label: 'Weekend (Sat/Sun)', d: util.weekend },
            ].map(({ label, d }) => (
              <div key={label} className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-ink-soft">{label}</span>
                  <span className="font-mono text-lg text-ink">{fmtPct(d.utilizationPct)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${Math.min(100, d.utilizationPct * 100)}%` }}
                  />
                </div>
                <div className="text-[11px] text-ink-faint">
                  {fmtTokens(d.usedTokens)} of {fmtTokens(d.capacityTokens)} reserved used ·{' '}
                  {fmtNum(d.buckets)} buckets
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-ink-faint">
            Share of the reserved baseline actually consumed. A large weekday/weekend gap means a
            flat reservation sits idle part of the week — worth weighing against burst savings.
          </p>
        </div>
      )}

      {/* 4 · How this baseline of PT + PPT impacts cost. */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-ink">Cost impact — PT + PPT at this baseline</div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-faint">Show per</span>
            <PeriodToggle period={period} onChange={setPeriod} windowLabel={windowLabel} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PtPptKpi
            total={current.total * factor}
            reserved={current.reservedCost * factor}
            burst={current.burstCost * factor}
            period={periodLabel}
          />
          <Kpi
            label={`PPT only / ${periodLabel}`}
            value={usd(pptOnly.total)}
            sub={pptOnly.feasible ? undefined : 'infeasible — drops over-cap spikes'}
          />
          <Kpi
            label={`Savings vs PPT / ${periodLabel}`}
            value={usd(Math.abs(savingsVsPpt))}
            sub={savingsVsPpt >= 0 ? 'cheaper' : 'more expensive'}
            good={savingsVsPpt >= 0}
          />
          <Kpi
            label="Recommended baseline"
            value={`${fmtNum(recommended.baselineMus)} MU`}
            sub={`${fmtTokens(recommended.capacityTpm)}/min · ${usd(recommended.total)} / ${periodLabel}`}
          />
        </div>
        <p className="text-[11px] text-ink-faint">
          {period === 'month' ? (
            <>
              Projected to a 730-hour billing month (×{fmtNum(monthFactor, 1)} the{' '}
              {fmtNum(windowDays, 1)}-day window), assuming this window is representative.
              {windowDays < 7 && ' Window is under a week, so treat the monthly figure as rough.'}
            </>
          ) : (
            <>Totals for the uploaded usage window (~{fmtNum(windowDays, 1)} days). Switch to “Month” above for a billing-month estimate.</>
          )}
        </p>
        <Explain>
          <F>PPT cost per bucket = (input tokens × input rate + cached × cache rate + output × output rate) ÷ 1,000,000 × $/DBU</F>
          <div>
            Uses the model rate card&apos;s actual per-component rates on the dataset&apos;s real
            token split (no single blended rate). Buckets without split columns fall back to your
            avg-input/avg-output/cache-% mix.
          </div>
          <F>PPT only = Σ every bucket&apos;s component cost (baseline 0 MU) = {fmtUsd(pptOnly.total)}</F>
          <div>
            Burst gate is <em>input</em> throughput: when a bucket&apos;s input tokens exceed the
            reserved input capacity, the requests that don&apos;t fit spill <em>wholly</em> to PPT —
            their input, output <em>and</em> cache — so the bursting share of the bucket ≈ its
            input-token overflow share (capped at the spike cap).
          </div>
          <F>Burst = Σ (input-overflow share × whole-bucket PPT cost), capped at spike cap = {fmtUsd(current.burstCost)}</F>
          <F>PT + PPT = reserved + burst = {fmtUsd(current.reservedCost)} + {fmtUsd(current.burstCost)} = {fmtUsd(current.total)}</F>
          <F>Savings vs PPT = PPT only − (PT + PPT) = {fmtUsd(pptOnly.total)} − {fmtUsd(current.total)} = {fmtUsd(savingsVsPpt)}</F>
          <div>All shown in the {periodLabel} basis{period === 'month' ? ` (window × ${fmtNum(monthFactor, 2)})` : ''}.</div>
        </Explain>
      </div>

      {/* Reserved throughput valued at PPT rates — was reserving worth it? */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-ink">Reserved PT vs PPT-equivalent</div>
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            per {periodLabel}
          </span>
        </div>
        <p className="mb-3 text-[11px] text-ink-faint">
          The reservation serves {fmtTokens(reservedPpt.servedTokens)} tokens over the {windowLabel}
          . Here&apos;s what those PT-covered tokens would have cost on pay-per-token (split by
          throughput type) versus the reserved cost — so you can see if PPT would have been pricier.
          Burst tokens are excluded (already billed PPT).
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Kpi label={`Reserved PT cost / ${periodLabel}`} value={usd(current.reservedCost)} />
          <Kpi label={`Same tokens on PPT / ${periodLabel}`} value={usd(reservedPpt.total)} />
          <Kpi
            label={reservedVsPpt >= 0 ? 'PT cheaper than PPT here' : 'PPT would be cheaper here'}
            value={usd(Math.abs(reservedVsPpt))}
            sub={reservedVsPpt >= 0 ? 'PPT would cost more for these tokens' : 'reservation costs more than PPT'}
            good={reservedVsPpt >= 0}
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr className="border-b border-line">
                <th className="py-1 pr-3 font-normal">Throughput type</th>
                <th className="py-1 text-right font-normal">If billed PPT / {periodLabel}</th>
              </tr>
            </thead>
            <tbody className="font-mono text-ink">
              {[
                { label: 'Input (billed)', v: reservedPpt.input },
                { label: 'Output', v: reservedPpt.output },
                { label: 'Cached read', v: reservedPpt.cached },
              ].map((r) => (
                <tr key={r.label} className="border-b border-line/50">
                  <td className="py-1 pr-3 font-sans text-ink-soft">{r.label}</td>
                  <td className="py-1 text-right">{usd(r.v)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1 pr-3 font-sans font-medium text-ink">PPT-equivalent total</td>
                <td className="py-1 text-right font-medium">{usd(reservedPpt.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Explain>
          <F>Served tokens = Σ (1 − input-overflow share) × bucket tokens = {fmtTokens(reservedPpt.servedTokens)} (fully-served requests; burst excluded)</F>
          <F>Each component = Σ served tokens × its per-bucket PPT $/token</F>
          <F>= input {fmtUsd(reservedPpt.input)} + output {fmtUsd(reservedPpt.output)} + cached {fmtUsd(reservedPpt.cached)} = {fmtUsd(reservedPpt.total)}</F>
          <F>Gap = PPT-equivalent − reserved cost = {fmtUsd(reservedPpt.total)} − {fmtUsd(current.reservedCost)} = {fmtUsd(reservedVsPpt)}</F>
          <div>A positive gap means PPT would have cost more for the covered tokens, so reserving pays off.</div>
        </Explain>
      </div>

      {/* Window vs month, side by side — a self-check on the extrapolation. */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="mb-1 text-sm font-medium text-ink">Window vs month — validation</div>
        <p className="mb-3 text-[11px] text-ink-faint">
          Per month = usage window × {fmtNum(monthFactor, 2)} (730h ÷ {fmtNum(ctx.windowHours, 1)}h).
          Both columns are derived from the same buckets, so month ÷ window should equal the factor.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr className="border-b border-line">
                <th className="py-1 pr-3 font-normal">Cost</th>
                <th className="py-1 pr-3 text-right font-normal">Usage window ({windowLabel})</th>
                <th className="py-1 text-right font-normal">Per month</th>
              </tr>
            </thead>
            <tbody className="font-mono text-ink">
              {[
                { label: 'PPT only', v: pptOnly.total },
                { label: 'PT reserved', v: current.reservedCost },
                { label: 'PPT burst', v: current.burstCost },
                { label: 'PT + PPT total', v: current.total },
              ].map((r) => (
                <tr key={r.label} className="border-b border-line/50">
                  <td className="py-1 pr-3 font-sans text-ink-soft">{r.label}</td>
                  <td className="py-1 pr-3 text-right">{fmtUsd(r.v)}</td>
                  <td className="py-1 text-right">{fmtUsd(r.v * monthFactor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Models ────────────────────────────────────────────────────────────────────
const EMPTY_MODEL: ModelInput = {
  name: '',
  sku: '',
  mu_to_dbu_1mo: 0,
  mu_to_dbu_3mo: 0,
  mu_to_dbu_1d: 0,
  mu_to_dbu_1w: 0,
  dbu_rate: 0,
  std_input_dbu: 0,
  std_output_dbu: 0,
  std_cache_dbu: 0,
  pri_input_dbu: 0,
  pri_output_dbu: 0,
  pri_cache_dbu: 0,
  notes: '',
}

function ModelsTab({ models }: { models: PtModelRow[] }) {
  const [editing, setEditing] = useState<PtModelRow | 'new' | null>(null)

  if (editing) {
    return <ModelForm model={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setEditing('new')}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
        >
          + New model
        </button>
      </div>
      {models.length === 0 ? (
        <Notice>
          No models yet. A model rate card holds the MU→DBU capacity factor, the SKU&apos;s $/DBU,
          and the Standard/Priority PPT rates (in DBU per 1M tokens).
        </Notice>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setEditing(m)}
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong"
            >
              <div>
                <div className="font-medium text-ink">{m.name}</div>
                <div className="mt-0.5 font-mono text-xs text-ink-faint">
                  {m.sku || 'no SKU'} · {fmtNum(muToDbuFor(m, '1d'), 3)}/{fmtNum(muToDbuFor(m, '1w'), 3)}/{fmtNum(m.mu_to_dbu_1mo, 3)}/
                  {fmtNum(m.mu_to_dbu_3mo, 3)} DBU/MU (1d/1w/1mo/3mo) · ${fmtNum(m.dbu_rate, 3)}/DBU
                </div>
              </div>
              <div className="shrink-0 text-right font-mono text-[11px] text-ink-faint">
                std in/out {fmtNum(m.std_input_dbu, 2)}/{fmtNum(m.std_output_dbu, 2)} DBU/1M
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ModelForm({ model, onClose }: { model: PtModelRow | null; onClose: () => void }) {
  const [id] = useState(model?.id ?? crypto.randomUUID())
  const [draft, setDraft] = useState<ModelInput>(() =>
    model
      ? {
          name: model.name,
          sku: model.sku,
          mu_to_dbu_1mo: model.mu_to_dbu_1mo,
          mu_to_dbu_3mo: model.mu_to_dbu_3mo,
          mu_to_dbu_1d: muToDbuFor(model, '1d'),
          mu_to_dbu_1w: muToDbuFor(model, '1w'),
          dbu_rate: model.dbu_rate,
          std_input_dbu: model.std_input_dbu,
          std_output_dbu: model.std_output_dbu,
          std_cache_dbu: model.std_cache_dbu,
          pri_input_dbu: model.pri_input_dbu,
          pri_output_dbu: model.pri_output_dbu,
          pri_cache_dbu: model.pri_cache_dbu,
          notes: model.notes,
        }
      : { ...EMPTY_MODEL },
  )
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()
  const set = (patch: Partial<ModelInput>) => setDraft((d) => ({ ...d, ...patch }))

  // $ per 1M tokens for a PPT rate = (DBU per 1M tokens) × ($ per DBU). Shown as a
  // hint under each rate so the card reads in dollars, not just DBU. Blank until a
  // $/DBU is set (otherwise the whole column would read $0.00).
  const per1M = (dbu: number): string | undefined => {
    if (!draft.dbu_rate || !Number.isFinite(dbu)) return undefined
    const usd = dbu * draft.dbu_rate
    return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 })} / 1M`
  }

  async function save() {
    if (!draft.name.trim()) return
    setSaving(true)
    try {
      await saveModel(id, draft)
      onClose()
    } catch {
      setSaving(false)
    }
  }

  async function remove() {
    if (!model) return
    const ok = await confirm({
      title: 'Delete model',
      message: `Delete rate card “${model.name}”? Simulations using it will need another model. This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await deleteModel(model.id)
    onClose()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button onClick={onClose} className="text-sm text-ink-faint hover:text-ink">
          ← Models
        </button>
        <div className="flex gap-2">
          {model && (
            <button
              onClick={remove}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-danger hover:bg-danger/5"
            >
              Delete
            </button>
          )}
          <button
            onClick={save}
            disabled={saving || !draft.name.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
          >
            {saving ? 'Saving…' : model ? 'Save' : 'Create'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Model name">
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder="e.g. gpt-oss-120b" />
        </Field>
        <Field label="SKU">
          <input value={draft.sku} onChange={(e) => set({ sku: e.target.value })} className={inputCls} placeholder="e.g. GPU_LARGE" />
        </Field>
      </div>

      <Fieldset legend="Capacity & DBU rate">
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField
            label="DBU per MU/hr — 1 day"
            value={draft.mu_to_dbu_1d}
            onChange={(v) => set({ mu_to_dbu_1d: v })}
            hint="Defaults to 2× the 1-month rate"
          />
          <NumField
            label="DBU per MU/hr — 1 week"
            value={draft.mu_to_dbu_1w}
            onChange={(v) => set({ mu_to_dbu_1w: v })}
            hint="Defaults to 1.75× the 1-month rate"
          />
          <NumField
            label="DBU per MU/hr — 1 month"
            value={draft.mu_to_dbu_1mo}
            onChange={(v) =>
              // Editing the 1-month rate re-derives the 1-day / 1-week premiums; override them after.
              set({
                mu_to_dbu_1mo: v,
                mu_to_dbu_1d: v * SHORT_TERM_MULTIPLIER['1d'],
                mu_to_dbu_1w: v * SHORT_TERM_MULTIPLIER['1w'],
              })
            }
          />
          <NumField label="DBU per MU/hr — 3 month" value={draft.mu_to_dbu_3mo} onChange={(v) => set({ mu_to_dbu_3mo: v })} />
          <NumField label="$ per DBU (list)" value={draft.dbu_rate} onChange={(v) => set({ dbu_rate: v })} />
        </div>
      </Fieldset>

      <Fieldset legend="Standard PPT (DBU per 1M tokens)">
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField label="Input" value={draft.std_input_dbu} onChange={(v) => set({ std_input_dbu: v })} hint={per1M(draft.std_input_dbu)} />
          <NumField label="Output" value={draft.std_output_dbu} onChange={(v) => set({ std_output_dbu: v })} hint={per1M(draft.std_output_dbu)} />
          <NumField label="Cached read" value={draft.std_cache_dbu} onChange={(v) => set({ std_cache_dbu: v })} hint={per1M(draft.std_cache_dbu)} />
        </div>
      </Fieldset>

      <Fieldset legend="Priority PPT (DBU per 1M tokens)">
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField label="Input" value={draft.pri_input_dbu} onChange={(v) => set({ pri_input_dbu: v })} hint={per1M(draft.pri_input_dbu)} />
          <NumField label="Output" value={draft.pri_output_dbu} onChange={(v) => set({ pri_output_dbu: v })} hint={per1M(draft.pri_output_dbu)} />
          <NumField label="Cached read" value={draft.pri_cache_dbu} onChange={(v) => set({ pri_cache_dbu: v })} hint={per1M(draft.pri_cache_dbu)} />
        </div>
      </Fieldset>

      <Field label="Notes">
        <textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} className={`${inputCls} min-h-[70px]`} />
      </Field>
    </div>
  )
}

// ── Usage datasets ──────────────────────────────────────────────────────────
type UsageView = { mode: 'list' } | { mode: 'detail'; id: string } | { mode: 'compare'; ids: string[] }

function UsageTab({ usage }: { usage: PtUsageRow[] }) {
  const [uploading, setUploading] = useState(false)
  const [view, setView] = useState<UsageView>({ mode: 'list' })
  const [selected, setSelected] = useState<string[]>([])

  // Resolve the active view against live data — a dataset deleted elsewhere
  // falls back to the list instead of rendering a dangling view.
  const viewingRow = view.mode === 'detail' ? usage.find((u) => u.id === view.id) : undefined
  const compareRows =
    view.mode === 'compare'
      ? (view.ids.map((id) => usage.find((u) => u.id === id)).filter(Boolean) as PtUsageRow[])
      : []

  function toggleSelect(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < 2 ? [...s, id] : s))
  }
  const back = () => setView({ mode: 'list' })

  // ── Detail: one dataset's charts ──
  if (view.mode === 'detail' && viewingRow) {
    return (
      <div className="space-y-4">
        <button onClick={back} className="text-sm text-ink-faint hover:text-ink">
          ← All datasets
        </button>
        <UsageCard
          u={viewingRow}
          onDelete={async () => {
            await deleteUsage(viewingRow.id)
            back()
          }}
        />
      </div>
    )
  }

  // ── Compare: two datasets side by side ──
  if (view.mode === 'compare' && compareRows.length === 2) {
    return (
      <div className="space-y-4">
        <button onClick={back} className="text-sm text-ink-faint hover:text-ink">
          ← All datasets
        </button>
        <div className="grid gap-4 lg:grid-cols-2">
          {compareRows.map((u) => (
            <UsageCard key={u.id} u={u} showDelete={false} />
          ))}
        </div>
      </div>
    )
  }

  // ── List (default) ──
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setUploading((v) => !v)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
        >
          {uploading ? 'Close' : '+ Upload CSV'}
        </button>
      </div>

      {uploading && <UsageUpload usage={usage} onDone={() => setUploading(false)} />}

      {usage.length === 0 ? (
        <Notice>
          No usage datasets yet. Upload a CSV of real usage — per-minute TPM or hourly token totals
          across dates — and attach it to simulations to size bursts.
        </Notice>
      ) : (
        <>
          <p className="text-[11px] text-ink-faint">
            Click a dataset to view its charts, or tick two to compare them side by side.
          </p>
          <div className="space-y-2">
            {usage.map((u) => (
              <UsageRow
                key={u.id}
                u={u}
                selected={selected.includes(u.id)}
                disableSelect={selected.length >= 2 && !selected.includes(u.id)}
                onToggle={() => toggleSelect(u.id)}
                onOpen={() => setView({ mode: 'detail', id: u.id })}
              />
            ))}
          </div>
          {selected.length > 0 && (
            <div className="sticky bottom-3 flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 shadow-md">
              <span className="text-xs text-ink-soft">
                {selected.length} selected {selected.length === 1 ? '(pick one more to compare)' : ''}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setSelected([])} className="text-xs text-ink-faint hover:text-ink">
                  Clear
                </button>
                <button
                  onClick={() => setView({ mode: 'compare', ids: selected })}
                  disabled={selected.length !== 2}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
                >
                  Compare
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Compact list row: name + summary, a compare checkbox, open, and delete. */
function UsageRow({
  u,
  selected,
  disableSelect,
  onToggle,
  onOpen,
}: {
  u: PtUsageRow
  selected: boolean
  disableSelect: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const confirm = useConfirm()
  const points = useMemo(() => parseUsagePoints(u), [u])
  const bucketMin = u.granularity === 'tph' ? 60 : 1
  const perMin = points.map((p) => p.total / bucketMin)
  const peak = perMin.length ? Math.max(...perMin) : 0
  const total = points.reduce((a, p) => a + p.total, 0)

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border bg-surface p-3 transition-colors ${
        selected ? 'border-accent' : 'border-line hover:border-line-strong'
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disableSelect}
        onChange={onToggle}
        title={disableSelect ? 'Two datasets already selected' : 'Select to compare'}
        className="h-4 w-4 shrink-0 accent-accent disabled:opacity-40"
      />
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate font-medium text-ink">{u.name}</div>
        <div className="mt-0.5 font-mono text-xs text-ink-faint">
          {u.granularity === 'tph' ? 'hourly' : 'per-minute'} · {u.row_count} rows · peak{' '}
          {fmtTokens(peak)}/min · {fmtTokens(total)} total
        </div>
      </button>
      <button
        onClick={onOpen}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:text-ink"
      >
        Open
      </button>
      <button
        onClick={async () => {
          const ok = await confirm({
            title: 'Delete dataset',
            message: `Delete “${u.name}” (${u.row_count} rows)? Simulations using it will lose their usage data. This can’t be undone.`,
            confirmLabel: 'Delete',
            danger: true,
          })
          if (ok) await deleteUsage(u.id)
        }}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-danger hover:bg-danger/5"
      >
        Delete
      </button>
    </div>
  )
}

/** Peak + P90 for an optional per-point metric; null when no point carries it. */
function peakP90(points: UsagePoint[], get: (p: UsagePoint) => number | null) {
  const vals = points.map(get).filter((v): v is number => v != null && Number.isFinite(v))
  if (!vals.length) return null
  return { peak: Math.max(...vals), p90: percentile(vals, 90) }
}

/** Avg + P90 + peak for an optional per-point metric; null when no point carries it. */
function metricStats(points: UsagePoint[], get: (p: UsagePoint) => number | null) {
  const vals = points.map(get).filter((v): v is number => v != null && Number.isFinite(v))
  if (!vals.length) return null
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length
  return { avg, p90: percentile(vals, 90), peak: Math.max(...vals) }
}

/**
 * Reference sizing metrics derived from a (possibly blended) usage series, so a
 * migration scenario can be sized without knowing the numbers up front: read them
 * off, feed the MU sizer, paste the MUs back. RPM is the mean requests/min; the
 * per-request token averages and cache % are VOLUME-WEIGHTED (Σtokens ÷ Σrequests,
 * Σcached ÷ Σinput) so a blended series reads correctly rather than being skewed by
 * quiet buckets. Returns null when there's no series to derive from.
 */
function deriveSizing(points: UsagePoint[], granularity: 'tpm' | 'tph') {
  if (points.length === 0) return null
  const minutesPer = granularity === 'tph' ? 60 : 1
  let reqs = 0
  let input = 0
  let output = 0
  let cached = 0
  let tokens = 0
  let rpmSum = 0
  let rpmBuckets = 0
  let hasInput = false
  let hasOutput = false
  let hasCached = false
  for (const p of points) {
    tokens += Math.max(0, p.total)
    if (p.rpm != null) {
      rpmSum += p.rpm
      rpmBuckets++
      reqs += p.rpm * minutesPer
    }
    if (p.input != null) {
      input += Math.max(0, p.input)
      hasInput = true
    }
    if (p.output != null) {
      output += Math.max(0, p.output)
      hasOutput = true
    }
    if (p.cached != null) {
      cached += Math.max(0, p.cached)
      hasCached = true
    }
  }
  const totalMinutes = points.length * minutesPer
  return {
    buckets: points.length,
    rpm: rpmBuckets > 0 ? rpmSum / rpmBuckets : 0,
    avgInput: reqs > 0 && hasInput ? input / reqs : 0,
    avgOutput: reqs > 0 && hasOutput ? output / reqs : 0,
    cachePct: hasInput && hasCached && input > 0 ? (cached / input) * 100 : 0,
    avgTpm: totalMinutes > 0 ? tokens / totalMinutes : 0,
    hasReqs: reqs > 0,
    hasSplit: hasInput || hasOutput,
  }
}

/** Extra peak/p90 line for rpm + per-request averages, when the dataset carries them. */
function rateStatLine(points: UsagePoint[]): string | null {
  const rpm = peakP90(points, (p) => p.rpm)
  const ai = peakP90(points, (p) => p.avg_input)
  const ao = peakP90(points, (p) => p.avg_output)
  const parts: string[] = []
  if (rpm) parts.push(`rpm peak/p90 ${fmtNum(rpm.peak, 0)}/${fmtNum(rpm.p90, 0)}`)
  if (ai) parts.push(`in/req peak/p90 ${fmtTokens(ai.peak)}/${fmtTokens(ai.p90)}`)
  if (ao) parts.push(`out/req peak/p90 ${fmtTokens(ao.peak)}/${fmtTokens(ao.p90)}`)
  return parts.length ? parts.join(' · ') : null
}

function UsageCard({
  u,
  showDelete = true,
  onDelete,
}: {
  u: PtUsageRow
  showDelete?: boolean
  onDelete?: () => void | Promise<void>
}) {
  const confirm = useConfirm()
  const points = useMemo(() => parseUsagePoints(u), [u])
  const bucketMin = u.granularity === 'tph' ? 60 : 1
  const values = points.map((p) => p.total / bucketMin)
  const peak = values.length ? Math.max(...values) : 0
  const p90 = percentile(values, 90)
  const total = points.reduce((a, p) => a + p.total, 0)

  // Per-request series — only present when the CSV carried the columns. Charted
  // separately from throughput so nothing is cramped onto one axis.
  const rpm = metricStats(points, (p) => p.rpm)
  const inTok = metricStats(points, (p) => p.avg_input)
  const outTok = metricStats(points, (p) => p.avg_output)
  const rpmSeries = points.map((p) => p.rpm ?? 0)
  const inSeries = points.map((p) => p.avg_input ?? 0)
  const outSeries = points.map((p) => p.avg_output ?? 0)
  const times = points.map((p) => p.t)
  const hasAvg = !!inTok || !!outTok

  const tiles: { label: string; value: string }[] = [
    { label: 'Total tokens', value: fmtTokens(total) },
    { label: 'Peak / min', value: `${fmtTokens(peak)}` },
    { label: 'P90 / min', value: `${fmtTokens(p90)}` },
  ]
  if (rpm) {
    tiles.push({ label: 'Avg req / min', value: fmtNum(rpm.avg, 0) })
    tiles.push({ label: 'Peak req / min', value: fmtNum(rpm.peak, 0) })
  }
  if (inTok) tiles.push({ label: 'Avg in / req', value: fmtTokens(inTok.avg) })
  if (outTok) tiles.push({ label: 'Avg out / req', value: fmtTokens(outTok.avg) })

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-ink">{u.name}</div>
          <div className="mt-0.5 font-mono text-xs text-ink-faint">
            {u.granularity === 'tph' ? 'hourly' : 'per-minute'} · {u.row_count} rows
          </div>
        </div>
        {showDelete && (
          <button
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete dataset',
                message: `Delete “${u.name}” (${u.row_count} rows)? Simulations using it will lose their usage data. This can’t be undone.`,
                confirmLabel: 'Delete',
                danger: true,
              })
              if (ok) await (onDelete ? onDelete() : deleteUsage(u.id))
            }}
            className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-danger hover:bg-danger/5"
          >
            Delete
          </button>
        )}
      </div>

      {/* Tidy metric tiles — one figure per cell, no cramped mono run-on. */}
      <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Stat key={t.label} label={t.label} value={t.value} />
        ))}
      </div>

      {values.length > 0 && (
        <div className="space-y-5">
          <ChartBlock title="Throughput — tokens / min">
            <UsageChart values={values} yLabel="Tokens / min" times={times} />
          </ChartBlock>

          {rpm && (
            <ChartBlock title="Requests / min">
              <LineChart values={rpmSeries} yLabel="Requests / min" fmtY={(n) => fmtNum(n, 0)} times={times} />
            </ChartBlock>
          )}
          {hasAvg && (
            <ChartBlock title="Avg tokens / request">
              <TwoLineChart
                a={{ values: inSeries, label: 'Input / req', line: 'text-accent', swatch: 'bg-accent' }}
                b={{ values: outSeries, label: 'Output / req', line: 'text-ink-soft', swatch: 'bg-ink-soft' }}
                yLabel="Tokens / request"
                times={times}
              />
            </ChartBlock>
          )}
        </div>
      )}
    </div>
  )
}

/** A titled sub-chart block inside a card (lighter than a full ChartCard). */
function ChartBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-faint">{title}</div>
      {children}
    </div>
  )
}

function UsageUpload({ usage, onDone }: { usage: PtUsageRow[]; onDone: () => void }) {
  const [name, setName] = useState('')
  const [granularity, setGranularity] = useState<'tpm' | 'tph'>('tpm')
  const [points, setPoints] = useState<UsagePoint[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [fileName, setFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function onFile(file: File) {
    const text = await file.text()
    const parsed = parseUsageCsv(text, granularity)
    setPoints(parsed.points)
    setWarnings(parsed.warnings)
    setFileName(file.name)
    if (!name) setName(file.name.replace(/\.csv$/i, ''))
  }

  function reparse(g: 'tpm' | 'tph') {
    setGranularity(g)
    // Re-parse is only possible if we still have the file; keep it simple and
    // ask the user to re-pick if they change granularity after selecting.
    if (points.length) {
      setPoints([])
      setFileName('')
      setWarnings(['Granularity changed — re-select the file.'])
    }
  }

  function downloadTemplate() {
    const blob = new Blob([usageTemplate(granularity)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pt-usage-template-${granularity}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Same (case-insensitive) name → replace that dataset in place, so simulations
  // referencing it by id automatically pick up the new data.
  const dup = usage.find((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase())

  async function save() {
    if (!name.trim() || points.length === 0) return
    // Same-name upload replaces in place — make the user confirm first.
    if (dup && !confirming) {
      setConfirming(true)
      return
    }
    setSaving(true)
    try {
      await saveUsage(dup?.id ?? crypto.randomUUID(), { name: name.trim(), granularity, points })
      onDone()
    } catch {
      setSaving(false)
    }
  }

  const perMin = points.map((p) => p.total / (granularity === 'tph' ? 60 : 1))
  const peak = perMin.length ? Math.max(...perMin) : 0
  const p90 = percentile(perMin, 90)

  return (
    <div className="space-y-4 rounded-lg border border-line bg-surface p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Dataset name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Acme prod — Sept" />
          {dup && (
            <p className="mt-1 text-[11px] text-accent">
              Replaces “{dup.name}” ({dup.row_count} rows) — simulations using it pick up the new data.
            </p>
          )}
        </Field>
        <Field label="Granularity">
          <div className="flex gap-1">
            {(['tpm', 'tph'] as const).map((g) => (
              <button
                key={g}
                onClick={() => reparse(g)}
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  granularity === g ? 'border-accent bg-accent/10 text-ink' : 'border-line text-ink-soft'
                }`}
              >
                {g === 'tpm' ? 'Per-minute TPM' : 'Tokens / hour'}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:text-ink">
          {fileName || 'Choose CSV…'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
        <button onClick={downloadTemplate} className="text-sm text-accent hover:underline">
          Download {granularity} template
        </button>
      </div>

      {warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-danger">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {points.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-xs text-ink-faint">
            {points.length} rows parsed · peak {fmtTokens(peak)}/min · p90 {fmtTokens(p90)}/min
          </div>
          {rateStatLine(points) && (
            <div className="font-mono text-xs text-ink-faint">{rateStatLine(points)}</div>
          )}
          <UsageChart values={perMin} yLabel="Tokens / min" />
        </div>
      )}

      {confirming && dup && (
        <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-xs">
          <p className="text-ink">
            A dataset named “{dup.name}” already exists ({dup.row_count} rows). Uploading{' '}
            <strong>replaces its data in place</strong> — any simulation using it will switch to the
            new data. This can’t be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? 'Replacing…' : 'Replace data'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft"
            >
              Keep existing
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft">
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving || !name.trim() || points.length === 0 || (confirming && !!dup)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-40"
        >
          {saving ? 'Saving…' : dup ? 'Replace dataset…' : 'Save dataset'}
        </button>
      </div>
    </div>
  )
}

// ── small shared UI ─────────────────────────────────────────────────────────
const inputCls = 'w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink'
const selectCls = inputCls

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      {children}
    </label>
  )
}

function NumField({
  label,
  value,
  onChange,
  hint,
  nullable,
}: {
  label: string
  value: number | null
  onChange: (v: number) => void
  hint?: string
  nullable?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' && nullable ? (null as never) : Number(e.target.value))}
        className={`${inputCls} font-mono`}
      />
      {hint && <span className="mt-0.5 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  )
}

/** A labeled 0–max% slider with a paired numeric input — used for the reserved-
 *  baseline growth controls. Values outside the slider range are still typable. */
function PctSlider({
  label,
  value,
  onChange,
  max = 100,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  max?: number
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-ink-soft">{label}</span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            step={1}
            value={value}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) onChange(v)
            }}
            className="w-14 rounded border border-line bg-surface px-1.5 py-0.5 text-right font-mono text-xs text-ink"
          />
          <span className="text-[11px] text-ink-faint">%</span>
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(max, Math.max(0, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  )
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-line p-4">
      <legend className="px-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        {legend}
      </legend>
      {children}
    </fieldset>
  )
}

function Kpi({
  label,
  value,
  sub,
  accent,
  good,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
  good?: boolean
}) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'border-accent/40 bg-accent/5' : 'border-line bg-surface'}`}>
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-ink">{value}</div>
      {sub && (
        <div className={`mt-0.5 text-[11px] ${good === undefined ? 'text-ink-faint' : good ? 'text-accent' : 'text-danger'}`}>
          {sub}
        </div>
      )}
    </div>
  )
}

/** PT+PPT total with a split bar making the PT (reserved) vs PPT (burst) plot clear. */
function PtPptKpi({
  total,
  reserved,
  burst,
  period,
}: {
  total: number
  reserved: number
  burst: number
  period?: string
}) {
  const t = reserved + burst || 1
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">
        PT + PPT{period ? ` / ${period}` : ' (this baseline)'}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold text-ink">{fmtUsd(total)}</div>
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full bg-accent" style={{ width: `${(reserved / t) * 100}%` }} title={`PT reserved ${fmtUsd(reserved)}`} />
        <div className="h-full bg-danger/50" style={{ width: `${(burst / t) * 100}%` }} title={`PPT burst ${fmtUsd(burst)}`} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-accent" aria-hidden />PT {fmtUsd(reserved)}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-danger/50" aria-hidden />PPT {fmtUsd(burst)}
        </span>
      </div>
    </div>
  )
}

/** Toggle every cost figure between the raw usage window and a projected month. */
function PeriodToggle({
  period,
  onChange,
  windowLabel,
}: {
  period: 'window' | 'month'
  onChange: (p: 'window' | 'month') => void
  windowLabel: string
}) {
  const opts: { k: 'window' | 'month'; label: string }[] = [
    { k: 'window', label: 'Usage window' },
    { k: 'month', label: 'Month' },
  ]
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Cost period">
      {opts.map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          aria-pressed={period === o.k}
          title={o.k === 'window' ? windowLabel : 'Projected 730-hour billing month'}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            period === o.k ? 'bg-surface-sunken text-ink' : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Collapsible "how this is derived" panel — tinted so it stands out when
 *  walking someone through a card. Give it the formulas as children. */
function Explain({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
      >
        <span className="font-mono text-[9px]" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {open ? 'Hide details / formulas' : 'Details / formulas'}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-md border border-accent/30 bg-accent/5 p-3 text-[11px] leading-relaxed text-ink-soft">
          {children}
        </div>
      )}
    </div>
  )
}

/** A single formula/derivation line inside an Explain panel. */
function F({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-ink">{children}</div>
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-ink-faint">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-ink">{value}</div>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 text-sm font-medium text-ink">{title}</div>
      {children}
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface-sunken/40 p-4 text-sm text-ink-soft">
      {children}
    </div>
  )
}
