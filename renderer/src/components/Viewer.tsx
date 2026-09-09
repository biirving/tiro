import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Highlight } from '@shared/types'
import { pickSelection, type PickedSelection } from '@/lib/selection'
import type { Layout } from '@/lib/layout'
import { PageView } from './PageView'

/** Pages painted on either side of the ones on screen, so scrolling stays ahead. */
const OVERSCAN = 1

export interface JumpRequest {
  page: number
  /** Bumped on every jump so a repeat jump to the same page still fires. */
  seq: number
  /** 0..1 position within the page, for landing on a mark rather than its top. */
  offset?: number
}

interface ViewerProps {
  pdf: PDFDocumentProxy
  layout: Layout
  scale: number
  highlightsByPage: Map<number, Highlight[]>
  flashId: string | null
  jump: JumpRequest | null
  /** Scroll state lives in App so the margin ribbon and the viewer agree on it. */
  scrollTop: number
  viewport: number
  onPageChange: (page: number) => void
  onScroll: (metrics: { scrollTop: number; viewport: number }) => void
  onSelect: (picked: PickedSelection | null) => void
}

export function Viewer({
  pdf,
  layout,
  scale,
  highlightsByPage,
  flashId,
  jump,
  scrollTop,
  viewport,
  onPageChange,
  onScroll,
  onSelect,
}: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const frame = useRef<number | null>(null)

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollTop, clientHeight } = el
    onScroll({ scrollTop, viewport: clientHeight })

    // The page under the upper third of the viewport is the one being read.
    const probe = scrollTop + clientHeight * 0.32
    let page = 1
    for (let i = 0; i < layout.offsets.length; i++) {
      if (layout.offsets[i] <= probe) page = i + 1
      else break
    }
    onPageChange(page)
  }, [layout, onPageChange, onScroll])

  const handleScroll = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      measure()
    })
  }, [measure])

  // Re-measure when the layout changes under us (zoom, window resize, new file).
  useEffect(() => {
    measure()
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  useEffect(() => {
    if (!jump) return
    const el = scrollRef.current
    const top = layout.offsets[jump.page - 1]
    if (!el || top === undefined) return

    const within = (jump.offset ?? 0) * layout.heights[jump.page - 1]
    // Land a little above the target so it isn't pinned to the top edge.
    el.scrollTo({ top: Math.max(0, top + within - 72), behavior: 'smooth' })
  }, [jump, layout])

  const handleMouseUp = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    onSelect(pickSelection(root))
  }, [onSelect])

  const handleMouseDown = useCallback(() => {
    onSelect(null)
  }, [onSelect])

  // Which pages to paint, derived from scroll state rather than read off the DOM.
  const { first, last } = useMemo(() => {
    const bottom = scrollTop + Math.max(viewport, 1)
    let firstVisible = layout.offsets.length
    let lastVisible = 1

    for (let i = 0; i < layout.offsets.length; i++) {
      const pageTop = layout.offsets[i]
      const pageBottom = pageTop + layout.heights[i]
      if (pageBottom >= scrollTop && pageTop <= bottom) {
        firstVisible = Math.min(firstVisible, i + 1)
        lastVisible = Math.max(lastVisible, i + 1)
      }
    }
    if (firstVisible > lastVisible) return { first: 1, last: Math.min(1, layout.offsets.length) }

    return {
      first: Math.max(1, firstVisible - OVERSCAN),
      last: Math.min(layout.offsets.length, lastVisible + OVERSCAN),
    }
  }, [layout, scrollTop, viewport])

  return (
    <div
      ref={scrollRef}
      className="viewer"
      onScroll={handleScroll}
      onMouseUp={handleMouseUp}
      onMouseDown={handleMouseDown}
    >
      <div className="viewer-pages" style={{ height: `${layout.total}px` }}>
        {layout.heights.map((height, i) => {
          const pageNumber = i + 1
          return (
            <div
              key={pageNumber}
              className="page-slot"
              style={{ top: `${layout.offsets[i]}px`, height: `${height}px` }}
            >
              <PageView
                pdf={pdf}
                pageNumber={pageNumber}
                width={layout.widths[i]}
                height={height}
                scale={scale}
                active={pageNumber >= first && pageNumber <= last}
                highlights={highlightsByPage.get(pageNumber) ?? []}
                flashId={flashId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
