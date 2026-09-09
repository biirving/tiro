import { createHash } from 'node:crypto'

/**
 * Document text lives here, keyed by file path.
 *
 * The renderer extracts page text once with pdf.js and registers it; every later
 * request refers to the document by id. That keeps the cached prompt prefix
 * byte-identical between requests, which is what makes prompt caching pay off.
 */

export interface StoredDoc {
  id: string
  title: string
  /**
   * Stable, non-identifying handle for this document, used to route requests
   * about it to the same prompt cache. Derived from the path, not the path.
   */
  cacheKey: string
  pages: string[]
  /** Page-marked full text, built once so the cached prefix never shifts. */
  text: string
  storedAt: number
}

const MAX_DOCS = 8

/** Claude accepts 1M tokens; stop short of it and say so rather than truncating. */
const MAX_CHARS = 2_400_000

const docs = new Map<string, StoredDoc>()

export function estimateTokens(chars: number): number {
  return Math.round(chars / 3.7)
}

export class DocTooLargeError extends Error {
  constructor(charCount: number) {
    super(
      `This document holds roughly ${estimateTokens(charCount).toLocaleString()} tokens of text, ` +
        `past the ${estimateTokens(MAX_CHARS).toLocaleString()} token ceiling for a single request. ` +
        `Nothing was cut — split the PDF and open the part you are reading.`,
    )
    this.name = 'DocTooLargeError'
  }
}

export function putDoc({ docId, title, pages }: { docId: string; title: string; pages: string[] }): StoredDoc {
  const text = pages.map((page, i) => `[page ${i + 1}]\n${page.trim()}`).join('\n\n')
  if (text.length > MAX_CHARS) throw new DocTooLargeError(text.length)

  const doc: StoredDoc = {
    id: docId,
    title,
    cacheKey: createHash('sha256').update(docId).digest('hex').slice(0, 24),
    pages,
    text,
    storedAt: Date.now(),
  }
  docs.set(docId, doc)

  while (docs.size > MAX_DOCS) {
    const oldest = [...docs.values()].sort((a, b) => a.storedAt - b.storedAt)[0]
    docs.delete(oldest.id)
  }
  return doc
}

export function getDoc(id: string): StoredDoc | undefined {
  return docs.get(id)
}
