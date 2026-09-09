/**
 * Page geometry for the scroll column.
 *
 * Every page's height is known before it is painted, so the scrollbar is honest
 * from the first frame and the margin ribbon can place a mark exactly.
 */

export const PAGE_GAP = 26
export const PAGE_PAD = 34

export interface Layout {
  widths: number[]
  heights: number[]
  /** Distance from the top of the scroll content to the top of each page. */
  offsets: number[]
  total: number
}

export interface PageSize {
  width: number
  height: number
}

export function computeLayout(sizes: PageSize[], scale: number): Layout {
  const widths: number[] = []
  const heights: number[] = []
  const offsets: number[] = []

  let y = PAGE_PAD
  for (const size of sizes) {
    const height = Math.max(1, Math.floor(size.height * scale))
    widths.push(Math.max(1, Math.floor(size.width * scale)))
    heights.push(height)
    offsets.push(y)
    y += height + PAGE_GAP
  }

  return { widths, heights, offsets, total: Math.max(1, y - PAGE_GAP + PAGE_PAD) }
}

/** Where a page (optionally an offset inside it) sits as a 0..1 fraction of the whole document. */
export function documentPosition(layout: Layout, page: number, within = 0): number {
  const index = Math.min(Math.max(page - 1, 0), layout.offsets.length - 1)
  const top = layout.offsets[index] + within * layout.heights[index]
  return Math.min(1, Math.max(0, top / layout.total))
}

/** Inverse of `documentPosition`: which page a 0..1 scroll fraction lands on. */
export function pageAtPosition(layout: Layout, fraction: number): { page: number; offset: number } {
  const target = Math.min(Math.max(fraction, 0), 1) * layout.total
  for (let i = layout.offsets.length - 1; i >= 0; i--) {
    if (target >= layout.offsets[i]) {
      return { page: i + 1, offset: Math.min(1, (target - layout.offsets[i]) / layout.heights[i]) }
    }
  }
  return { page: 1, offset: 0 }
}
