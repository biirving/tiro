import type { CSSProperties, ReactNode } from 'react'

export const MIN_PANEL_SCALE = 0.8
export const MAX_PANEL_SCALE = 2
export const DEFAULT_PANEL_SCALE = 1

export function clampPanelScale(scale: number): number {
  return Math.min(MAX_PANEL_SCALE, Math.max(MIN_PANEL_SCALE, Number(scale.toFixed(2))))
}

export type PanelTab = 'concepts' | 'ask' | 'marks' | 'code'

interface PanelProps {
  width: number
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  conceptCount: number
  markCount: number
  codeCount: number
  /** Text size for the panel's content, 1 being the default. */
  scale: number
  /**
   * Nudges the size by a step. A delta rather than a value, so a fast
   * double-click advances twice instead of computing twice from the same
   * render's `scale`.
   */
  onScaleBy: (delta: number) => void
  onScaleReset: () => void
  children: ReactNode
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'concepts', label: 'Key concepts' },
  { id: 'ask', label: 'Ask' },
  { id: 'marks', label: 'Marks' },
  { id: 'code', label: 'Code' },
]

export function Panel({
  width,
  tab,
  onTab,
  conceptCount,
  markCount,
  codeCount,
  scale,
  onScaleBy,
  onScaleReset,
  children,
}: PanelProps) {
  const count = (id: PanelTab): number | null => {
    if (id === 'concepts') return conceptCount || null
    if (id === 'marks') return markCount || null
    if (id === 'code') return codeCount || null
    return null
  }

  return (
    <aside className="panel" style={{ width: `${width}px` }}>
      <nav className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab${tab === entry.id ? ' is-active' : ''}`}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
            {count(entry.id) !== null && <span className="tab-count">{count(entry.id)}</span>}
          </button>
        ))}

        <div className="text-size" title="Text size in this panel">
          <button
            type="button"
            onClick={() => onScaleBy(-0.1)}
            disabled={scale <= MIN_PANEL_SCALE}
            aria-label="Smaller text"
          >
            −
          </button>
          <button
            type="button"
            className="text-size-reset"
            onClick={onScaleReset}
            aria-label={`Text size ${Math.round(scale * 100)} percent, click to reset`}
          >
            A
          </button>
          <button
            type="button"
            onClick={() => onScaleBy(0.1)}
            disabled={scale >= MAX_PANEL_SCALE}
            aria-label="Larger text"
          >
            +
          </button>
        </div>
      </nav>
      {/*
        `zoom` scales type, spacing, and rules together, and lays the content out
        against the reduced width — so the panel keeps the width you dragged it
        to and only its contents grow. Doing this with font sizes would mean
        converting every rule in the panel to em.
      */}
      <div className="panel-body" style={{ zoom: scale } as CSSProperties}>
        {children}
      </div>
    </aside>
  )
}
