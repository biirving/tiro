/**
 * Per-document memory: marks, concepts, and the conversation.
 *
 * Concepts cost a whole-document read to produce, so they are cached here and
 * reused when the same file is reopened.
 */

import type { ChatTurn, Concept, ConceptCode, Highlight, RepoLink } from '@shared/types'

const DOC_PREFIX = 'tiro:doc:'
const RECENTS_KEY = 'tiro:recents'
const MAX_RECENTS = 12

export interface DocRecord {
  version: 1
  title: string
  concepts: Concept[]
  highlights: Highlight[]
  chat: ChatTurn[]
  /** The linked repository, so it survives closing the tab. */
  repo: RepoLink | null
  /** Cached so a code pass, like a concept pass, is paid for once. */
  codeMatches: ConceptCode[]
  updatedAt: number
}

export interface RecentDoc {
  path: string
  title: string
  pages: number
  updatedAt: number
}

const empty = (title: string): DocRecord => ({
  version: 1,
  title,
  concepts: [],
  highlights: [],
  chat: [],
  repo: null,
  codeMatches: [],
  updatedAt: Date.now(),
})

function docKey(path: string): string {
  // Paths contain characters that are awkward in keys; the path is the identity.
  return DOC_PREFIX + encodeURIComponent(path)
}

export function loadRecord(path: string, title: string): DocRecord {
  try {
    const raw = localStorage.getItem(docKey(path))
    if (!raw) return empty(title)
    const parsed = JSON.parse(raw) as DocRecord
    if (parsed.version !== 1) return empty(title)
    return {
      ...empty(title),
      ...parsed,
      // A turn cannot still be streaming across a restart.
      chat: parsed.chat.map((turn) => ({ ...turn, streaming: false })),
    }
  } catch {
    return empty(title)
  }
}

export function saveRecord(path: string, record: Omit<DocRecord, 'version' | 'updatedAt'>): void {
  try {
    const payload: DocRecord = { ...record, version: 1, updatedAt: Date.now() }
    localStorage.setItem(docKey(path), JSON.stringify(payload))
  } catch {
    // Out of quota is not worth interrupting a reading session over.
  }
}

const pendingWrites = new Map<string, number>()

/**
 * Writes on a delay, keyed by document.
 *
 * A streamed answer updates the conversation on every chunk; without this each
 * chunk would serialise and store the whole record.
 */
export function saveRecordSoon(
  path: string,
  record: Omit<DocRecord, 'version' | 'updatedAt'>,
  delay = 600,
): void {
  const queued = pendingWrites.get(path)
  if (queued !== undefined) window.clearTimeout(queued)
  pendingWrites.set(
    path,
    window.setTimeout(() => {
      pendingWrites.delete(path)
      saveRecord(path, record)
    }, delay),
  )
}

/** Forces any queued write out now — on tab close, or before the window goes. */
export function flushRecord(path: string, record: Omit<DocRecord, 'version' | 'updatedAt'>): void {
  const queued = pendingWrites.get(path)
  if (queued !== undefined) window.clearTimeout(queued)
  pendingWrites.delete(path)
  saveRecord(path, record)
}

export function recents(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    return raw ? (JSON.parse(raw) as RecentDoc[]) : []
  } catch {
    return []
  }
}

export function rememberRecent(entry: Omit<RecentDoc, 'updatedAt'>): void {
  try {
    const next = [
      { ...entry, updatedAt: Date.now() },
      ...recents().filter((doc) => doc.path !== entry.path),
    ].slice(0, MAX_RECENTS)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Ignore.
  }
}

export function forgetRecent(path: string): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents().filter((d) => d.path !== path)))
  } catch {
    // Ignore.
  }
}

const PANEL_WIDTH_KEY = 'tiro:panel-width'

export function readPanelWidth(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export function writePanelWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // A lost preference is not worth interrupting a reading session over.
  }
}

const PANEL_SCALE_KEY = 'tiro:panel-scale'

export function readPanelScale(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_SCALE_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export function writePanelScale(scale: number): void {
  try {
    localStorage.setItem(PANEL_SCALE_KEY, scale.toFixed(2))
  } catch {
    // A lost preference is not worth interrupting a reading session over.
  }
}

export function newId(): string {
  return crypto.randomUUID()
}
