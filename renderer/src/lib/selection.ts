/**
 * Turning a browser text selection into marks we can store and redraw.
 *
 * Rects are normalized against the page box, so a highlight made at 100% still
 * lands correctly at 180% or after a window resize.
 */

import type { Rect } from '@shared/types'

export interface PageRects {
  page: number
  rects: Rect[]
}

export interface PickedSelection {
  text: string
  /** Page the selection starts on — what gets shown as its location. */
  page: number
  /** One entry per page the selection touches, so a mark can span a page break. */
  byPage: PageRects[]
  /** Viewport coordinates for the floating menu. */
  anchor: { x: number; y: number }
}

/** Joins rects that sit on the same line, so a marked sentence reads as one band. */
function mergeLines(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: Rect[] = []

  for (const rect of sorted) {
    const last = lines[lines.length - 1]
    const sameLine =
      last &&
      Math.abs(last.y - rect.y) < rect.h * 0.6 &&
      Math.abs(last.h - rect.h) < rect.h * 0.6 &&
      rect.x <= last.x + last.w + rect.h * 0.6

    if (sameLine) {
      const right = Math.max(last.x + last.w, rect.x + rect.w)
      const bottom = Math.max(last.y + last.h, rect.y + rect.h)
      last.y = Math.min(last.y, rect.y)
      last.x = Math.min(last.x, rect.x)
      last.w = right - last.x
      last.h = bottom - last.y
    } else {
      lines.push({ ...rect })
    }
  }
  return lines
}

/**
 * Reads the current selection out of the viewer.
 * Returns null when there is nothing selected, or the selection is empty text.
 */
export function pickSelection(root: HTMLElement): PickedSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (text.length < 2) return null

  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const pageBoxes = [...root.querySelectorAll<HTMLElement>('[data-page]')].map((el) => ({
    page: Number(el.dataset.page),
    box: el.getBoundingClientRect(),
  }))

  const grouped = new Map<number, Rect[]>()
  /** Union of every rect, so the menu centres under the selection as a whole. */
  const bounds = { left: Infinity, right: -Infinity, bottom: -Infinity }

  for (const clientRect of range.getClientRects()) {
    if (clientRect.width < 1 || clientRect.height < 1) continue

    const midX = clientRect.left + clientRect.width / 2
    const midY = clientRect.top + clientRect.height / 2
    const hit = pageBoxes.find(
      ({ box }) =>
        midX >= box.left && midX <= box.right && midY >= box.top && midY <= box.bottom,
    )
    if (!hit) continue

    const { page, box } = hit
    const rects = grouped.get(page) ?? []
    rects.push({
      x: (clientRect.left - box.left) / box.width,
      y: (clientRect.top - box.top) / box.height,
      w: clientRect.width / box.width,
      h: clientRect.height / box.height,
    })
    grouped.set(page, rects)

    bounds.left = Math.min(bounds.left, clientRect.left)
    bounds.right = Math.max(bounds.right, clientRect.right)
    bounds.bottom = Math.max(bounds.bottom, clientRect.bottom)
  }

  if (!grouped.size) return null

  const anchor = { x: (bounds.left + bounds.right) / 2, y: bounds.bottom }

  const byPage = [...grouped.entries()]
    .map(([page, rects]) => ({ page, rects: mergeLines(rects) }))
    .sort((a, b) => a.page - b.page)

  return { text, page: byPage[0].page, byPage, anchor }
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}
