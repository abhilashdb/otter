/**
 * Reserved PT estimator — the cost model.
 *
 * All math runs client-side so the user can iterate instantly. Nothing here
 * touches the network or the DB; the tool page feeds in a model rate card, a
 * scenario's inputs, and a parsed usage series, and gets back a cost breakdown
 * plus a baseline sweep.
 *
 * Units & conventions
 * -------------------
 * - PPT rates are **DBU per 1,000,000 tokens** (input / output / cached read),
 *   per tier (Standard / Priority). Dollars = DBU × $/DBU (list, or a
 *   scenario's discounted rate).
 * - Reserved PT capacity is bought in **Model Units (MUs)**; each MU costs
 *   `mu_to_dbu` DBU per hour, so reserved $/hr = MUs × mu_to_dbu × $/DBU.
 * - MUs can't be derived here (sized in a separate app). The scenario pastes in
 *   the MUs that its (RPM, avg tokens) reference point sized to; that calibrates
 *   TPM-per-MU, letting us evaluate *any* reserved baseline against real usage.
 * - Spikes are capped at `tpm_cap` tokens/minute; anything above the cap is not
 *   served (and so not billed).
 */
import type { PtModelRow, PtScenarioRow, UsagePoint } from './db'

export type Tier = 'standard' | 'priority'

// ── CSV parsing ───────────────────────────────────────────────────────────────
export interface ParsedUsage {
  points: UsagePoint[]
  warnings: string[]
}

const TS_KEYS = ['timestamp', 'time', 'datetime', 'date', 'hour', 'minute', 'ts']
const VALUE_KEYS: Record<'tpm' | 'tph', string[]> = {
  tpm: ['tpm', 'tokens_per_minute', 'tokens', 'total', 'value'],
  tph: ['tph', 'tokens_per_hour', 'tokens', 'total', 'value'],
}

function splitCsvLine(line: string): string[] {
  // Minimal CSV: handles optionally-quoted fields; usage data is numeric so we
  // don't need full RFC-4180 escaping.
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function num(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw.replace(/[, ]/g, '')) // tolerate thousands separators / spaces
  return Number.isFinite(n) ? n : null
}

/** Parse an uploaded CSV into normalized usage points for the chosen granularity. */
export function parseUsageCsv(text: string, granularity: 'tpm' | 'tph'): ParsedUsage {
  const warnings: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { points: [], warnings: ['File is empty.'] }

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const idx = (keys: string[]) => header.findIndex((h) => keys.includes(h))
  const tsi = idx(TS_KEYS)
  const vi = idx(VALUE_KEYS[granularity])
  const ii = idx(['input', 'input_tokens'])
  const oi = idx(['output', 'output_tokens'])
  const ci = idx(['cached', 'cached_tokens', 'cache'])
  // Alternative shape: requests/min + avg tokens per request → derive tokens.
  const ri = idx(['rpm', 'requests_per_minute', 'requests', 'req_per_min'])
  const aii = idx(['avg_input_per_request', 'avg_input', 'avg_input_tokens', 'avg_in'])
  const aoi = idx(['avg_output_per_request', 'avg_output', 'avg_output_tokens', 'avg_out'])
  // Hourly rows need rpm scaled to the hour; per-minute rows use it directly.
  const rpmMult = granularity === 'tph' ? 60 : 1

  if (vi < 0 && ii < 0 && oi < 0 && ri < 0) {
    return {
      points: [],
      warnings: [
        `No value column found. Expected one of: ${VALUE_KEYS[granularity].join(', ')}, ` +
          'input/output/cached, or rpm + avg_input/avg_output.',
      ],
    }
  }
  if (tsi < 0) warnings.push('No timestamp column — points will be treated as an ordered series.')

  const points: UsagePoint[] = []
  let bad = 0
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r])
    let input = ii >= 0 ? num(cells[ii]) : null
    let output = oi >= 0 ? num(cells[oi]) : null
    const cached = ci >= 0 ? num(cells[ci]) : null
    let total = vi >= 0 ? num(cells[vi]) : null
    if (total == null) {
      const parts = [input, output, cached].filter((x): x is number => x != null)
      total = parts.length ? parts.reduce((a, b) => a + b, 0) : null
    }
    // Requests/min + per-request averages (kept for stats; also derive tokens).
    const rpm = ri >= 0 ? num(cells[ri]) : null
    let avgIn = aii >= 0 ? num(cells[aii]) : null
    let avgOut = aoi >= 0 ? num(cells[aoi]) : null
    // Derive from requests/min × avg tokens when no direct token value is given.
    if (total == null && rpm != null) {
      const ain = avgIn ?? 0
      const aout = avgOut ?? 0
      if (rpm > 0 && ain + aout > 0) {
        total = rpm * rpmMult * (ain + aout)
        if (input == null) input = rpm * rpmMult * ain
        if (output == null) output = rpm * rpmMult * aout
      }
    }
    if (total == null) {
      bad++
      continue
    }
    // Fallback: derive per-request averages from bucket totals ÷ requests.
    const reqs = rpm != null ? rpm * rpmMult : null
    if (avgIn == null && input != null && reqs && reqs > 0) avgIn = input / reqs
    if (avgOut == null && output != null && reqs && reqs > 0) avgOut = output / reqs
    let t: number | null = null
    if (tsi >= 0 && cells[tsi]) {
      const parsed = Date.parse(cells[tsi])
      t = Number.isNaN(parsed) ? null : parsed
    }
    points.push({ t, total, input, output, cached, rpm, avg_input: avgIn, avg_output: avgOut })
  }
  if (bad) warnings.push(`Skipped ${bad} row${bad === 1 ? '' : 's'} with no readable value.`)
  // Sort by time when we have it (keeps the chart honest for out-of-order rows).
  if (points.every((p) => p.t != null)) points.sort((a, b) => (a.t as number) - (b.t as number))
  return { points, warnings }
}

/** A ready-to-fill template CSV for the chosen granularity. */
export function usageTemplate(granularity: 'tpm' | 'tph'): string {
  if (granularity === 'tpm') {
    return [
      '# Per-minute usage. tpm = tokens served in that minute.',
      '# input/output/cached are optional (same unit); leave blank to split by the model average.',
      '# rpm,avg_input_per_request,avg_output_per_request = requests in that minute + avg tokens/request.',
      'timestamp,tpm,input,output,cached,rpm,avg_input_per_request,avg_output_per_request',
      '2026-09-01T09:00:00Z,8200000,5000000,3200000,500000,1000,5000,3200',
      '2026-09-01T09:01:00Z,9100000,5600000,3500000,600000,1000,5600,3500',
      '2026-09-01T09:02:00Z,21500000,13000000,8500000,1500000,1000,13000,8500',
    ].join('\n')
  }
  return [
    '# Hourly usage. tokens = total tokens served in that hour.',
    '# input/output/cached are optional (same unit); leave blank to split by the model average.',
    '# rpm,avg_input_per_request,avg_output_per_request = requests per minute + avg tokens/request.',
    'timestamp,tokens,input,output,cached,rpm,avg_input_per_request,avg_output_per_request',
    '2026-09-01T09:00:00Z,480000000,250000000,200000000,30000000,1000,4167,3333',
    '2026-09-01T10:00:00Z,610000000,320000000,250000000,40000000,1000,5333,4167',
    '2026-09-01T11:00:00Z,995000000,520000000,410000000,65000000,1000,8667,6833',
  ].join('\n')
}

/** Nth-percentile of a set of numbers (nearest-rank). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[rank]
}

// ── Cost model ──────────────────────────────────────────────────────────────
export interface Bucket {
  t: number | null // epoch ms for this bucket, or null when the CSV had no timestamp
  tpm: number // per-minute demand rate for this bucket
  migratedTpm: number // per-minute rate of migrated-in demand within tpm (0 without a blend)
  minutes: number
  tokens: number // demand tokens in this bucket (uncapped)
  requests: number // requests in this bucket (from rpm when present, else tokens ÷ avg req size)
  inputTokens: number // total input tokens (fresh + cached) — the burst gate dimension
  ratePerToken: number // blended PPT $/token for this bucket (= rateInput+rateCached+rateOutput)
  rateInput: number // PPT $/token attributable to (fresh, billed) input
  rateCached: number // PPT $/token attributable to cache reads
  rateOutput: number // PPT $/token attributable to output
  weekend: boolean // Sat/Sun in local time (false when no timestamp)
}

export interface CalcContext {
  ok: boolean
  reason?: string
  tpmPerMu: number
  inputTpmPerMu: number // input-tokens/min served per MU — the reservation's binding dimension
  refTpm: number
  sizedMus: number
  muToDbu: number
  dbuRate: number
  tpmCap: number
  tier: Tier
  windowHours: number
  totalMinutes: number
  buckets: Bucket[]
  peakServedTpm: number
  peakInputTpm: number // peak per-minute input demand (drives feasible sizing)
  avgTpm: number
  totalServedTokens: number
  hasTimestamps: boolean // buckets carry real timestamps → weekday/weekend split is meaningful
}

export interface Evaluation {
  baselineMus: number
  capacityTpm: number
  reservedCost: number
  burstCost: number
  total: number
  burstTokens: number
  droppedTokens: number // demand above reservation + burst cap — cannot be served
  droppedRequests: number // whole requests dropped (bursting requests over the cap)
  droppedRequestPct: number // droppedRequests ÷ total requests
  feasible: boolean // true when no demand is dropped (serves the whole series)
  coveragePct: number // fraction of buckets fully served (reservation + burst)
  utilizationPct: number // fraction of reserved capacity actually used
  wastedTokens: number // reserved capacity that went unused
}

function resolveShares(scn: PtScenarioRow): { fresh: number; cached: number; output: number } {
  // Default token mix when a usage row has no input/output/cached split:
  // of the per-request tokens (avg in + avg out), a cache_pct share of the
  // *input* is billed as cached reads, the rest of input as fresh input.
  const inTok = Math.max(0, scn.avg_input_tokens)
  const outTok = Math.max(0, scn.avg_output_tokens)
  const denom = inTok + outTok || 1
  const inputShare = inTok / denom
  const outputShare = outTok / denom
  const cacheFrac = Math.min(1, Math.max(0, scn.cache_pct / 100))
  return {
    fresh: inputShare * (1 - cacheFrac),
    cached: inputShare * cacheFrac,
    output: outputShare,
  }
}

function tierRates(model: PtModelRow, tier: Tier) {
  return tier === 'priority'
    ? { rIn: model.pri_input_dbu, rOut: model.pri_output_dbu, rCache: model.pri_cache_dbu }
    : { rIn: model.std_input_dbu, rOut: model.std_output_dbu, rCache: model.std_cache_dbu }
}

/** Reservation terms, shortest → longest. Short terms carry a premium over the
 *  1-month rate: 1 day = 2x, 1 week = 1.75x (the defaults for new models). */
export const RESERVATION_TERMS = [
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '1mo', label: '1 month' },
  { value: '3mo', label: '3 month' },
] as const
export const SHORT_TERM_MULTIPLIER = { '1d': 2, '1w': 1.75 } as const

export function termLabel(term: string): string {
  return RESERVATION_TERMS.find((t) => t.value === term)?.label ?? '1 month'
}

/** DBU per MU-hour for a reservation term. Models saved before the 1d/1w rates
 *  existed (still 0) fall back to the premium over their 1-month rate. */
export function muToDbuFor(model: PtModelRow, term: string): number {
  switch (term) {
    case '1d':
      return model.mu_to_dbu_1d || model.mu_to_dbu_1mo * SHORT_TERM_MULTIPLIER['1d']
    case '1w':
      return model.mu_to_dbu_1w || model.mu_to_dbu_1mo * SHORT_TERM_MULTIPLIER['1w']
    case '3mo':
      return model.mu_to_dbu_3mo
    default:
      return model.mu_to_dbu_1mo
  }
}

/** Calibrate MU→TPM and resolve rates/discount. Returns ok:false with a reason
 *  when the sizing inputs or usage series are missing. */
function calibrate(model: PtModelRow, scn: PtScenarioRow, points: UsagePoint[]): CalcContext {
  const tier: Tier = scn.ppt_tier === 'priority' ? 'priority' : 'standard'
  const dbuRate = scn.dbu_rate_discounted ?? model.dbu_rate
  const tpmCap = scn.tpm_cap > 0 ? scn.tpm_cap : Infinity
  const refTpm = scn.rpm * (scn.avg_input_tokens + scn.avg_output_tokens)
  const tpmPerMu = scn.mus > 0 ? refTpm / scn.mus : 0
  // Reserved PT is bound by INPUT throughput (context tokens), so calibrate an
  // input-tokens/min-per-MU alongside the total. avg_input_tokens is total input
  // per request (fresh + cached); reserved input capacity = MUs × inputTpmPerMu.
  const inputRefTpm = scn.rpm * Math.max(0, scn.avg_input_tokens)
  const inputTpmPerMu = scn.mus > 0 ? inputRefTpm / scn.mus : 0
  // Reserved rate depends on the chosen reservation term.
  const muToDbu = muToDbuFor(model, scn.reservation_term)

  const base: CalcContext = {
    ok: true,
    tpmPerMu,
    inputTpmPerMu,
    refTpm,
    sizedMus: scn.mus,
    muToDbu,
    dbuRate,
    tpmCap,
    tier,
    windowHours: 0,
    totalMinutes: 0,
    buckets: [],
    peakServedTpm: 0,
    peakInputTpm: 0,
    avgTpm: 0,
    totalServedTokens: 0,
    hasTimestamps: false,
  }

  if (tpmPerMu <= 0)
    return {
      ...base,
      ok: false,
      reason:
        'Set RPM, avg tokens, and the sized MUs to calibrate capacity. Use “Use for sizing” to fill RPM/tokens/cache from the data, then paste the MUs the sizer returns.',
    }
  if (points.length === 0)
    return { ...base, ok: false, reason: 'Attach a usage dataset to evaluate bursts.' }
  return base
}

/**
 * Blend a fraction of an add-on dataset on top of a base dataset — the traffic-
 * migration model ("move `frac` of another model's traffic onto this one").
 * Aligns by bucket position (index); the base defines the length and timeline,
 * and add-on buckets beyond the base's length are ignored (shorter → contribute
 * 0). Each result point carries `migrated` = the add-on tokens folded in, so the
 * chart can color the migrated share. Cost-relevant fields (total + input/output/
 * cached splits) add with scaling; per-request averages are request-weighted.
 */
/** Why a base and add-on dataset can't be blended (they're aligned by bucket
 *  position), or null when they line up. Requires equal bucket counts and, when
 *  both carry timestamps, matching ones. */
export function blendMismatch(base: UsagePoint[], addon: UsagePoint[]): string | null {
  if (base.length !== addon.length)
    return `datasets have different bucket counts (${base.length} vs ${addon.length}) — they must cover the same window at the same granularity to blend`
  for (let i = 0; i < base.length; i++) {
    const a = base[i].t
    const b = addon[i].t
    if (a != null && b != null && a !== b)
      return `bucket timestamps don't line up at row ${i + 1} (${new Date(a).toISOString()} vs ${new Date(
        b,
      ).toISOString()}) — align or re-upload the datasets`
  }
  return null
}

export function blendPoints(base: UsagePoint[], addon: UsagePoint[], frac: number): UsagePoint[] {
  if (frac <= 0 || addon.length === 0) return base
  const sumOpt = (x: number | null, y: number | null): number | null =>
    x == null && y == null ? null : (x ?? 0) + (y ?? 0) * frac
  return base.map((b, i) => {
    const a = addon[i]
    if (!a) return { ...b, migrated: 0 }
    const addTotal = Math.max(0, a.total) * frac
    const wAvg = (bv: number | null, av: number | null): number | null => {
      if (bv == null && av == null) return null
      const br = b.rpm ?? 0
      const ar = (a.rpm ?? 0) * frac
      return br + ar > 0 ? ((bv ?? 0) * br + (av ?? 0) * ar) / (br + ar) : (bv ?? av)
    }
    return {
      t: b.t,
      total: Math.max(0, b.total) + addTotal,
      input: sumOpt(b.input, a.input),
      output: sumOpt(b.output, a.output),
      cached: sumOpt(b.cached, a.cached),
      rpm: sumOpt(b.rpm, a.rpm),
      avg_input: wAvg(b.avg_input, a.avg_input),
      avg_output: wAvg(b.avg_output, a.avg_output),
      migrated: addTotal,
    }
  })
}

/**
 * Project organic growth onto a usage series: scale each bucket's volume by a
 * per-minute uplift chosen by the bucket's day type (weekday vs weekend). Volume
 * fields (total, input, output, cached, rpm, migrated) scale — PEAKS INCLUDED, the
 * conservative sizing assumption — while per-request averages are left unchanged
 * (uniform growth doesn't change how big a request is). Buckets without a
 * timestamp are treated as weekday. Returns the series unchanged at 0/0.
 */
export function growPoints(
  points: UsagePoint[],
  weekdayPct: number,
  weekendPct: number,
): UsagePoint[] {
  if ((weekdayPct === 0 && weekendPct === 0) || points.length === 0) return points
  const wdF = Math.max(0, 1 + weekdayPct / 100)
  const weF = Math.max(0, 1 + weekendPct / 100)
  return points.map((p) => {
    const day = p.t != null ? new Date(p.t).getDay() : -1
    const f = day === 0 || day === 6 ? weF : wdF
    if (f === 1) return p
    const s = (x: number | null | undefined): number | null =>
      x == null ? (x as null) : x * f
    return {
      ...p,
      total: Math.max(0, p.total) * f,
      input: s(p.input),
      output: s(p.output),
      cached: s(p.cached),
      rpm: s(p.rpm),
      migrated: p.migrated != null ? p.migrated * f : p.migrated,
      // avg_input / avg_output unchanged — request size is unaffected by volume growth.
    }
  })
}

/**
 * Build the reusable context: calibrate MU→TPM, then split the usage series into
 * buckets, apply the spike cap, and pre-compute each bucket's blended PPT $/token
 * so the sweep only does cheap comparisons.
 */
export function buildContext(
  model: PtModelRow,
  scn: PtScenarioRow,
  points: UsagePoint[],
  granularity: 'tpm' | 'tph',
): CalcContext {
  const ctx = calibrate(model, scn, points)
  if (!ctx.ok) return ctx

  const bucketMinutes = granularity === 'tph' ? 60 : 1
  const { rIn, rOut, rCache } = tierRates(model, ctx.tier)
  const def = resolveShares(scn)
  // Requests per bucket: use the dataset's own rpm when it carries it; otherwise
  // convert tokens → requests with the scenario's avg request size (in + out).
  const refPerReq = Math.max(0, scn.avg_input_tokens) + Math.max(0, scn.avg_output_tokens)

  let totalTokens = 0
  let peak = 0 // peak DEMAND tpm (uncapped) — drives feasibility & sizing
  let peakInput = 0 // peak INPUT tpm — the binding dimension for reserved capacity
  const buckets: Bucket[] = points.map((p) => {
    const tokens = Math.max(0, p.total)
    // Actual per-component token counts. Prefer the dataset's real split; when a
    // bucket carries none, split its total by the scenario's assumed input/output/
    // cache mix. `input` is total input incl. cache reads; `cached` is the cache
    // subset; fresh (billed) input = input − cached.
    let inTokens: number
    let cacheTokens: number
    let outTokens: number
    if (p.input != null || p.output != null || p.cached != null) {
      const i = Math.max(0, p.input ?? 0)
      const o = Math.max(0, p.output ?? 0)
      const c = Math.min(Math.max(0, p.cached ?? 0), i)
      inTokens = i - c
      cacheTokens = c
      outTokens = o
    } else {
      inTokens = def.fresh * tokens
      cacheTokens = def.cached * tokens
      outTokens = def.output * tokens
    }
    // Cost each component at the model rate card's own rate (DBU per 1M tokens) —
    // never a single blended rate. Per-token rates are expressed over the bucket's
    // total tokens so burst (a throughput fraction) and reserved-served prorate
    // correctly; a full bucket then costs exactly the actual component sum.
    const costInput = ((inTokens * rIn) / 1e6) * ctx.dbuRate
    const costCached = ((cacheTokens * rCache) / 1e6) * ctx.dbuRate
    const costOutput = ((outTokens * rOut) / 1e6) * ctx.dbuRate
    const denom = tokens > 0 ? tokens : 1
    const rateInput = costInput / denom
    const rateCached = costCached / denom
    const rateOutput = costOutput / denom
    const ratePerToken = rateInput + rateCached + rateOutput
    const inputTokens = inTokens + cacheTokens // total input (fresh + cached) — burst gate
    const requests =
      p.rpm != null && p.rpm >= 0 ? p.rpm * bucketMinutes : refPerReq > 0 ? tokens / refPerReq : 0
    const tpm = tokens / bucketMinutes
    const inputTpm = inputTokens / bucketMinutes
    totalTokens += tokens
    if (tpm > peak) peak = tpm
    if (inputTpm > peakInput) peakInput = inputTpm
    // Weekend = Sat/Sun. Uses local time so the split matches the operator's week.
    const day = p.t != null ? new Date(p.t).getDay() : -1
    const weekend = day === 0 || day === 6
    const migratedTpm = Math.max(0, p.migrated ?? 0) / bucketMinutes
    return {
      t: p.t,
      tpm,
      migratedTpm,
      minutes: bucketMinutes,
      tokens,
      requests,
      inputTokens,
      ratePerToken,
      rateInput,
      rateCached,
      rateOutput,
      weekend,
    }
  })

  const totalMinutes = buckets.reduce((a, b) => a + b.minutes, 0)
  return {
    ...ctx,
    buckets,
    totalMinutes,
    windowHours: totalMinutes / 60,
    peakServedTpm: peak,
    peakInputTpm: peakInput,
    avgTpm: totalMinutes ? totalTokens / totalMinutes : 0,
    totalServedTokens: totalTokens,
    hasTimestamps: points.some((p) => p.t != null),
  }
}

/** Fraction of a bucket's requests that overflow the reserved capacity — the
 *  burst gate is INPUT throughput. When a bucket's input tokens exceed reserved
 *  input capacity, the requests that don't fit spill WHOLLY to PPT (their input,
 *  output and cache), so the bursting share of the bucket ≈ the input-token
 *  overflow share. Falls back to gating on total tokens if the scenario carries
 *  no input dimension (avg input tokens = 0). */
function burstFraction(ctx: CalcContext, gateCapacityTpm: number, b: Bucket): number {
  const gateTokens = ctx.inputTpmPerMu > 0 ? b.inputTokens : b.tokens
  if (gateTokens <= 0) return 0
  const gateCap = gateCapacityTpm * b.minutes
  return Math.max(0, gateTokens - gateCap) / gateTokens
}

/**
 * Evaluate one reserved baseline (in MUs) against the pre-built context.
 *
 * Serving model: reserved PT is bought as total throughput (`capacityTpm`) but is
 * bound by INPUT throughput. In each bucket, requests whose input fits under the
 * reserved input capacity are served by the reservation (fixed cost); requests
 * whose input overflows spill ENTIRELY to pay-per-token — their input, output AND
 * cache are billed PPT. That bursting share is capped at `tpm_cap` tokens/min;
 * anything above is DROPPED (unservable). A baseline is *feasible* when nothing is
 * dropped, so when peak input exceeds capacity the recommendation reserves enough
 * (or leans on the burst cap) to serve it.
 */
export function evaluate(ctx: CalcContext, baselineMus: number): Evaluation {
  const capacityTpm = baselineMus * ctx.tpmPerMu
  const gatePerMu = ctx.inputTpmPerMu > 0 ? ctx.inputTpmPerMu : ctx.tpmPerMu
  const gateCapacityTpm = baselineMus * gatePerMu
  let burstCost = 0
  let burstTokens = 0
  let droppedTokens = 0
  let droppedRequests = 0
  let totalRequests = 0
  let covered = 0
  let usedGate = 0
  for (const b of ctx.buckets) {
    const f = burstFraction(ctx, gateCapacityTpm, b) // share of requests that burst
    const wantBurst = f * b.tokens // whole overflowing requests → all their tokens
    const burstAllow = ctx.tpmCap * b.minutes // PPT burst allowance (total tokens/min)
    const served = Math.min(wantBurst, burstAllow)
    burstCost += served * b.ratePerToken
    burstTokens += served
    const droppedInBucket = wantBurst - served
    droppedTokens += droppedInBucket
    // Bursting is whole-request, so the dropped-token share of the bucket equals
    // its dropped-request share — scale by the bucket's request count.
    droppedRequests += b.tokens > 0 ? (droppedInBucket / b.tokens) * b.requests : 0
    totalRequests += b.requests
    const gateTokens = ctx.inputTpmPerMu > 0 ? b.inputTokens : b.tokens
    usedGate += Math.min(gateTokens, gateCapacityTpm * b.minutes)
    if (droppedInBucket <= 1e-6) covered++
  }
  const reservedCost = baselineMus * ctx.muToDbu * ctx.dbuRate * ctx.windowHours
  const reservedGateCapacity = gateCapacityTpm * ctx.totalMinutes
  return {
    baselineMus,
    capacityTpm,
    reservedCost,
    burstCost,
    total: reservedCost + burstCost,
    burstTokens,
    droppedTokens,
    droppedRequests,
    droppedRequestPct: totalRequests > 0 ? droppedRequests / totalRequests : 0,
    feasible: droppedTokens <= 1e-6,
    coveragePct: ctx.buckets.length ? covered / ctx.buckets.length : 0,
    utilizationPct: reservedGateCapacity > 0 ? usedGate / reservedGateCapacity : 0,
    wastedTokens: Math.max(0, reservedGateCapacity - usedGate),
  }
}

export interface ReservedPptEquivalent {
  servedTokens: number // demand tokens the reservation covers (min of demand, capacity)
  input: number // $ if those tokens were billed PPT — (fresh) input component
  cached: number // …cache-read component
  output: number // …output component
  total: number // input + cached + output
}

/**
 * Value the tokens the reservation actually SERVES (demand up to capacity) at PPT
 * rates, split by input/output/cached — i.e. "what would the PT-covered throughput
 * have cost on pay-per-token?" Compare against the reserved cost to see whether PT
 * beat PPT for the covered portion. Burst (over-capacity) tokens are excluded — the
 * scenario already pays PPT for those.
 */
export function reservedAtPptRates(ctx: CalcContext, baselineMus: number): ReservedPptEquivalent {
  const gatePerMu = ctx.inputTpmPerMu > 0 ? ctx.inputTpmPerMu : ctx.tpmPerMu
  const gateCapacityTpm = baselineMus * gatePerMu
  let servedTokens = 0
  let input = 0
  let cached = 0
  let output = 0
  for (const b of ctx.buckets) {
    // The reservation fully serves the (1 − burst) share of each bucket's requests.
    const servedFrac = 1 - burstFraction(ctx, gateCapacityTpm, b)
    servedTokens += servedFrac * b.tokens
    input += servedFrac * b.tokens * b.rateInput
    cached += servedFrac * b.tokens * b.rateCached
    output += servedFrac * b.tokens * b.rateOutput
  }
  return { servedTokens, input, cached, output, total: input + cached + output }
}

export interface DayTypeUtilization {
  buckets: number
  usedTokens: number // reserved capacity actually consumed
  capacityTokens: number // reserved capacity offered over these buckets
  demandTokens: number // total demand in these buckets
  utilizationPct: number // usedTokens / capacityTokens
}
export interface UtilizationSplit {
  weekday: DayTypeUtilization
  weekend: DayTypeUtilization
  hasTimestamps: boolean
}

/**
 * Split reserved-capacity utilization by day type (weekday vs weekend) for a
 * given baseline. Utilization = tokens served from the reservation ÷ reserved
 * capacity offered, so it shows whether one part of the week under-consumes the
 * baseline (a common reason weekends look wasteful on a flat reservation).
 */
export function utilizationSplit(ctx: CalcContext, baselineMus: number): UtilizationSplit {
  const gatePerMu = ctx.inputTpmPerMu > 0 ? ctx.inputTpmPerMu : ctx.tpmPerMu
  const gateCapacityTpm = baselineMus * gatePerMu
  const blank = (): DayTypeUtilization => ({
    buckets: 0,
    usedTokens: 0,
    capacityTokens: 0,
    demandTokens: 0,
    utilizationPct: 0,
  })
  const wd = blank()
  const we = blank()
  for (const b of ctx.buckets) {
    const g = b.weekend ? we : wd
    const gateTokens = ctx.inputTpmPerMu > 0 ? b.inputTokens : b.tokens
    const gateCap = gateCapacityTpm * b.minutes
    g.buckets++
    g.usedTokens += Math.min(gateTokens, gateCap)
    g.capacityTokens += gateCap
    g.demandTokens += gateTokens
  }
  wd.utilizationPct = wd.capacityTokens > 0 ? wd.usedTokens / wd.capacityTokens : 0
  we.utilizationPct = we.capacityTokens > 0 ? we.usedTokens / we.capacityTokens : 0
  return { weekday: wd, weekend: we, hasTimestamps: ctx.hasTimestamps }
}

export interface SweepPoint {
  mus: number
  total: number
  reserved: number
  burst: number
}
export interface SweepResult {
  points: SweepPoint[]
  recommended: Evaluation
  pptOnly: Evaluation // baseline 0 → pure pay-per-token
  maxMus: number
}

/** Sweep reserved baselines from 0 (PPT-only) up to fully absorbing peak demand;
 *  recommend the lowest-cost baseline that is FEASIBLE (drops no traffic). A
 *  baseline that can't serve an over-cap spike is never recommended even if it
 *  would be cheaper — so when demand exceeds the cap, the recommendation reserves
 *  at least enough to cover the excess. */
export function sweep(ctx: CalcContext, steps = 60): SweepResult {
  const pptOnly = evaluate(ctx, 0)
  // Enough MUs to serve peak INPUT demand entirely from reservation (the binding
  // dimension) — guarantees the top of the range is feasible, so a feasible
  // recommendation always exists. Falls back to total when there's no input dim.
  const maxMus =
    ctx.inputTpmPerMu > 0
      ? (ctx.peakInputTpm / ctx.inputTpmPerMu) * 1.1
      : ctx.tpmPerMu > 0
        ? (ctx.peakServedTpm / ctx.tpmPerMu) * 1.1
        : 0
  const points: SweepPoint[] = []
  let best: Evaluation | null = null // cheapest feasible
  let leastDropped: Evaluation | null = null // fallback if nothing is feasible
  for (let i = 0; i <= steps; i++) {
    const mus = (maxMus * i) / steps
    const e = evaluate(ctx, mus)
    points.push({ mus, total: e.total, reserved: e.reservedCost, burst: e.burstCost })
    if (e.feasible) {
      if (best === null || e.total < best.total) best = e
    } else if (leastDropped === null || e.droppedTokens < leastDropped.droppedTokens) {
      leastDropped = e
    }
  }
  return { points, recommended: best ?? leastDropped ?? pptOnly, pptOnly, maxMus }
}

// ── formatting helpers ────────────────────────────────────────────────────────
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 })
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${Math.round(n)}`
}

export function fmtNum(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function fmtPct(frac: number): string {
  if (!Number.isFinite(frac)) return '—'
  return `${(frac * 100).toFixed(0)}%`
}

/** Percent with fine resolution for small shares (e.g. dropped-request %): one
 *  decimal below 10%, and "<0.1%" for a tiny but non-zero share so a real impact
 *  never rounds to 0%. */
export function fmtPctFine(frac: number): string {
  if (!Number.isFinite(frac)) return '—'
  const p = frac * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p.toFixed(p < 10 ? 1 : 0)}%`
}
