/**
 * Text utilities: finding concepts on a page, and rendering the assistant's
 * answers with clickable page citations.
 */

import type { Concept } from '@shared/types'

/** Word-boundary-ish match that tolerates the spacing pdf.js pulls out of a PDF. */
function termPattern(term: string): RegExp | null {
  // Terms come back as LaTeX when they are notation. Drop the delimiters, and
  // give up on anything with real commands in it — "\\pi_\\theta" will never
  // match the text pdf.js extracted, and trying would only mismatch.
  const bare = term
    .trim()
    .replace(/^\$+|\$+$/g, '')
    .replace(/^\\[([]|\\[)\]]$/g, '')
    .trim()
  if (bare.includes('\\')) return null

  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (escaped.length < 2) return null
  const flexible = escaped.replace(/\s+/g, '\\s+')
  const boundary = /^[\w]/.test(bare) ? '\\b' : ''
  return new RegExp(`${boundary}${flexible}`, 'i')
}

/**
 * Widens each concept's page list with a literal scan of the page text.
 *
 * The model reports where a concept does load-bearing work; the scan catches
 * every other page that mentions it. Together they answer "what on this page
 * was defined somewhere I've already read past".
 */
export function widenConceptPages(concepts: Concept[], pageTexts: string[]): Concept[] {
  return concepts.map((concept) => {
    const pattern = termPattern(concept.term)
    if (!pattern) return concept

    const found = new Set(concept.pages)
    pageTexts.forEach((text, i) => {
      if (pattern.test(text)) found.add(i + 1)
    })
    return { ...concept, pages: [...found].sort((a, b) => a - b) }
  })
}

export interface PageSlice {
  /** Established on this page. */
  introduced: Concept[]
  /** Used here, established earlier — the ones a reader wishes they hadn't skimmed. */
  carried: Concept[]
}

export function conceptsForPage(concepts: Concept[], page: number): PageSlice {
  const onPage = concepts.filter((c) => c.firstPage === page || c.pages.includes(page))
  return {
    introduced: onPage.filter((c) => c.firstPage === page),
    carried: onPage
      .filter((c) => c.firstPage < page)
      .sort((a, b) => b.firstPage - a.firstPage),
  }
}

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'page'; label: string; page: number }
  | { kind: 'math'; tex: string; display: boolean }

const PAGE_REF = /\[(?:pp?\.|pages?|p)\s*(\d+)(?:\s*[-–—]\s*(\d+))?\]/gi
const MARKUP = /(\*\*[^*]+\*\*|(?<![*\w])\*[^*\n]+\*(?!\w)|`[^`]+`)/g

/**
 * LaTeX delimiters, longest first. The bare `$…$` form requires non-space just
 * inside both delimiters, which is what keeps "$5 and $10" out of the parser.
 */
const MATH =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g

interface MathSlice {
  tex?: string
  /** True for $$…$$ and \[…\]. KaTeX's display output is span-only, so this
   *  is safe to render inside a paragraph. */
  display?: boolean
  text?: string
}

/** Cuts a line into alternating prose and math. */
function splitMath(line: string): MathSlice[] {
  const slices: MathSlice[] = []
  let cursor = 0

  for (const match of line.matchAll(MATH)) {
    const start = match.index
    if (start > cursor) slices.push({ text: line.slice(cursor, start) })
    const display = match[1] !== undefined || match[2] !== undefined
    const tex = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    slices.push({ tex: tex.trim(), display })
    cursor = start + match[0].length
  }
  if (cursor < line.length) slices.push({ text: line.slice(cursor) })

  return slices
}

/** Splits one line into inline runs: math, page citations, bold, italic, code. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = []

  const pushMarkup = (text: string): void => {
    for (const piece of text.split(MARKUP)) {
      if (!piece) continue
      if (piece.startsWith('**') && piece.endsWith('**')) {
        out.push({ kind: 'strong', text: piece.slice(2, -2) })
      } else if (piece.startsWith('`') && piece.endsWith('`')) {
        out.push({ kind: 'code', text: piece.slice(1, -1) })
      } else if (piece.startsWith('*') && piece.endsWith('*') && piece.length > 2) {
        out.push({ kind: 'em', text: piece.slice(1, -1) })
      } else {
        out.push({ kind: 'text', text: piece })
      }
    }
  }

  const pushProse = (prose: string): void => {
    let cursor = 0
    for (const match of prose.matchAll(PAGE_REF)) {
      const start = match.index
      if (start > cursor) pushMarkup(prose.slice(cursor, start))
      const first = Number(match[1])
      const last = match[2] ? Number(match[2]) : null
      out.push({
        kind: 'page',
        label: last ? `p. ${first}–${last}` : `p. ${first}`,
        page: first,
      })
      cursor = start + match[0].length
    }
    if (cursor < prose.length) pushMarkup(prose.slice(cursor))
  }

  // Math comes out first so markup and citation parsing never touch a formula.
  for (const slice of splitMath(line)) {
    if (slice.tex !== undefined) {
      out.push({ kind: 'math', tex: slice.tex, display: Boolean(slice.display) })
    }
    else if (slice.text) pushProse(slice.text)
  }

  return out
}

export type Block =
  | { kind: 'para'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'steps'; items: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'math'; tex: string }

/** Light structure only — the assistant is told to write prose, not documents. */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r/g, '').split('\n')

  // A blank line ends a paragraph; without this every answer becomes one block.
  let afterBlank = true
  /** Set while inside a multi-line $$…$$ or \[…\] block. */
  let mathLines: string[] | null = null

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (mathLines) {
      const close = /\$\$|\\\]/.exec(line)
      if (close) {
        mathLines.push(line.slice(0, close.index))
        blocks.push({ kind: 'math', tex: mathLines.join('\n').trim() })
        mathLines = null
        afterBlank = false
      } else {
        mathLines.push(line)
      }
      continue
    }

    const trimmed = line.trim()
    const opens = /^(\$\$|\\\[)/.exec(trimmed)
    if (opens) {
      const rest = trimmed.slice(opens[1].length)
      const closer = opens[1] === '$$' ? '$$' : '\\]'
      if (rest.endsWith(closer) && rest.length > closer.length) {
        // Display math opened and closed on one line.
        blocks.push({ kind: 'math', tex: rest.slice(0, -closer.length).trim() })
        afterBlank = false
      } else {
        mathLines = rest ? [rest] : []
      }
      continue
    }

    if (!trimmed) {
      afterBlank = true
      continue
    }
    const last = blocks[blocks.length - 1]

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (bullet) {
      if (last?.kind === 'bullets') last.items.push(bullet[1])
      else blocks.push({ kind: 'bullets', items: [bullet[1]] })
      afterBlank = false
      continue
    }

    const step = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (step) {
      if (last?.kind === 'steps') last.items.push(step[1])
      else blocks.push({ kind: 'steps', items: [step[1]] })
      afterBlank = false
      continue
    }

    const heading = /^#{1,4}\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] })
      afterBlank = false
      continue
    }

    if (last?.kind === 'para' && !afterBlank) last.lines.push(line.trim())
    else blocks.push({ kind: 'para', lines: [line.trim()] })
    afterBlank = false
  }

  if (mathLines?.length) blocks.push({ kind: 'math', tex: mathLines.join('\n').trim() })

  return blocks
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}
