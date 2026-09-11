import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { McpToolSpec, ModelOption } from '@shared/types'
import type { StoredDoc } from '../docs'
import { activeModel, getApiKey } from '../settings'
import { MissingKeyError, MissingModelError } from './errors'
import { documentBlock, GUIDE, userTurn } from './prompts'
import { historyTurns, type AskArgs, type Provider, type StructuredCall } from './types'
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
function messages(
  doc: StoredDoc,
  tail: OpenAI.Chat.ChatCompletionMessageParam[],
  extraGuide = '',
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const guide = extraGuide ? `${GUIDE}\n\n${extraGuide}` : GUIDE
  return [{ role: 'system', content: `${guide}\n\n${documentBlock(doc)}` }, ...tail]
}

/**
 * Search budget for one question. Reaching either limit withholds the tools on
 * the last request rather than aborting, so the search is never wasted.
 */
const MAX_TOOL_ROUNDS = 24
const MAX_TOOL_OUTPUT_CHARS = 240_000

const WRAP_UP =
  'You have used the search budget for this question. Do not look anything else up. ' +
  'Answer now with what you have found, and say plainly what you were unable to determine.'

function asOpenAITools(specs: McpToolSpec[]): OpenAI.Chat.ChatCompletionTool[] {
  return specs.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

export const openaiProvider: Provider = {
  id: 'openai',

  async streamAnswer({ doc, request, tools: bundle, emit, signal }: AskArgs) {
    const started = Date.now()
    const hasTools = bundle.specs.length > 0
    const tools = hasTools ? asOpenAITools(bundle.specs) : undefined

    const tail: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...historyTurns(request),
      { role: 'user', content: userTurn(request) },
    ]

    let toolOutput = 0

    for (let round = 0; ; round++) {
      const wrapUp = round >= MAX_TOOL_ROUNDS || toolOutput >= MAX_TOOL_OUTPUT_CHARS
      if (wrapUp) tail.push({ role: 'user', content: WRAP_UP })

      const stream = await client().chat.completions.create(
        {
          model: model(),
          stream: true,
          prompt_cache_key: doc.cacheKey,
          stream_options: { include_usage: true },
          ...(tools ? { tools } : {}),
          ...(wrapUp ? { tool_choice: 'none' as const } : {}),
          messages: messages(doc, tail, bundle.guide),
        },
        { signal },
      )

      let usage: OpenAI.CompletionUsage | undefined
      let text = ''
      // Tool calls arrive split across chunks and keyed by index, not id.
      const calls = new Map<number, { id: string; name: string; args: string }>()

      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage
        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          text += delta.content
          emit({ type: 'text', text: delta.content })
        }
        for (const call of delta?.tool_calls ?? []) {
          const existing = calls.get(call.index) ?? { id: '', name: '', args: '' }
          calls.set(call.index, {
            id: call.id ?? existing.id,
            name: call.function?.name ?? existing.name,
            args: existing.args + (call.function?.arguments ?? ''),
          })
        }
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

      if (calls.size === 0 || !hasTools || wrapUp) {
        emit({ type: 'done' })
        return
      }

      const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
      tail.push({
        role: 'assistant',
        content: text || null,
        tool_calls: ordered.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args || '{}' },
        })),
      })

      for (const call of ordered) {
        let input: unknown = {}
        try {
          input = JSON.parse(call.args || '{}')
        } catch {
          // Malformed arguments are handled by the tool itself.
        }
        emit({ type: 'tool', text: bundle.describe(call.name, input) })
        let output: string
        try {
          output = await bundle.run(call.name, input)
        } catch (error) {
          output = `That lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`
        }
        tail.push({ role: 'tool', tool_call_id: call.id, content: output })
      }
    }
  },

  async structured<T>({ label, doc, user, schema, signal }: StructuredCall<T>): Promise<T> {
    const started = Date.now()
    const completion = await client().chat.completions.parse(
      {
        model: model(),
        prompt_cache_key: doc.cacheKey,
        messages: messages(doc, [{ role: 'user', content: user }]),
        response_format: zodResponseFormat(schema, label),
      },
      { signal, timeout: 20 * 60 * 1000 },
    )

    if (completion.usage) {
      reportUsage({
        label,
        provider: 'openai',
        model: model(),
        usage: fromOpenAIUsage(completion.usage),
        elapsedMs: Date.now() - started,
      })
    }

    const choice = completion.choices[0]
    if (choice?.message.refusal) throw new Error(`The model declined: ${choice.message.refusal}`)
    const parsed = choice?.message.parsed
    if (!parsed) throw new Error('The model returned an unreadable shape. Try again.')
    return parsed as T
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
