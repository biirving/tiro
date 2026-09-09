import { useEffect, useState } from 'react'

interface TopBarProps {
  page: number
  numPages: number
  scale: number
  railOpen: boolean
  onToggleRail: () => void
  onJump: (page: number) => void
  onZoom: (delta: number) => void
  onZoomReset: () => void
  onOpen: () => void
  onSettings: () => void
  /** The active model, or "Model" when none is picked yet. */
  modelLabel: string
  modelTitle: string
  needsSetup: boolean
}

export function TopBar({
  page,
  numPages,
  scale,
  railOpen,
  onToggleRail,
  onJump,
  onZoom,
  onZoomReset,
  onOpen,
  onSettings,
  modelLabel,
  modelTitle,
  needsSetup,
}: TopBarProps) {
  const [draft, setDraft] = useState(String(page))

  useEffect(() => setDraft(String(page)), [page])

  const commit = (): void => {
    const next = Number(draft)
    if (Number.isFinite(next)) onJump(Math.min(Math.max(Math.round(next), 1), numPages))
    else setDraft(String(page))
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className={`icon-button${railOpen ? ' is-on' : ''}`}
          onClick={onToggleRail}
          title="Toggle contents"
          aria-pressed={railOpen}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
            <path d="M2 3.5h12M2 8h12M2 12.5h7" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </button>
      </div>

      <div className="topbar-center">
        <div className="pager">
          <button type="button" onClick={() => onJump(Math.max(1, page - 1))} title="Previous page">
            ↑
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit()
                event.currentTarget.blur()
              }
            }}
            aria-label="Page number"
          />
          <span className="pager-total">/ {numPages}</span>
          <button
            type="button"
            onClick={() => onJump(Math.min(numPages, page + 1))}
            title="Next page"
          >
            ↓
          </button>
        </div>

        <div className="zoomer">
          <button type="button" onClick={() => onZoom(-0.15)} title="Zoom out">
            −
          </button>
          <button type="button" className="zoomer-value" onClick={onZoomReset} title="Actual size">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" onClick={() => onZoom(0.15)} title="Zoom in">
            +
          </button>
        </div>
      </div>

      <div className="topbar-right">
        <button type="button" className="text-button" onClick={onOpen}>
          Open
        </button>
        <button
          type="button"
          className={`text-button model-button${needsSetup ? ' needs-attention' : ''}`}
          onClick={onSettings}
          title={modelTitle}
        >
          {modelLabel}
        </button>
      </div>
    </header>
  )
}
