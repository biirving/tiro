/**
 * Cutting a document into passages worth retrieving.
 *
 * Page-sized chunks retrieve badly: a dense page runs to a thousand tokens and
 * covers several ideas, so a hit tells you little. Paragraphs are the unit a
 * paper is actually written in, and every chunk keeps the page it came from so
 * a retrieved passage can still be cited as [p. 12].
 */

export interface DocChunk {
  /** 1-indexed page the passage starts on. */
  page: number
  /** Position within the document, for stable ids across re-indexing. */
  ordinal: number
  text: string
}

/** Below this a passage carries too little to stand alone; it joins its neighbour. */
const MIN_CHARS = 220
/** Above this, retrieval returns more than a reader wants to be handed. */
const MAX_CHARS = 1400

function splitLongPassage(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text]

  // Prefer sentence ends, so a split lands between thoughts.
  const pieces: string[] = []
  let rest = text
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS)
    const boundary = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
    )
    const cut = boundary > MAX_CHARS * 0.5 ? boundary + 1 : MAX_CHARS
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) pieces.push(rest.trim())
  return pieces
}

function passagesOnPage(pageText: string): string[] {
  const parts = pageText
    .replace(/\r/g, '')
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  // Fold fragments — a stray heading or caption line — into what follows.
  const merged: string[] = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.length < MIN_CHARS) merged[merged.length - 1] = `${last} ${part}`
    else merged.push(part)
  }

  return merged.flatMap(splitLongPassage).filter((text) => text.length > 0)
}

/**
 * Chunks are cut per page, so a passage never straddles a page break and its
 * page number is always exact. The cost is that an idea split across a break
 * arrives as two passages; retrieval returning both is the usual outcome.
 */
export function chunkDocument(pages: string[]): DocChunk[] {
  const chunks: DocChunk[] = []
  pages.forEach((pageText, index) => {
    for (const text of passagesOnPage(pageText)) {
      chunks.push({ page: index + 1, ordinal: chunks.length, text })
    }
  })
  return chunks
}

// --- code -------------------------------------------------------------------

export interface CodeChunk {
  path: string
  /** 1-indexed, inclusive. */
  startLine: number
  endLine: number
  /** The declaration this chunk is built around, when there is one. */
  symbol?: string
  ordinal: number
  text: string
}

/** A declaration longer than this is cut; a whole 900-line class retrieves poorly. */
const MAX_CODE_LINES = 80
/** Files with no declarations found still get indexed, in windows this big. */
const WINDOW_LINES = 60

interface Declaration {
  name: string
  line: number
}

/**
 * Chunks source by declaration rather than by fixed windows.
 *
 * A function with its body is the unit someone asks about, so a hit lands on
 * something nameable. Spans run from one declaration to the next — an
 * approximation, since finding a real end needs a parser, but one that keeps
 * bodies intact far more often than a blind window does.
 */
export function chunkCode(
  files: { path: string; lines: string[] }[],
  declarationsByPath: Map<string, Declaration[]>,
): CodeChunk[] {
  const chunks: CodeChunk[] = []

  const push = (
    path: string,
    lines: string[],
    startLine: number,
    endLine: number,
    symbol?: string,
  ): void => {
    const text = lines.slice(startLine - 1, endLine).join('\n').trim()
    if (!text) return
    chunks.push({ path, startLine, endLine, symbol, ordinal: chunks.length, text })
  }

  for (const file of files) {
    const declarations = (declarationsByPath.get(file.path) ?? [])
      .slice()
      .sort((a, b) => a.line - b.line)

    if (declarations.length === 0) {
      for (let at = 1; at <= file.lines.length; at += WINDOW_LINES) {
        push(file.path, file.lines, at, Math.min(file.lines.length, at + WINDOW_LINES - 1))
      }
      continue
    }

    // Anything above the first declaration — imports, module docstring — is
    // its own chunk, since that is where a file says what it is for.
    if (declarations[0].line > 1) {
      push(file.path, file.lines, 1, Math.min(declarations[0].line - 1, MAX_CODE_LINES))
    }

    declarations.forEach((declaration, i) => {
      const next = declarations[i + 1]
      const limit = next ? next.line - 1 : file.lines.length
      let from = declaration.line
      // A long body becomes several chunks, each still named for its declaration.
      while (from <= limit) {
        const to = Math.min(limit, from + MAX_CODE_LINES - 1)
        push(file.path, file.lines, from, to, declaration.name)
        from = to + 1
      }
    })
  }

  return chunks
}
