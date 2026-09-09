import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatTurn } from '@shared/types'
import { truncate } from '@/lib/text'
import { Prose } from './Prose'

interface AskTabProps {
  chat: ChatTurn[]
  selection: { text: string; page: number } | null
  /** Set when a repository is linked, so the composer can say it is searchable. */
  repoName: string | null
  setupMessage: string | null
  streaming: boolean
  onSend: (question: string) => void
  onStop: () => void
  onClearSelection: () => void
  onJump: (page: number) => void
  onSettings: () => void
  onClear: () => void
}

/** A question and the answer to it, kept together so neither reads alone. */
interface Exchange {
  key: string
  question?: ChatTurn
  answer?: ChatTurn
}

function toExchanges(chat: ChatTurn[]): Exchange[] {
  const out: Exchange[] = []
  for (const turn of chat) {
    const last = out[out.length - 1]
    if (turn.role === 'user') out.push({ key: turn.id, question: turn })
    else if (last && !last.answer) last.answer = turn
    else out.push({ key: turn.id, answer: turn })
  }
  return out
}

/** What a turn says it asked for, when it asked for something specific. */
const ACTION_LABEL: Record<string, string> = {
  define: 'Define',
  explain: 'Explain',
}

function searchText(exchange: Exchange): string {
  return [
    exchange.question?.content,
    exchange.question?.quote?.text,
    exchange.answer?.content,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const OPENERS = [
  'What is this paper claiming?',
  'What should I already know to read this?',
  'Where does the argument actually get made?',
]

export function AskTab({
  chat,
  selection,
  repoName,
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
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const exchanges = useMemo(() => toExchanges(chat), [chat])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () => (needle ? exchanges.filter((entry) => searchText(entry).includes(needle)) : exchanges),
    [exchanges, needle],
  )

  // Follow the answer as it streams — but not while searching, or the list
  // would yank away from whatever was just found.
  useEffect(() => {
    if (needle) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat, needle])

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
          <>
            {exchanges.length > 1 && (
              <div className="ask-search">
                <input
                  className="search"
                  value={query}
                  placeholder={`Search ${exchanges.length} exchanges`}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {needle && (
                  <span className="ask-search-count">
                    {shown.length} of {exchanges.length}
                  </span>
                )}
              </div>
            )}

            <ul className="turns">
              {shown.map((exchange) => (
                <li key={exchange.key} className="exchange">
                  {exchange.question && (
                    <div className="asked">
                      {exchange.question.mode && ACTION_LABEL[exchange.question.mode] ? (
                        <span className="asked-action">
                          {ACTION_LABEL[exchange.question.mode]}
                        </span>
                      ) : (
                        exchange.question.content && (
                          <p className="asked-question">{exchange.question.content}</p>
                        )
                      )}
                      {exchange.question.quote && (
                        <button
                          type="button"
                          className="turn-quote"
                          onClick={() => onJump(exchange.question!.quote!.page)}
                          title={`Go to p. ${exchange.question.quote.page}`}
                        >
                          <span className="turn-quote-page">
                            p. {exchange.question.quote.page}
                          </span>
                          {truncate(exchange.question.quote.text, 180)}
                        </button>
                      )}
                    </div>
                  )}

                  {exchange.answer && (
                    <div className="answered">
                      {exchange.answer.tools && exchange.answer.tools.length > 0 && (
                        <ul className="looked-up">
                          {exchange.answer.tools.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      )}
                      <Prose text={exchange.answer.content} onJump={onJump} />
                      {exchange.answer.streaming && !exchange.answer.content && (
                        <span className="thinking">Reading the document…</span>
                      )}
                      {exchange.answer.streaming && exchange.answer.content && (
                        <span className="caret" aria-hidden />
                      )}
                      {exchange.answer.error && (
                        <p className="panel-error">{exchange.answer.error}</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
              {shown.length === 0 && (
                <li className="ask-nomatch">Nothing in this conversation matches that.</li>
              )}
            </ul>
          </>
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
                  : repoName
                    ? `Ask about this document, or ${repoName}…`
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
