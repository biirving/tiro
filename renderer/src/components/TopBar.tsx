import { useEffect, useState } from 'react'

interface TopBarProps {
  title: string
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
  needsSetup: boolean
}

export function TopBar({
  title,
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
        <h1 className="topbar-title" title={title}>
          {title}
        </h1>
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
          className={`icon-button${needsSetup ? ' needs-attention' : ''}`}
          onClick={onSettings}
          title={needsSetup ? 'Pick a model' : 'Settings'}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
            <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
            <path
              d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
            />
          </svg>
        </button>
      </div>
    </header>
  )
}
