import { useState } from 'react'
import type { RecentDoc } from '@/lib/store'

interface WelcomeProps {
  recents: RecentDoc[]
  setupMessage: string | null
  busy: string | null
  error: string | null
  onOpen: () => void
  onOpenPath: (path: string) => void
  onForget: (path: string) => void
  onSettings: () => void
}

export function Welcome({
  recents,
  setupMessage,
  busy,
  error,
  onOpen,
  onOpenPath,
  onForget,
  onSettings,
}: WelcomeProps) {
  const [over, setOver] = useState(false)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <p className="welcome-mark">Tiro</p>
        <h2 className="welcome-head">
          Read the paper.
          <br />
          Stop scrolling back.
        </h2>
        <p className="welcome-sub">
          Open a PDF. Claude reads all of it once, then every term it defines stays one click away
          while you read — no hunting for the definition you skimmed forty pages ago.
        </p>

        <div
          className={`drop${over ? ' is-over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            const file = event.dataTransfer.files[0]
            const path = file ? window.tiro.pathForFile(file) : ''
            if (path) onOpenPath(path)
            else onOpen()
          }}
        >
          {busy ? (
            <>
              <div className="reading-bar" aria-hidden />
              <p className="drop-busy">{busy}</p>
            </>
          ) : (
            <>
              <p className="drop-title">Drop a PDF here</p>
              <button type="button" className="button-primary" onClick={onOpen}>
                Choose a file
              </button>
              <p className="panel-note">⌘O works too</p>
            </>
          )}
        </div>

        {error && <p className="panel-error welcome-error">{error}</p>}

        {setupMessage && (
          <div className="welcome-key">
            <span>Key concepts and Ask need a model. {setupMessage}</span>
            <button type="button" className="button-ghost" onClick={onSettings}>
              Settings
            </button>
          </div>
        )}

        {recents.length > 0 && (
          <section className="recents">
            <p className="rail-label">Recent</p>
            <ul>
              {recents.map((doc) => (
                <li key={doc.path}>
                  <button type="button" className="recent" onClick={() => onOpenPath(doc.path)}>
                    <span className="recent-title">{doc.title}</span>
                    <span className="recent-meta">{doc.pages} pages</span>
                  </button>
                  <button
                    type="button"
                    className="recent-forget"
                    onClick={() => onForget(doc.path)}
                    title="Remove from this list"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
