import type * as z from 'zod'
import type { AskEvent, AskRequest, ModelOption, ProviderId } from '@shared/types'
import type { StoredDoc } from '../docs'

export interface AskArgs {
  doc: StoredDoc
  request: AskRequest
  emit: (event: AskEvent) => void
  signal: AbortSignal
}

/**
 * One schema-validated JSON answer about a document.
 *
 * The document goes in the same cached prefix every other request uses, and
 * whatever varies goes in `user` — so the concept pass and the code pass both
 * read the paper from cache rather than paying for it twice.
 */
export interface StructuredCall<T> {
  label: 'concepts' | 'code'
  doc: StoredDoc
  user: string
  schema: z.ZodType<T>
  maxTokens: number
  signal: AbortSignal
}

export interface Provider {
  readonly id: ProviderId
  /** Streams an answer, calling `emit` per chunk. Resolves when the turn ends. */
  streamAnswer(args: AskArgs): Promise<void>
  structured<T>(call: StructuredCall<T>): Promise<T>
  /** Models this provider can actually serve right now. */
  listModels(): Promise<ModelOption[]>
}

/** History turns, with any carried selection folded back into the text. */
export function historyTurns(request: AskRequest): { role: 'user' | 'assistant'; content: string }[] {
  return request.history.map((turn) => ({ role: turn.role, content: turn.content }))
}
