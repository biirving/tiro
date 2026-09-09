/**
 * Per-document memory: marks, concepts, and the conversation.
 *
 * Concepts cost a whole-document read to produce, so they are cached here and
 * reused when the same file is reopened.
 */

import type { ChatTurn, Concept, Highlight } from '@shared/types'

const DOC_PREFIX = 'tiro:doc:'
const RECENTS_KEY = 'tiro:recents'
const MAX_RECENTS = 12

export interface DocRecord {
  version: 1
  title: string
  concepts: Concept[]
  highlights: Highlight[]
  chat: ChatTurn[]
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

export function newId(): string {
  return crypto.randomUUID()
}
