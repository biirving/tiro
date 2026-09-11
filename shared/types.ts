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

/** What the assistant is being asked to do. Shapes the user turn, not the cached prefix. */
export type AskMode = 'chat' | 'define' | 'explain' | 'deeper'

export interface ChatTurn {
  id: string
  role: Role
  content: string
  /** Set on user turns that carried a passage from the page. */
  quote?: { text: string; page: number }
  /** What was asked for. Lets a Define turn read as an action, not a sentence. */
  mode?: AskMode
  streaming?: boolean
  error?: string
  /** What the model did in the repository before answering, in order. */
  tools?: string[]
}

export interface AskRequest {
  docId: string
  mode: AskMode
  /** The reader's question. Empty for `define` and `explain`, which act on the selection. */
  question: string
  selection?: { text: string; page: number }
  /** Prior turns, oldest first. */
  history: { role: Role; content: string }[]
  /** When set, the answer may search and read this repository. */
  repoPath?: string
}

export type AskEvent =
  | { type: 'text'; text: string }
  /** The model looked something up in the linked repository. */
  | { type: 'tool'; text: string }
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

/** A place in the repository that implements a concept from the paper. */
export interface CodeLocation {
  /** Repo-relative, always. Absolute paths never cross to the renderer. */
  path: string
  /** 1-indexed, inclusive. */
  startLine: number
  endLine: number
  /** The declaration this sits in, when the match is a symbol. */
  symbol?: string
  /** One sentence on why this is the code for the concept. */
  reason: string
  /** The lines themselves, so the list renders without another read. */
  snippet: string
}

export interface ConceptCode {
  conceptId: string
  locations: CodeLocation[]
}

export interface RepoLink {
  /** Absolute path on disk. Shown to the reader, never used for lookups. */
  path: string
  /** Basename, for the tab header. */
  name: string
  /** Source files the scan actually indexed. */
  fileCount: number
}

export interface CodeFile {
  path: string
  content: string
  lineCount: number
  truncated: boolean
}

/** A tool an MCP server advertises, as Tiro forwards it to a model. */
export interface McpToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Whether the optional ferry document index is present. Absence is normal:
 * every Tiro feature that does not concern the index behaves the same either
 * way, and nothing surfaces an error for it.
 */
export interface FerryStatus {
  available: boolean
  source: 'environment' | 'setting' | 'path' | 'none'
  command: string | null
  /** Why it is unavailable, phrased for a reader rather than a log. */
  reason: string | null
  tools: { name: string; description: string }[]
}

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
  pickRepo(): Promise<RepoLink | null>
  linkRepo(path: string): Promise<Result<{ repo: RepoLink }>>
  matchCode(
    docId: string,
    repoPath: string,
    concepts: Concept[],
  ): Promise<Result<{ matches: ConceptCode[] }>>
  readCode(repoPath: string, filePath: string): Promise<Result<{ file: CodeFile }>>
  ask(streamId: string, request: AskRequest, onEvent: (event: AskEvent) => void): Promise<void>
  cancelAsk(streamId: string): void
  getFerryStatus(refresh?: boolean): Promise<FerryStatus>
  setFerryCommand(command: string): Promise<FerryStatus>
  getProviderState(): Promise<ProviderState>
  setProvider(provider: ProviderId, model: string): Promise<ProviderState>
  setOllamaHost(host: string): Promise<ProviderState>
  listModels(provider: ProviderId): Promise<Result<{ models: ModelOption[] }>>
  setApiKey(provider: ProviderId, key: string): Promise<Result<Record<string, never>>>
  clearApiKey(provider: ProviderId): Promise<ProviderState>
  openExternal(url: string): void
  onOpenFile(handler: (file: OpenedPdf) => void): () => void
  onMenu(handler: (action: MenuAction) => void): () => void
  platform: string
}

export type MenuAction =
  | 'open'
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'settings'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'find'
