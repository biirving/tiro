import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
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
import { fromOpenAIUsage, reportUsage } from './usage'

function client(): OpenAI {
  const apiKey = getApiKey('openai')
  if (!apiKey) throw new MissingKeyError('openai')
  return new OpenAI({ apiKey, maxRetries: 2 })
}

function model(): string {
  const id = activeModel('openai')
  if (!id) throw new MissingModelError('openai')
  return id
}

/**
 * The document goes in the leading system message and never varies, which is
 * what OpenAI's automatic prefix caching keys on. No token ceiling is sent:
 * model families disagree about `max_tokens` vs `max_completion_tokens`, and the
 * default is the model's own maximum either way.
 */
function messages(doc: StoredDoc, tail: { role: 'user' | 'assistant'; content: string }[]) {
  return [
    { role: 'system' as const, content: `${GUIDE}\n\n${documentBlock(doc)}` },
    ...tail,
  ]
}

export const openaiProvider: Provider = {
  id: 'openai',

  async streamAnswer({ doc, request, emit, signal }: AskArgs) {
    const started = Date.now()
    const stream = await client().chat.completions.create(
      {
        model: model(),
        stream: true,
        // Routes every request about this document to the same cache, which is
        // what lifts OpenAI's automatic prefix caching from luck to reliable.
        prompt_cache_key: doc.cacheKey,
        // Without this the final chunk carries no usage, and cache hits are
        // unobservable.
        stream_options: { include_usage: true },
        messages: messages(doc, [
          ...historyTurns(request),
          { role: 'user', content: userTurn(request) },
        ]),
      },
      { signal },
    )

    let usage: OpenAI.CompletionUsage | undefined
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage
      const text = chunk.choices[0]?.delta?.content
      if (text) emit({ type: 'text', text })
    }

    if (usage) {
      reportUsage({
        label: 'ask',
        provider: 'openai',
        model: model(),
        usage: fromOpenAIUsage(usage),
        elapsedMs: Date.now() - started,
      })
    }

    emit({ type: 'done' })
  },

  async extractConcepts(doc: StoredDoc, signal: AbortSignal): Promise<Concept[]> {
    const started = Date.now()
    const completion = await client().chat.completions.parse(
      {
        model: model(),
        prompt_cache_key: doc.cacheKey,
        messages: messages(doc, [{ role: 'user', content: CONCEPTS_TASK }]),
        response_format: zodResponseFormat(ConceptsSchema, 'concepts'),
      },
      { signal, timeout: 20 * 60 * 1000 },
    )

    if (completion.usage) {
      reportUsage({
        label: 'concepts',
        provider: 'openai',
        model: model(),
        usage: fromOpenAIUsage(completion.usage),
        elapsedMs: Date.now() - started,
      })
    }

    const choice = completion.choices[0]
    if (choice?.message.refusal) {
      throw new Error(`The model declined: ${choice.message.refusal}`)
    }
    const parsed = choice?.message.parsed
    if (!parsed) {
      throw new Error('The model returned concepts in an unreadable shape. Try again.')
    }
    return normalizeConcepts(parsed, doc.pages.length)
  },

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = []
    for await (const entry of client().models.list()) {
      models.push({ id: entry.id })
    }
    // Newest first: the list is long and unordered, and the reader wants current.
    return models.sort((a, b) => a.id.localeCompare(b.id))
  },
}

export function describeOpenAIError(
  error: unknown,
): { message: string; needsKey?: boolean } | null {
  if (error instanceof OpenAI.AuthenticationError) {
    return { message: 'That OpenAI API key was rejected. Check it in Settings.', needsKey: true }
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return { message: `This key does not have access to ${activeModel('openai')}.` }
  }
  if (error instanceof OpenAI.NotFoundError) {
    return { message: `OpenAI has no model called ${activeModel('openai')}. Pick another in Settings.` }
  }
  if (error instanceof OpenAI.RateLimitError) {
    return { message: 'Rate limited by OpenAI. Wait a moment, then ask again.' }
  }
  if (error instanceof OpenAI.BadRequestError) {
    return { message: error.message }
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { message: 'Cannot reach the OpenAI API. Check your connection.' }
  }
  if (error instanceof OpenAI.APIError) {
    return { message: `OpenAI API error ${error.status}: ${error.message}` }
  }
  return null
}

export function isOpenAIAbort(error: unknown): boolean {
  return error instanceof OpenAI.APIUserAbortError
}
