/**
 * The pdf.js side of the app: open a file, render a page, pull out text.
 */

import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PageViewport,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

/** Copied into renderer/public by scripts/copy-pdfjs-assets.mjs. */
const ASSETS = {
  cMapUrl: 'pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'pdfjs/standard_fonts/',
  wasmUrl: 'pdfjs/wasm/',
  iccUrl: 'pdfjs/iccs/',
}

export interface OutlineEntry {
  title: string
  page: number
  depth: number
}

export interface OpenedDocument {
  pdf: PDFDocumentProxy
  /**
   * Releases this document's worker resources. Lives on the loading task, not
   * the document, which is why the task is kept rather than discarded.
   */
  destroy: () => Promise<void>
}

export async function openDocument(bytes: Uint8Array): Promise<OpenedDocument> {
  // pdf.js takes ownership of the buffer, so hand it a copy we don't reuse.
  const task = getDocument({ data: bytes, ...ASSETS })
  const pdf = await task.promise
  return { pdf, destroy: () => task.destroy() }
}

/** A readable title: the PDF's own metadata title if it has a real one, else the filename. */
export async function documentTitle(pdf: PDFDocumentProxy, fallback: string): Promise<string> {
  try {
    const { info } = (await pdf.getMetadata()) as { info?: { Title?: string } }
    const title = info?.Title?.trim()
    if (title && title.length > 2 && !/^untitled$/i.test(title)) return title
  } catch {
    // Metadata is optional; the filename is a fine name.
  }
  return fallback.replace(/\.pdf$/i, '')
}

/** Page text, one string per page, in reading order. */
export async function extractPageText(
  pdf: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const pages: string[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      text += item.str
      if (item.hasEOL) text += '\n'
    }
    pages.push(text)
    page.cleanup()
    onProgress?.(n, pdf.numPages)
  }
  return pages
}

export async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  type RawItem = { title: string; dest: unknown; items?: RawItem[] }
  let raw: RawItem[] | null = null
  try {
    raw = (await pdf.getOutline()) as RawItem[] | null
  } catch {
    return []
  }
  if (!raw?.length) return []

  const resolvePage = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
      if (!Array.isArray(explicit)) return null
      const ref = explicit[0]
      if (typeof ref === 'number') return ref + 1
      if (ref && typeof ref === 'object') return (await pdf.getPageIndex(ref as never)) + 1
      return null
    } catch {
      return null
    }
  }

  const entries: OutlineEntry[] = []
  const walk = async (items: RawItem[], depth: number): Promise<void> => {
    for (const item of items) {
      const page = await resolvePage(item.dest)
      if (page && item.title?.trim()) {
        entries.push({ title: item.title.trim(), page, depth })
      }
      if (item.items?.length) await walk(item.items, depth + 1)
    }
  }
  await walk(raw, 0)
  return entries
}

export interface RenderedPage {
  cancel: () => void
  done: Promise<void>
}

/**
 * Paints a page onto `canvas` and builds the selectable text layer over it.
 * The canvas is sized for the display's pixel ratio; CSS keeps it at page size.
 */
export function renderPage(
  page: PDFPageProxy,
  scale: number,
  canvas: HTMLCanvasElement,
  textLayerEl: HTMLElement,
): RenderedPage {
  const viewport: PageViewport = page.getViewport({ scale })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)

  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`

  const context = canvas.getContext('2d', { alpha: false })
  context?.setTransform(ratio, 0, 0, ratio, 0, 0)

  const task = page.render({ canvas, viewport })
  let textLayer: TextLayer | null = null

  const done = (async () => {
    await task.promise
    textLayerEl.textContent = ''
    textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerEl,
      viewport,
    })
    await textLayer.render()
  })().catch((error: unknown) => {
    // A cancelled render is the expected outcome of scrolling away.
    if (error instanceof Error && error.name === 'RenderingCancelledException') return
    throw error
  })

  return {
    cancel: () => {
      task.cancel()
      textLayer?.cancel()
    },
    done,
  }
}

/** Page box in CSS pixels at scale 1, used to lay out placeholders before render. */
export function pageSize(page: PDFPageProxy, scale: number): { width: number; height: number } {
  const viewport = page.getViewport({ scale })
  return { width: Math.floor(viewport.width), height: Math.floor(viewport.height) }
}

// --- links and citations ------------------------------------------------------

export interface LinkTarget {
  /** An address elsewhere in this document — usually a bibliography entry. */
  internal?: { page: number; y: number; key?: string }
  /** A URL to hand to the browser. */
  url?: string
}

export interface PageLink extends LinkTarget {
  /** Normalized 0..1 against the page box, so zoom does not matter. */
  rect: { x: number; y: number; w: number; h: number }
}

/** Resolves a destination — named or explicit — to a page and a y position. */
async function resolveDestination(
  pdf: PDFDocumentProxy,
  dest: unknown,
): Promise<{ page: number; y: number } | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    if (!Array.isArray(explicit)) return null
    const ref = explicit[0]
    const page =
      typeof ref === 'number' ? ref + 1 : (await pdf.getPageIndex(ref as never)) + 1
    // XYZ destinations carry [x, y, zoom]; others may carry nothing usable.
    const y = typeof explicit[3] === 'number' ? explicit[3] : 0
    return { page, y }
  } catch {
    return null
  }
}

/**
 * The clickable links on a page.
 *
 * A paper's own citations are link annotations pointing into its bibliography,
 * which is why they do nothing until this layer exists.
 */
export async function readPageLinks(
  pdf: PDFDocumentProxy,
  pageNumber: number,
): Promise<PageLink[]> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })

  let annotations: { subtype?: string; rect?: number[]; dest?: unknown; url?: string }[]
  try {
    annotations = (await page.getAnnotations()) as typeof annotations
  } catch {
    return []
  }

  const links: PageLink[] = []
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link') continue
    const box = annotation.rect
    if (!box || box.length < 4) continue

    // PDF space is bottom-left origin; convert both corners to top-left pixels.
    const [x1, y1] = viewport.convertToViewportPoint(box[0], box[1]) as number[]
    const [x2, y2] = viewport.convertToViewportPoint(box[2], box[3]) as number[]
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const rect = {
      x: left / viewport.width,
      y: top / viewport.height,
      w: Math.abs(x2 - x1) / viewport.width,
      h: Math.abs(y2 - y1) / viewport.height,
    }
    if (rect.w <= 0 || rect.h <= 0) continue

    if (annotation.url) {
      links.push({ rect, url: annotation.url })
      continue
    }
    if (annotation.dest !== undefined && annotation.dest !== null) {
      const target = await resolveDestination(pdf, annotation.dest)
      if (target) {
        const key = typeof annotation.dest === 'string' ? annotation.dest : undefined
        links.push({ rect, internal: { ...target, key } })
      }
    }
  }
  page.cleanup()
  return links
}

/** How far below the anchor a reference entry may run, in PDF points. */
const ENTRY_HEIGHT = 90
/** Column width, so a two-column bibliography does not interleave. */
const COLUMN_WIDTH = 300
const MAX_ENTRY_CHARS = 600

/**
 * Pulls the bibliography entry a citation points at.
 *
 * A destination is only a coordinate, so this reads the lines starting there and
 * stops at the next entry — enough to recognise the work and paste it into a
 * search, without leaving the page you were reading.
 */
export async function referenceAt(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  anchorY: number,
): Promise<string> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()

  interface Line {
    y: number
    x: number
    text: string
  }
  const byRow = new Map<number, Line>()

  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const x = item.transform[4] as number
    const y = item.transform[5] as number
    // Round to a row so wrapped words in the same line group together.
    const row = Math.round(y / 2) * 2
    const existing = byRow.get(row)
    if (existing) {
      existing.text += item.str
      existing.x = Math.min(existing.x, x)
    } else {
      byRow.set(row, { y, x, text: item.str })
    }
  }
  page.cleanup()

  const lines = [...byRow.values()].sort((a, b) => b.y - a.y)
  const start = lines.findIndex((line) => line.y <= anchorY + 4)
  if (start === -1) return ''

  const column = lines[start].x
  const inColumn = (line: (typeof lines)[number]): boolean =>
    line.x >= column - 40 && line.x <= column + COLUMN_WIDTH

  const following = lines.slice(start + 1).filter(inColumn)
  const spacing = following.length > 0 ? lines[start].y - following[0].y : 0
  /**
   * Bibliographies hang their continuation lines. When they do, a line back at
   * the entry's own indent is the next entry — the only reliable boundary in an
   * author-year style, which has no [n] marker to look for.
   */
  const hanging = following.length > 0 && following[0].x > column + 4

  const parts: string[] = [lines[start].text.trim()]
  let previousY = lines[start].y

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.y < anchorY - ENTRY_HEIGHT) break
    if (!inColumn(line)) continue

    // A numbered style ends the entry the easy way.
    if (/^\s*\[\d+\]/.test(line.text)) break
    // A hanging-indent style ends when the indent returns to the margin.
    if (hanging && line.x <= column + 4) break
    // Otherwise, a gap noticeably larger than the line spacing.
    if (spacing > 0 && previousY - line.y > spacing * 1.7) break

    parts.push(line.text.trim())
    previousY = line.y
    if (parts.join(' ').length > MAX_ENTRY_CHARS) break
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS)
}
