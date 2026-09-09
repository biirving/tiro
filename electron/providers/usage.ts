/**
 * Token accounting and cost, one line per request.
 *
 * The point is to make two things visible while you work: whether the cached
 * document is actually being reused, and what the session has cost so far.
 *
 * Prices are cached from Anthropic's published rates (2026-06-24). For any other
 * provider, set TIRO_PRICE_IN / TIRO_PRICE_OUT (USD per million tokens) to get
 * dollar figures; without them the line reports tokens only, rather than
 * inventing a rate.
 */

import type { ProviderId } from '@shared/types'

export interface TokenUsage {
  /** Input tokens billed at full rate. */
  freshInput: number
  /** Input tokens served from cache. */
  cachedInput: number
  /** Input tokens written to a 5-minute cache entry. */
  written5m: number
  /** Input tokens written to a 1-hour cache entry. */
  written1h: number
  output: number
  /** Reasoning tokens, already counted inside `output`. */
  thinking?: number
}

export type RequestLabel = 'ask' | 'concepts' | 'code'

export interface UsageEvent {
  label: RequestLabel
  provider: ProviderId
  model: string
  usage: TokenUsage
  elapsedMs: number
}

interface Rate {
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
  /** Cache reads as a multiple of the input rate. */
  cacheRead: number
}

const DEFAULT_CACHE_READ = 0.1

/** Cache writes as a multiple of the input rate, by TTL. */
const WRITE_5M = 1.25
const WRITE_1H = 2.0

/** Longest prefix wins, so dated or suffixed ids still match. */
const ANTHROPIC_RATES: [string, Rate][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.025 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: DEFAULT_CACHE_READ }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: DEFAULT_CACHE_READ }],
]

function envRate(): Rate | null {
  const input = Number(process.env.TIRO_PRICE_IN)
  const output = Number(process.env.TIRO_PRICE_OUT)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  return { input, output, cacheRead: DEFAULT_CACHE_READ }
}

function rateFor(provider: ProviderId, model: string): Rate | null {
  const override = envRate()
  if (override) return override
  if (provider !== 'anthropic') return null

  const match = ANTHROPIC_RATES.filter(([prefix]) => model.startsWith(prefix)).sort(
    (a, b) => b[0].length - a[0].length,
  )[0]
  return match ? match[1] : null
}

/** Input tokens re-expressed at the full input rate, premiums included. */
function billableInput(usage: TokenUsage, rate: Rate): number {
  return (
    usage.freshInput +
    usage.cachedInput * rate.cacheRead +
    usage.written5m * WRITE_5M +
    usage.written1h * WRITE_1H
  )
}

export function costOf(usage: TokenUsage, rate: Rate | null): number | null {
  if (!rate) return null
  return (billableInput(usage, rate) * rate.input + usage.output * rate.output) / 1_000_000
}

let sessionCost = 0
let sessionRequests = 0
/** Reported alongside cost when some requests could not be priced. */
let unpricedRequests = 0
let legendShown = false

export function sessionTotals(): {
  requests: number
  cost: number
  unpriced: number
} {
  return { requests: sessionRequests, cost: sessionCost, unpriced: unpricedRequests }
}

/** Set once at startup. Keeping electron out of here makes the maths testable. */
let logEnabled = false

export function configureUsageLog(on: boolean): void {
  logEnabled = on
}

function enabled(): boolean {
  return logEnabled
}

const n = (value: number): string => Math.round(value).toLocaleString()
const usd = (value: number): string => `$${value.toFixed(4)}`

export function reportUsage(event: UsageEvent): void {
  const { usage } = event
  const rate = rateFor(event.provider, event.model)
  const cost = costOf(usage, rate)

  sessionRequests += 1
  if (cost === null) unpricedRequests += 1
  else sessionCost += cost

  if (!enabled()) return

  if (!legendShown) {
    legendShown = true
    console.log(
      '[tiro] token legend — in: fresh (full rate) · cached (0.1x) · wrote (1.25x at 5m, 2x at 1h)',
    )
  }

  const totalInput = usage.freshInput + usage.cachedInput + usage.written5m + usage.written1h
  const wrote = usage.written5m + usage.written1h
  const wroteTtl = usage.written1h > 0 ? '@1h' : usage.written5m > 0 ? '@5m' : ''

  const parts = [
    `[tiro] ${event.label.padEnd(8)}`,
    event.model,
    `in ${n(totalInput)} (fresh ${n(usage.freshInput)} · cached ${n(usage.cachedInput)} · wrote ${n(wrote)}${wroteTtl})`,
    `out ${n(usage.output)}${usage.thinking ? ` (think ${n(usage.thinking)})` : ''}`,
    `${(event.elapsedMs / 1000).toFixed(1)}s`,
  ]

  if (cost === null) {
    parts.push('cost —  (set TIRO_PRICE_IN / TIRO_PRICE_OUT to price this model)')
  } else {
    parts.push(usd(cost))
    parts.push(
      `· session ${usd(sessionCost)} over ${sessionRequests} request${sessionRequests === 1 ? '' : 's'}`,
    )
  }

  let line = parts.join('  ')

  // The failure this exists to catch: the document re-read on every question.
  if (usage.cachedInput === 0 && usage.freshInput > 4000 && wrote === 0) {
    line += '\n       ↑ nothing cached and nothing written — the prefix is not being reused'
  }
  console.log(line)
}

/** Printed at startup, so a test run confirms what it is actually testing. */
export function reportProvider(state: {
  provider: ProviderId
  model: string
  ready: boolean
  hasKey: boolean
  local: boolean
  keyFromEnv: boolean
  keyUnreadable: boolean
  keyEncrypted: boolean
}): void {
  if (!enabled()) return

  const key = state.local
    ? 'no key needed'
    : state.keyFromEnv
      ? 'key from environment'
      : state.keyUnreadable
        ? 'saved key WILL NOT DECRYPT — re-enter it in Settings'
        : state.hasKey
          ? `key saved${state.keyEncrypted ? '' : ' (unencrypted — no OS keyring)'}`
          : 'no key'

  console.log(
    `[tiro] provider ${state.provider}/${state.model || '(no model picked)'} · ${key}` +
      `${state.ready ? '' : ' · not ready to answer'}`,
  )
}

/**
 * Printed when a document is registered: what it costs to put in context, and
 * what each question against it should cost once cached. Worth knowing before
 * spending rather than after.
 */
export function reportDocument(info: {
  title: string
  pages: number
  chars: number
  provider: ProviderId
  model: string
}): void {
  if (!enabled()) return

  const tokens = Math.round(info.chars / 3.7)
  const rate = rateFor(info.provider, info.model)
  const line = `[tiro] document "${info.title}" · ${info.pages} pages · ~${n(tokens)} tokens`

  if (!rate) {
    console.log(line)
    return
  }
  const toCache = (tokens * WRITE_1H * rate.input) / 1_000_000
  const perRead = (tokens * rate.cacheRead * rate.input) / 1_000_000
  console.log(
    `${line} · ~${usd(toCache)} to put in context, ~${usd(perRead)} per question once cached (before output)`,
  )
}

/** Local models cost nothing, so report throughput and cache reuse instead. */
export function reportLocalUsage(event: {
  label: RequestLabel
  model: string
  promptTokens: number
  evaluatedTokens: number | null
  outputTokens: number | null
  elapsedMs: number
}): void {
  sessionRequests += 1
  if (!enabled()) return

  const reused =
    event.evaluatedTokens === null ? null : Math.max(0, event.promptTokens - event.evaluatedTokens)
  const perSecond =
    event.outputTokens && event.elapsedMs > 0
      ? Math.round((event.outputTokens / event.elapsedMs) * 1000)
      : null

  console.log(
    [
      `[tiro] ${event.label.padEnd(8)}`,
      event.model,
      `prompt ~${n(event.promptTokens)} (evaluated ${event.evaluatedTokens === null ? '—' : n(event.evaluatedTokens)} · reused ${reused === null ? '—' : n(reused)})`,
      `out ${event.outputTokens === null ? '—' : n(event.outputTokens)}`,
      `${(event.elapsedMs / 1000).toFixed(1)}s`,
      perSecond === null ? 'local, no charge' : `${perSecond} tok/s · local, no charge`,
    ].join('  '),
  )
}

/** Failures are worth seeing in full while testing, not just in the panel. */
export function reportFailure(label: string, error: unknown): void {
  if (!enabled()) return
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[tiro] ${label} failed — ${name}: ${message}`)
  if (error instanceof Error && error.stack) console.error(error.stack)
}

/** Shape shared by `Usage` and `BetaUsage`; only the fields we bill on. */
interface AnthropicUsageLike {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  } | null
  output_tokens_details?: { thinking_tokens?: number } | null
}

export function fromAnthropicUsage(usage: AnthropicUsageLike): TokenUsage {
  const split = usage.cache_creation
  // Without the per-TTL breakdown, attribute writes to the TTL we ask for.
  const written1h = split
    ? (split.ephemeral_1h_input_tokens ?? 0)
    : (usage.cache_creation_input_tokens ?? 0)

  return {
    freshInput: usage.input_tokens,
    cachedInput: usage.cache_read_input_tokens ?? 0,
    written5m: split ? (split.ephemeral_5m_input_tokens ?? 0) : 0,
    written1h,
    output: usage.output_tokens,
    thinking: usage.output_tokens_details?.thinking_tokens,
  }
}

interface OpenAIUsageLike {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export function fromOpenAIUsage(usage: OpenAIUsageLike): TokenUsage {
  const cachedInput = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    freshInput: Math.max(0, usage.prompt_tokens - cachedInput),
    cachedInput,
    // OpenAI populates its cache at no extra charge, so there is no write line.
    written5m: 0,
    written1h: 0,
    output: usage.completion_tokens,
    thinking: usage.completion_tokens_details?.reasoning_tokens,
  }
}
