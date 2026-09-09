/**
 * Turning a concept from the paper into a shortlist of places in the code.
 *
 * All local, all free. The model never searches the repository; it only picks
 * among candidates found here, which is what keeps the cost bounded and every
 * returned path real.
 */

import type { Concept } from '@shared/types'
import type { RepoSymbol, ScannedRepo } from './scan'

export interface Candidate {
  path: string
  /** 1-indexed, inclusive. */
  startLine: number
  endLine: number
  symbol?: string
  score: number
  code: string
}

/** Words too common to carry meaning in an identifier. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'in', 'to', 'with', 'on', 'by', 'is',
  'as', 'at', 'from', 'via', 'per', 'its', 'this', 'that', 'we', 'our',
])

const SYMBOL_WINDOW_BEFORE = 2
const SYMBOL_WINDOW_AFTER = 38
const TERM_WINDOW_BEFORE = 8
const TERM_WINDOW_AFTER = 24

/** Concept terms arrive as prose, and sometimes as LaTeX. Reduce to words. */
function conceptWords(term: string): string[] {
  return term
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
}

/** `ActionChunk`, `action_chunk`, and `action-chunk` all become ["action","chunk"]. */
function symbolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function scoreSymbol(symbol: RepoSymbol, words: string[]): number {
  const parts = new Set(symbolWords(symbol.name))
  if (parts.size === 0) return 0

  const hits = words.filter((word) => parts.has(word))
  if (hits.length === 0) return 0

  // Every word of the concept appears in the identifier — the strong case.
  if (hits.length === words.length) {
    const exact = parts.size === words.length
    return exact ? 12 : 9
  }
  // A partial match only counts on a word substantial enough to mean something.
  const substantial = hits.filter((word) => word.length >= 4)
  return substantial.length > 0 ? 3 + substantial.length : 0
}

function window(
  repo: ScannedRepo,
  path: string,
  line: number,
  before: number,
  after: number,
): { startLine: number; endLine: number; code: string } | null {
  const file = repo.files.get(path)
  if (!file) return null
  const start = Math.max(1, line - before)
  const end = Math.min(file.lines.length, line + after)
  return {
    startLine: start,
    endLine: end,
    code: file.lines.slice(start - 1, end).join('\n'),
  }
}

/** The literal forms a concept is likely to take in source text. */
function literalForms(words: string[]): string[] {
  if (words.length === 0) return []
  const joined = words.join('')
  return [words.join(' '), words.join('_'), words.join('-'), joined].filter(
    (form) => form.length >= 4,
  )
}

export function candidatesFor(repo: ScannedRepo, concept: Concept, limit = 5): Candidate[] {
  const words = conceptWords(concept.term)
  if (words.length === 0) return []

  const found: Candidate[] = []

  for (const symbol of repo.symbols) {
    const score = scoreSymbol(symbol, words)
    if (score === 0) continue
    const box = window(repo, symbol.path, symbol.line, SYMBOL_WINDOW_BEFORE, SYMBOL_WINDOW_AFTER)
    if (box) found.push({ path: symbol.path, symbol: symbol.name, score, ...box })
  }

  // Mentions in comments, docstrings, and strings — weaker, but they catch the
  // cases where the paper's word is not the programmer's word.
  const forms = literalForms(words)
  if (forms.length > 0) {
    for (const file of repo.files.values()) {
      if (!forms.some((form) => file.lowered.includes(form))) continue
      const at = file.lines.findIndex((line) => {
        const lowered = line.toLowerCase()
        return forms.some((form) => lowered.includes(form))
      })
      if (at === -1) continue
      const box = window(repo, file.path, at + 1, TERM_WINDOW_BEFORE, TERM_WINDOW_AFTER)
      if (box) found.push({ path: file.path, score: 2, ...box })
    }
  }

  const best = new Map<string, Candidate>()
  for (const candidate of found.sort((a, b) => b.score - a.score)) {
    // One candidate per region: a symbol and a nearby mention are the same hit.
    const bucket = `${candidate.path}:${Math.floor(candidate.startLine / 60)}`
    if (!best.has(bucket)) best.set(bucket, candidate)
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
