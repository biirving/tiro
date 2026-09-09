import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

export const MIN_PANEL_WIDTH = 300
export const DEFAULT_PANEL_WIDTH = 396

/** Room the page column, rail, and ribbon need before the panel may grow further. */
const RESERVED_FOR_READING = 620

export function maxPanelWidth(viewportWidth: number = window.innerWidth): number {
  return Math.max(MIN_PANEL_WIDTH, viewportWidth - RESERVED_FOR_READING)
}

/**
 * Clamps for display only. The width the reader chose is stored unclamped, so a
 * briefly narrow window — which is what the very first render sees — cannot
 * quietly rewrite the preference to the minimum and keep it there.
 */
export function clampPanelWidth(
  width: number,
  viewportWidth: number = window.innerWidth,
): number {
  return Math.min(Math.max(Math.round(width), MIN_PANEL_WIDTH), maxPanelWidth(viewportWidth))
}

interface PanelResizerProps {
  width: number
  onResize: (width: number) => void
  onReset: () => void
}

/**
 * The grab edge between the page and the panel.
 *
 * Pointer capture keeps the drag alive when the cursor outruns the handle, and
 * the body-level class stops the drag from selecting text in the page behind it.
 */
export function PanelResizer({ width, onResize, onReset }: PanelResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const begin = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width }
    document.body.classList.add('is-resizing')
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const from = drag.current
    if (!from) return
    // Dragging left widens the panel, which is why this subtracts.
    onResize(clampPanelWidth(from.startWidth - (event.clientX - from.startX)))
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = null
    document.body.classList.remove('is-resizing')
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={maxPanelWidth()}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onResize(clampPanelWidth(width + 24))
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(clampPanelWidth(width - 24))
        }
      }}
    />
  )
}
