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
