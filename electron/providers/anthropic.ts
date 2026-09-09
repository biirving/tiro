import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Concept, ModelOption } from '@shared/types'
import type { StoredDoc } from '../docs'
import { activeModel, getApiKey } from '../settings'
import { MissingKeyError, MissingModelError } from './errors'
import {
  CONCEPTS_TASK,
  ConceptsSchema,
  documentBlock,
  GUIDE,
  normalizeConcepts,
  userTurn,
} from './prompts'
import { historyTurns, type AskArgs, type Provider } from './types'
import { fromAnthropicUsage, reportUsage } from './usage'

const BETAS = ['server-side-fallback-2026-07-01', 'extended-cache-ttl-2025-04-11'] as const

/**
 * One effort level for every request about a document — answers and the concept
 * read alike.
 *
 * An `effort` change always invalidates the messages cache, and on models that
 * render the thinking config ahead of system it invalidates that too. Varying it
 * per operation would make the concept pass and the first question write the
 * document to cache twice, at 1.25x each. Pinning it costs a little thinking on
 * a one-word lookup and saves a full re-read of the document; on a 500k-token
 * book that trade is worth several dollars per file.
 *
 * `thinking` is pinned to the same value everywhere for the same reason.
 */
const DOC_EFFORT = 'high'

function client(): Anthropic {
  const apiKey = getApiKey('anthropic')
  if (!apiKey) throw new MissingKeyError('anthropic')
  return new Anthropic({ apiKey, maxRetries: 2 })
}

function model(): string {
  const id = activeModel('anthropic')
  if (!id) throw new MissingModelError('anthropic')
  return id
}

/** Prefix shared by every request about one document. Stable to the byte. */
function system(doc: StoredDoc): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: 'text', text: GUIDE },
    {
      type: 'text',
      text: documentBlock(doc),
      // 1h TTL: a reader asks in bursts separated by minutes of reading.
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
}

export const anthropicProvider: Provider = {
  id: 'anthropic',

  async streamAnswer({ doc, request, emit, signal }: AskArgs) {
    const started = Date.now()
    const stream = client().beta.messages.stream(
      {
        model: model(),
        max_tokens: 32000,
        betas: [...BETAS],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: DOC_EFFORT },
        system: system(doc),
        messages: [...historyTurns(request), { role: 'user', content: userTurn(request) }],
      },
      { signal },
    )

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        emit({ type: 'text', text: event.delta.text })
      }
    }

    const final = await stream.finalMessage()
    reportUsage({
      label: 'ask',
      provider: 'anthropic',
      model: model(),
      usage: fromAnthropicUsage(final.usage),
      elapsedMs: Date.now() - started,
    })

    if (final.stop_reason === 'refusal') {
      emit({
        type: 'error',
        message: 'Claude declined to answer that one. Try asking a different way.',
      })
      return
    }
    emit({ type: 'done' })
  },

  async extractConcepts(doc: StoredDoc, signal: AbortSignal): Promise<Concept[]> {
    const started = Date.now()
    const response = await client().beta.messages.parse(
      {
        model: model(),
        max_tokens: 24000,
        betas: [...BETAS],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        // Same effort, thinking, betas, model, and system blocks as an answer,
        // so both share one cache entry. Whether adding `format` here perturbs
        // the prefix is not something the docs settle; the [cache] log says so
        // either way, and this call runs once per document regardless.
        output_config: { effort: DOC_EFFORT, format: zodOutputFormat(ConceptsSchema) },
        system: system(doc),
        messages: [{ role: 'user', content: CONCEPTS_TASK }],
      },
      // A few hundred pages at high effort can run for minutes.
      { signal, timeout: 20 * 60 * 1000 },
    )

    reportUsage({
      label: 'concepts',
      provider: 'anthropic',
      model: model(),
      usage: fromAnthropicUsage(response.usage),
      elapsedMs: Date.now() - started,
    })

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined to summarize this document.')
    }
    const parsed = response.parsed_output
    if (!parsed) throw new Error('Claude returned concepts in an unreadable shape. Try again.')

    return normalizeConcepts(parsed, doc.pages.length)
  },

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = []
    for await (const entry of client().models.list()) {
      models.push({ id: entry.id, detail: entry.display_name })
    }
    return models
  },
}

/** Turns an Anthropic SDK error into something worth showing a reader. */
export function describeAnthropicError(
  error: unknown,
): { message: string; needsKey?: boolean } | null {
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: 'That Anthropic API key was rejected. Check it in Settings.', needsKey: true }
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { message: `This key does not have access to ${activeModel('anthropic')}.` }
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { message: 'Rate limited by Anthropic. Wait a moment, then ask again.' }
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { message: error.message }
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { message: 'Cannot reach the Anthropic API. Check your connection.' }
  }
  if (error instanceof Anthropic.APIError) {
    return { message: `Anthropic API error ${error.status}: ${error.message}` }
  }
  return null
}

export function isAnthropicAbort(error: unknown): boolean {
  return error instanceof Anthropic.APIUserAbortError
}
