import { useCallback, useMemo, useRef } from 'react'
import { documentPosition, pageAtPosition, type Layout } from '@/lib/layout'

export interface RibbonTick {
  id: string
  page: number
  /** 0..1 within the page. */
  within: number
  label: string
}

interface MarginRibbonProps {
  layout: Layout
  scrollTop: number
  viewport: number
  /** Your highlights. */
  marks: RibbonTick[]
  /** Where concepts are first established. */
  anchors: RibbonTick[]
  onJump: (page: number, within?: number, flash?: string) => void
}

/**
 * A map of the whole document down the edge of the page: every mark you made and
 * every place a concept is established, so nothing has to be scrolled for.
 */
export function MarginRibbon({
  layout,
  scrollTop,
  viewport,
  marks,
  anchors,
  onJump,
}: MarginRibbonProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)

  const placed = useMemo(
    () => ({
      marks: marks.map((tick) => ({
        ...tick,
        top: documentPosition(layout, tick.page, tick.within) * 100,
      })),
      anchors: anchors.map((tick) => ({
        ...tick,
        top: documentPosition(layout, tick.page, tick.within) * 100,
      })),
    }),
    [layout, marks, anchors],
  )

  const thumb = {
    top: `${Math.min(100, (scrollTop / layout.total) * 100)}%`,
    height: `${Math.max(1.5, Math.min(100, (viewport / layout.total) * 100))}%`,
  }

  const jumpToClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const track = trackRef.current
      if (!track) return
      const box = track.getBoundingClientRect()
      const fraction = (event.clientY - box.top) / box.height
      const { page, offset } = pageAtPosition(layout, fraction)
      onJump(page, offset)
    },
    [layout, onJump],
  )

  return (
    <div className="ribbon" aria-hidden={marks.length + anchors.length === 0}>
      <div ref={trackRef} className="ribbon-track" onClick={jumpToClick}>
        <span className="ribbon-thumb" style={thumb} />
        {placed.anchors.map((tick) => (
          <button
            key={`a-${tick.id}`}
            type="button"
            className="ribbon-tick ribbon-tick-concept"
            style={{ top: `${tick.top}%` }}
            title={`${tick.label} — p. ${tick.page}`}
            onClick={(event) => {
              event.stopPropagation()
              onJump(tick.page, tick.within)
            }}
          />
        ))}
        {placed.marks.map((tick) => (
          <button
            key={`m-${tick.id}`}
            type="button"
            className="ribbon-tick ribbon-tick-mark"
            style={{ top: `${tick.top}%` }}
            title={`${tick.label} — p. ${tick.page}`}
            onClick={(event) => {
              event.stopPropagation()
              onJump(tick.page, tick.within, tick.id)
            }}
          />
        ))}
      </div>
    </div>
  )
}
