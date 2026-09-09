/** Shared vocabulary for the renderer, the preload bridge, and the main process. */

export type ConceptKind = 'term' | 'method' | 'claim' | 'notation' | 'entity'

export interface Concept {
  id: string
  term: string
  /** One or two sentences, as this document uses the term. */
  definition: string
  /** Why it matters for following the argument. */
  significance: string
  kind: ConceptKind
  /** 1-indexed page where the document first establishes it. */
  firstPage: number
  /** 1-indexed pages it is used on. Widened in the renderer by a text scan. */
  pages: number[]
}

export interface Rect {
  /** Normalized 0..1 against the page box, so zoom never invalidates a mark. */
  x: number
  y: number
  w: number
  h: number
}

export interface Highlight {
  id: string
  page: number
  text: string
  rects: Rect[]
  createdAt: number
}

export type Role = 'user' | 'assistant'

export interface ChatTurn {
  id: string
  role: Role
  content: string
  /** Set on user turns that carried a passage from the page. */
  quote?: { text: string; page: number }
  streaming?: boolean
  error?: string
}

/** What the assistant is being asked to do. Shapes the user turn, not the cached prefix. */
export type AskMode = 'chat' | 'define' | 'explain' | 'deeper'

export interface AskRequest {
  docId: string
  mode: AskMode
  /** The reader's question. Empty for `define` and `explain`, which act on the selection. */
  question: string
  selection?: { text: string; page: number }
  /** Prior turns, oldest first. */
  history: { role: Role; content: string }[]
}

export type AskEvent =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string; needsKey?: boolean; needsDoc?: boolean }

export interface DocPayload {
  docId: string
  title: string
  pages: string[]
}

export interface OpenedPdf {
  /** Absolute path on disk, used as the identity of the document. */
  path: string
  name: string
  bytes: Uint8Array
}

export interface ConceptsResult {
  ok: true
  concepts: Concept[]
}

export interface Failure {
  ok: false
  message: string
  needsKey?: boolean
  needsDoc?: boolean
}

export type Result<T> = ({ ok: true } & T) | Failure

export type ProviderId = 'anthropic' | 'openai' | 'ollama'

export interface ModelOption {
  id: string
  /** Extra detail for the picker, e.g. a local model's size. */
  detail?: string
}

export interface ProviderState {
  provider: ProviderId
  /** Model chosen for the active provider. Empty until one is picked. */
  model: string
  ollamaHost: string
  /** True when this provider needs no API key at all. */
  local: boolean
  hasKey: boolean
  keyFromEnv: boolean
  /**
   * A key file exists but will not decrypt — typically after an unsigned
   * rebuild or reinstall, which invalidates the keychain entry.
   */
  keyUnreadable: boolean
  /**
   * False when the OS keyring is unavailable, so the key is on disk as plain
   * text with owner-only permissions. Worth telling the reader about.
   */
  keyEncrypted: boolean
  /** Everything needed to actually ask a question is in place. */
  ready: boolean
}

/** The surface `preload` exposes on `window.tiro`. */
export interface TiroBridge {
  openPdf(): Promise<OpenedPdf | null>
  /** Resolves a dropped File to its path on disk. */
  pathForFile(file: File): string
  readPdf(path: string): Promise<OpenedPdf | null>
  registerDoc(payload: DocPayload): Promise<Result<Record<string, never>>>
  concepts(docId: string): Promise<Result<{ concepts: Concept[] }>>
  ask(streamId: string, request: AskRequest, onEvent: (event: AskEvent) => void): Promise<void>
  cancelAsk(streamId: string): void
  getProviderState(): Promise<ProviderState>
  setProvider(provider: ProviderId, model: string): Promise<ProviderState>
  setOllamaHost(host: string): Promise<ProviderState>
  listModels(provider: ProviderId): Promise<Result<{ models: ModelOption[] }>>
  setApiKey(provider: ProviderId, key: string): Promise<Result<Record<string, never>>>
  clearApiKey(provider: ProviderId): Promise<ProviderState>
  onOpenFile(handler: (file: OpenedPdf) => void): () => void
  onMenu(handler: (action: MenuAction) => void): () => void
  platform: string
}

export type MenuAction = 'open' | 'settings' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'find'
