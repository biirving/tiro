import type { AskEvent, AskRequest, Concept, ModelOption, ProviderId } from '@shared/types'
import type { StoredDoc } from '../docs'

export interface AskArgs {
  doc: StoredDoc
  request: AskRequest
  emit: (event: AskEvent) => void
  signal: AbortSignal
}

export interface Provider {
  readonly id: ProviderId
  /** Streams an answer, calling `emit` per chunk. Resolves when the turn ends. */
  streamAnswer(args: AskArgs): Promise<void>
  /** One pass over the whole document, returning the concept map. */
  extractConcepts(doc: StoredDoc, signal: AbortSignal): Promise<Concept[]>
  /** Models this provider can actually serve right now. */
  listModels(): Promise<ModelOption[]>
}

/** History turns, with any carried selection folded back into the text. */
export function historyTurns(request: AskRequest): { role: 'user' | 'assistant'; content: string }[] {
  return request.history.map((turn) => ({ role: turn.role, content: turn.content }))
}
