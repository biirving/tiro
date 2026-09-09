import type { ProviderId } from '@shared/types'

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
}

export function providerLabel(provider: ProviderId): string {
  return LABEL[provider]
}

export class MissingKeyError extends Error {
  constructor(provider: ProviderId) {
    super(`Add a ${LABEL[provider]} API key in Settings to ask about a document.`)
    this.name = 'MissingKeyError'
  }
}

export class MissingModelError extends Error {
  constructor(provider: ProviderId) {
    super(`Pick a ${LABEL[provider]} model in Settings.`)
    this.name = 'MissingModelError'
  }
}

export class MissingDocError extends Error {
  constructor() {
    super('This document is no longer loaded. Reopen the PDF.')
    this.name = 'MissingDocError'
  }
}

export class OllamaUnreachableError extends Error {
  constructor(host: string) {
    super(
      `No Ollama at ${host}. Start it with \`ollama serve\`, or point Tiro at a different host in Settings.`,
    )
    this.name = 'OllamaUnreachableError'
  }
}

export class ContextTooSmallError extends Error {
  constructor(model: string, needed: number, limit: number) {
    super(
      `This document needs about ${needed.toLocaleString()} tokens of context and ${model} tops out at ${limit.toLocaleString()}. ` +
        `Nothing was truncated — pick a longer-context model, or split the PDF.`,
    )
    this.name = 'ContextTooSmallError'
  }
}
