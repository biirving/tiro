import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface Citation {
  /** The bibliography entry, as printed. */
  text: string
  /** Where it lives, for readers who want the page itself. */
  page: number
  anchor: { x: number; y: number }
}

interface CitationPopupProps {
  citation: Citation
  onGoToPage: (page: number) => void
  onClose: () => void
}

/**
 * The work a citation points at, without leaving the page you are reading.
 *
 * Jumping to the bibliography and back is the thing this exists to avoid, so
 * the entry comes to you — copyable, for pasting into a search.
 */
export function CitationPopup({ citation, onGoToPage, onClose }: CitationPopupProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState({ left: citation.anchor.x, top: citation.anchor.y })
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 12
    const left = Math.min(
      Math.max(citation.anchor.x - width / 2, margin),
      window.innerWidth - width - margin,
    )
    const below = citation.anchor.y + 12
    const top =
      below + height > window.innerHeight - margin ? citation.anchor.y - height - 16 : below
    setPlace({ left, top })
  }, [citation])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    // Deferred, or the click that opened this would immediately close it.
    const timer = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onDown)
      window.clearTimeout(timer)
    }
  }, [onClose])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(citation.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div ref={ref} className="citation" style={{ left: place.left, top: place.top }}>
      {citation.text ? (
        <p className="citation-text">{citation.text}</p>
      ) : (
        <p className="citation-text is-empty">
          Could not read that entry. The reference is on page {citation.page}.
        </p>
      )}
      <div className="citation-actions">
        <button type="button" className="chip chip-ai" onClick={() => onGoToPage(citation.page)}>
          Go to p. {citation.page}
        </button>
        {citation.text && (
          <button type="button" className="chip chip-ai" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  )
}
