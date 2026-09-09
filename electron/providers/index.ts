/**
 * Provider registry: everything the main process needs to ask a question,
 * whichever backend the reader picked.
 */

import type {
  AskEvent,
  AskRequest,
  Concept,
  ModelOption,
  ProviderId,
  ProviderState,
} from '@shared/types'
import { getDoc } from '../docs'
import {
  activeModel,
  activeProvider,
  encryptionAvailable,
  getApiKey,
  keySourceIsEnv,
  keyStatus,
  ollamaHost,
  PROVIDERS_WITHOUT_KEYS,
} from '../settings'
import { anthropicProvider, describeAnthropicError, isAnthropicAbort } from './anthropic'
import {
  ContextTooSmallError,
  MissingDocError,
  MissingKeyError,
  MissingModelError,
  OllamaUnreachableError,
} from './errors'
import { describeOpenAIError, isOpenAIAbort, openaiProvider } from './openai'
import { ollamaProvider } from './ollama'
import { CONCEPTS_TASK, ConceptsSchema, normalizeConcepts } from './prompts'
import type { Provider, StructuredCall } from './types'
import { reportFailure } from './usage'

export { sessionTotals } from './usage'

const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  ollama: ollamaProvider,
}

export { MissingDocError } from './errors'

function resolve(provider: ProviderId = activeProvider()): Provider {
  return PROVIDERS[provider]
}

export function isLocal(provider: ProviderId): boolean {
  return PROVIDERS_WITHOUT_KEYS.includes(provider)
}

export function providerState(): ProviderState {
  const provider = activeProvider()
  const local = isLocal(provider)
  const model = activeModel(provider)
  const status = local ? 'none' : keyStatus(provider)
  const hasKey = local ? true : Boolean(getApiKey(provider))

  return {
    provider,
    model,
    ollamaHost: ollamaHost(),
    local,
    hasKey,
    keyFromEnv: keySourceIsEnv(provider),
    keyUnreadable: status === 'unreadable',
    keyEncrypted: encryptionAvailable(),
    ready: hasKey && model.length > 0,
  }
}

export async function listModels(provider: ProviderId): Promise<ModelOption[]> {
  return resolve(provider).listModels()
}

const running = new Map<string, AbortController>()

/** Streams an answer, calling `emit` for each chunk. Resolves when the turn ends. */
export async function ask(
  streamId: string,
  request: AskRequest,
  emit: (event: AskEvent) => void,
): Promise<void> {
  const doc = getDoc(request.docId)
  if (!doc) throw new MissingDocError()

  const controller = new AbortController()
  running.set(streamId, controller)

  try {
    await resolve().streamAnswer({ doc, request, emit, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted || isAbort(error)) {
      emit({ type: 'done' })
      return
    }
    reportFailure('ask', error)
    throw error
  } finally {
    running.delete(streamId)
  }
}

export function cancelAsk(streamId: string): void {
  running.get(streamId)?.abort()
  running.delete(streamId)
}

/**
 * Runs one structured call against a document, under a cancellable key.
 * Shared by the concept pass and the code pass so both get the same document
 * cache, the same abort handling, and the same failure reporting.
 */
export async function runStructured<T>(
  key: string,
  docId: string,
  call: Omit<StructuredCall<T>, 'doc' | 'signal'>,
): Promise<T> {
  const doc = getDoc(docId)
  if (!doc) throw new MissingDocError()

  const controller = new AbortController()
  running.set(key, controller)
  try {
    return await resolve().structured({ ...call, doc, signal: controller.signal })
  } catch (error) {
    if (!isAbort(error)) reportFailure(call.label, error)
    throw error
  } finally {
    running.delete(key)
  }
}

export async function extractConcepts(docId: string): Promise<Concept[]> {
  const doc = getDoc(docId)
  if (!doc) throw new MissingDocError()

  const parsed = await runStructured(`concepts:${docId}`, docId, {
    label: 'concepts',
    user: CONCEPTS_TASK,
    schema: ConceptsSchema,
    maxTokens: 24000,
  })
  return normalizeConcepts(parsed, doc.pages.length)
}

function isAbort(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return isAnthropicAbort(error) || isOpenAIAbort(error)
}

/** Turns any provider's failure into something worth showing a reader. */
export function describeError(error: unknown): {
  message: string
  needsKey?: boolean
  needsDoc?: boolean
} {
  if (error instanceof MissingKeyError) return { message: error.message, needsKey: true }
  if (error instanceof MissingModelError) return { message: error.message, needsKey: true }
  if (error instanceof MissingDocError) return { message: error.message, needsDoc: true }
  if (error instanceof OllamaUnreachableError) return { message: error.message, needsKey: true }
  if (error instanceof ContextTooSmallError) return { message: error.message }

  const described = describeAnthropicError(error) ?? describeOpenAIError(error)
  if (described) return described

  return { message: error instanceof Error ? error.message : 'Something went wrong.' }
}
