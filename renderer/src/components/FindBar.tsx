import { useEffect, useMemo, useRef, useState } from 'react'

interface FindBarProps {
  pageTexts: string[]
  onJump: (page: number) => void
  onClose: () => void
}

interface Match {
  page: number
  snippet: string
  count: number
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Search across the whole document at once and jump straight to a page.
 * Results are drawn from the text pdf.js already extracted, so it costs nothing.
 */
export function FindBar({ pageTexts, onJump, onClose }: FindBarProps) {
  const [term, setTerm] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const matches = useMemo<Match[]>(() => {
    const needle = term.trim()
    if (needle.length < 2) return []
    const pattern = new RegExp(escape(needle), 'gi')

    const found: Match[] = []
    pageTexts.forEach((text, i) => {
      const hits = [...text.matchAll(pattern)]
      if (!hits.length) return
      const at = hits[0].index
      const start = Math.max(0, at - 60)
      found.push({
        page: i + 1,
        count: hits.length,
        snippet:
          (start > 0 ? '…' : '') +
          text.slice(start, at + needle.length + 90).replace(/\s+/g, ' ').trim() +
          '…',
      })
    })
    return found
  }, [term, pageTexts])

  const total = matches.reduce((sum, match) => sum + match.count, 0)

  return (
    <div className="findbar">
      <div className="findbar-row">
        <input
          ref={inputRef}
          className="findbar-input"
          value={term}
          placeholder="Find in document"
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter' && matches[0]) onJump(matches[0].page)
          }}
        />
        <span className="findbar-count">
          {term.trim().length < 2
            ? ''
            : total === 0
              ? 'no matches'
              : `${total} on ${matches.length} page${matches.length === 1 ? '' : 's'}`}
        </span>
        <button type="button" className="findbar-close" onClick={onClose} title="Close (esc)">
          ×
        </button>
      </div>

      {matches.length > 0 && (
        <ul className="findbar-results">
          {matches.slice(0, 40).map((match) => (
            <li key={match.page}>
              <button type="button" onClick={() => onJump(match.page)}>
                <span className="findbar-page">p. {match.page}</span>
                <span className="findbar-snippet">{match.snippet}</span>
                {match.count > 1 && <span className="findbar-hits">×{match.count}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
