import { useEffect, useRef, useState } from 'react'
import type { ChatTurn } from '@shared/types'
import { truncate } from '@/lib/text'
import { Prose } from './Prose'

interface AskTabProps {
  chat: ChatTurn[]
  selection: { text: string; page: number } | null
  setupMessage: string | null
  streaming: boolean
  onSend: (question: string) => void
  onStop: () => void
  onClearSelection: () => void
  onJump: (page: number) => void
  onSettings: () => void
  onClear: () => void
}

const OPENERS = [
  'What is this paper claiming?',
  'What should I already know to read this?',
  'Where does the argument actually get made?',
]

export function AskTab({
  chat,
  selection,
  setupMessage,
  streaming,
  onSend,
  onStop,
  onClearSelection,
  onJump,
  onSettings,
  onClear,
}: AskTabProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Follow the answer as it streams, and after each new turn.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  useEffect(() => {
    if (selection) inputRef.current?.focus()
  }, [selection])

  const submit = (): void => {
    const question = draft.trim()
    if (!question || streaming || setupMessage) return
    onSend(question)
    setDraft('')
  }

  // Only take over the tab when there is nothing to read. A conversation from an
  // earlier session stays readable with no model configured.
  if (setupMessage && chat.length === 0) {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">Not set up yet</p>
        <p>Pick a model and you can ask about anything on the page.</p>
        <p>{setupMessage}</p>
        <button type="button" className="button-primary" onClick={onSettings}>
          Open Settings
        </button>
      </div>
    )
  }

  return (
    <div className="ask">
      <div ref={scrollRef} className="ask-scroll">
        {chat.length === 0 ? (
          <div className="ask-openers">
            <p className="panel-note">
              Select anything on the page and pick Define, Explain, or Ask. Or start here.
            </p>
            {OPENERS.map((opener) => (
              <button key={opener} type="button" className="opener" onClick={() => onSend(opener)}>
                {opener}
              </button>
            ))}
          </div>
        ) : (
          <ul className="turns">
            {chat.map((turn) => (
              <li key={turn.id} className={`turn turn-${turn.role}`}>
                {turn.quote && (
                  <button
                    type="button"
                    className="turn-quote"
                    onClick={() => onJump(turn.quote!.page)}
                    title={`Go to p. ${turn.quote.page}`}
                  >
                    <span className="turn-quote-page">p. {turn.quote.page}</span>
                    {truncate(turn.quote.text, 180)}
                  </button>
                )}
                {turn.role === 'user' ? (
                  turn.content && <p className="turn-question">{turn.content}</p>
                ) : (
                  <>
                    <Prose text={turn.content} onJump={onJump} />
                    {turn.streaming && !turn.content && (
                      <span className="thinking">Reading the document…</span>
                    )}
                    {turn.streaming && turn.content && <span className="caret" aria-hidden />}
                    {turn.error && <p className="panel-error">{turn.error}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="composer">
        {setupMessage && (
          <div className="composer-setup">
            <span>{setupMessage}</span>
            <button type="button" className="button-ghost" onClick={onSettings}>
              Settings
            </button>
          </div>
        )}
        {selection && (
          <div className="composer-quote">
            <span className="composer-quote-page">p. {selection.page}</span>
            <span className="composer-quote-text">{truncate(selection.text, 110)}</span>
            <button
              type="button"
              className="composer-quote-drop"
              onClick={onClearSelection}
              title="Drop the selection"
            >
              ×
            </button>
          </div>
        )}
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={2}
            value={draft}
            disabled={Boolean(setupMessage)}
            placeholder={
              setupMessage
                ? 'Pick a model to ask something new'
                : selection
                  ? 'Ask about the selection…'
                  : 'Ask about this document…'
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {streaming ? (
            <button type="button" className="button-primary" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="button-primary"
              onClick={submit}
              disabled={!draft.trim() || Boolean(setupMessage)}
            >
              Ask
            </button>
          )}
        </div>
        {chat.length > 0 && (
          <button type="button" className="composer-clear" onClick={onClear}>
            Clear conversation
          </button>
        )}
      </div>
    </div>
  )
}
