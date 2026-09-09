import { useEffect, useMemo, useRef } from 'react'
import type { CodeFile } from '@shared/types'

export interface CodeView {
  file: CodeFile
  /** 1-indexed range to mark, inclusive. */
  from: number
  to: number
  /** Shown under the path, when the match came from a concept. */
  note?: string
}

interface CodeModalProps {
  view: CodeView
  onClose: () => void
}

/**
 * A source file at full width, above everything.
 *
 * The panel is the wrong shape for reading code — this is the same content with
 * room to see an entire line and the shape of a function at once.
 */
export function CodeModal({ view, onClose }: CodeModalProps) {
  const { file, from, to, note } = view
  const lines = useMemo(() => file.content.split('\n'), [file.content])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const markRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const scrollToMatch = (): void => {
    const body = bodyRef.current
    const mark = markRef.current
    if (!body || !mark) return
    body.scrollTop = Math.max(0, mark.offsetTop - body.clientHeight / 3)
  }

  useEffect(scrollToMatch, [file.path, from])

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="code-modal"
        role="dialog"
        aria-modal="true"
        aria-label={file.path}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="code-modal-head">
          <div className="code-modal-id">
            <span className="code-modal-path">{file.path}</span>
            <span className="code-modal-meta">
              {lines.length.toLocaleString()} lines · showing {from}–{to}
              {file.truncated ? ' · truncated' : ''}
            </span>
          </div>
          {note && <p className="code-modal-note">{note}</p>}
          <button type="button" className="button-ghost" onClick={scrollToMatch}>
            Back to match
          </button>
          <button type="button" className="sheet-close" onClick={onClose} title="Close (esc)">
            ×
          </button>
        </header>

        <div className="code-modal-body" ref={bodyRef}>
          {lines.map((line, i) => {
            const number = i + 1
            const inRange = number >= from && number <= to
            return (
              <div
                key={number}
                ref={number === from ? markRef : undefined}
                className={`code-line${inRange ? ' is-match' : ''}`}
              >
                <span className="code-ln">{number}</span>
                <span className="code-src">{line || ' '}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
