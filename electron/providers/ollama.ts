/**
 * Local models through Ollama's native API.
 *
 * Deliberately not the OpenAI-compatible endpoint: that route cannot set
 * `num_ctx`, and Ollama defaults to a few thousand tokens of context regardless
 * of what the model supports. A whole paper would be silently cut off, which is
 * the one failure this app must not have. The native API takes `num_ctx`, takes
 * a JSON schema for structured output, and needs no SDK.
 */

import type { Concept, ModelOption } from '@shared/types'
import { estimateTokens, type StoredDoc } from '../docs'
import { activeModel, ollamaHost } from '../settings'
import { ContextTooSmallError, MissingModelError, OllamaUnreachableError } from './errors'
import {
  CONCEPTS_TASK,
  conceptsJsonSchema,
  documentBlock,
  GUIDE,
  parseConceptsReply,
  userTurn,
} from './prompts'
import { historyTurns, type AskArgs, type Provider } from './types'
import { reportLocalUsage } from './usage'

/** Keeps the model resident between questions, which is most of the local UX. */
const KEEP_ALIVE = '15m'

/**
 * Room reserved on top of the document for the conversation and the reply.
 * Generous on purpose — see `windowFor`.
 */
const BASE_ALLOWANCE = 8192

/** Headroom for one reply, used only in the per-prompt sanity check. */
const ANSWER_RESERVE = 2048

/**
 * Context windows are quantised to this, so an ordinary follow-up question
 * never changes `num_ctx`. That matters more than it looks: Ollama reloads the
 * context when `num_ctx` changes, discarding the KV cache, and the document
 * would then be re-evaluated from scratch on every single question.
 */
const WINDOW_STEP = 8192

/** Used when a build of Ollama won't tell us the model's real window. */
const UNKNOWN_LIMIT_CAP = 32768

const limitCache = new Map<string, number | null>()

function model(): string {
  const id = activeModel('ollama')
  if (!id) throw new MissingModelError('ollama')
  return id
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const host = ollamaHost()
  try {
    const response = await fetch(`${host}${path}`, init)
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(
        `Ollama returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      )
    }
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    // fetch rejects with a TypeError when nothing is listening.
    if (error instanceof TypeError) throw new OllamaUnreachableError(host)
    throw error
  }
}

/** The model's trained context window, or null when this Ollama won't say. */
async function contextLimit(name: string): Promise<number | null> {
  const cached = limitCache.get(name)
  if (cached !== undefined) return cached

  let limit: number | null = null
  try {
    const response = await call('/api/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    })
    const info = (await response.json()) as { model_info?: Record<string, unknown> }
    for (const [key, value] of Object.entries(info.model_info ?? {})) {
      if (key.endsWith('.context_length') && typeof value === 'number') {
        limit = value
        break
      }
    }
  } catch (error) {
    if (error instanceof OllamaUnreachableError) throw error
    // An older Ollama may not expose model_info; fall through to the cap.
  }

  limitCache.set(name, limit)
  return limit
}

/**
 * Picks `num_ctx` for a document, and refuses rather than let the model silently
 * drop the end of it.
 *
 * The size is derived from the document plus a fixed allowance, not from the
 * current prompt, so it stays the same for every question about that document —
 * which is what lets the KV cache survive from one question to the next. It only
 * grows if a conversation gets long enough to need the next step up.
 */
async function windowFor(name: string, doc: StoredDoc, promptChars: number): Promise<number> {
  const forDocument = estimateTokens(doc.text.length) + BASE_ALLOWANCE
  const forThisPrompt = estimateTokens(promptChars) + ANSWER_RESERVE
  const needed = Math.max(forDocument, forThisPrompt)

  const limit = await contextLimit(name)
  const ceiling = limit ?? UNKNOWN_LIMIT_CAP
  if (needed > ceiling) throw new ContextTooSmallError(name, needed, ceiling)

  const stepped = Math.ceil(needed / WINDOW_STEP) * WINDOW_STEP
  return Math.min(Math.max(stepped, 4096), ceiling)
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function chatMessages(doc: StoredDoc, tail: ChatMessage[]): ChatMessage[] {
  return [{ role: 'system', content: `${GUIDE}\n\n${documentBlock(doc)}` }, ...tail]
}

function charCount(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0)
}

/**
 * Ollama reports how many prompt tokens it actually evaluated. On a KV-cache hit
 * that number collapses to just the new turn, which is the signal we want.
 */
function reportOllama(
  label: 'ask' | 'concepts',
  name: string,
  messages: ChatMessage[],
  counts: { evaluated: number | null; output: number | null },
  elapsedMs: number,
): void {
  reportLocalUsage({
    label,
    model: name,
    promptTokens: estimateTokens(charCount(messages)),
    evaluatedTokens: counts.evaluated,
    outputTokens: counts.output,
    elapsedMs,
  })
}

export const ollamaProvider: Provider = {
  id: 'ollama',

  async streamAnswer({ doc, request, emit, signal }: AskArgs) {
    const started = Date.now()
    const name = model()
    const messages = chatMessages(doc, [
      ...historyTurns(request),
      { role: 'user', content: userTurn(request) },
    ])
    const numCtx = await windowFor(name, doc, charCount(messages))

    const response = await call('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: name,
        messages,
        stream: true,
        keep_alive: KEEP_ALIVE,
        options: { num_ctx: numCtx },
      }),
    })

    const body = response.body
    if (!body) throw new Error('Ollama sent no response body.')

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let evaluated: number | null = null
    let generated: number | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Ollama streams newline-delimited JSON.
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue

        const chunk = JSON.parse(line) as {
          message?: { content?: string }
          error?: string
          done?: boolean
          prompt_eval_count?: number
          eval_count?: number
        }
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.done) {
          evaluated = chunk.prompt_eval_count ?? null
          generated = chunk.eval_count ?? null
        }
        const text = chunk.message?.content
        if (text) emit({ type: 'text', text })
      }
    }

    reportOllama('ask', name, messages, { evaluated, output: generated }, Date.now() - started)
    emit({ type: 'done' })
  },

  async extractConcepts(doc: StoredDoc, signal: AbortSignal): Promise<Concept[]> {
    const started = Date.now()
    const name = model()
    const messages = chatMessages(doc, [{ role: 'user', content: CONCEPTS_TASK }])
    const numCtx = await windowFor(name, doc, charCount(messages))

    const response = await call('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: name,
        messages,
        stream: false,
        keep_alive: KEEP_ALIVE,
        // A JSON schema here constrains decoding, the local equivalent of
        // structured output.
        format: conceptsJsonSchema(),
        options: { num_ctx: numCtx },
      }),
    })

    const payload = (await response.json()) as {
      message?: { content?: string }
      prompt_eval_count?: number
      eval_count?: number
    }
    reportOllama(
      'concepts',
      name,
      messages,
      { evaluated: payload.prompt_eval_count ?? null, output: payload.eval_count ?? null },
      Date.now() - started,
    )

    const raw = payload.message?.content ?? ''
    return parseConceptsReply(raw, doc.pages.length)
  },

  async listModels(): Promise<ModelOption[]> {
    const response = await call('/api/tags')
    const payload = (await response.json()) as {
      models?: { name: string; details?: { parameter_size?: string } }[]
    }
    return (payload.models ?? [])
      .map((entry) => ({ id: entry.name, detail: entry.details?.parameter_size }))
      .sort((a, b) => a.id.localeCompare(b.id))
  },
}
