import { useMemo } from 'react'
import type { OutlineEntry } from '@/lib/pdf'

interface OutlineRailProps {
  outline: OutlineEntry[]
  numPages: number
  currentPage: number
  onJump: (page: number) => void
}

/** The document's own table of contents, or a page grid when it has none. */
export function OutlineRail({ outline, numPages, currentPage, onJump }: OutlineRailProps) {
  const activeIndex = useMemo(() => {
    let index = -1
    outline.forEach((entry, i) => {
      if (entry.page <= currentPage) index = i
    })
    return index
  }, [outline, currentPage])

  if (outline.length > 0) {
    return (
      <nav className="rail" aria-label="Document outline">
        <p className="rail-label">Contents</p>
        <ul className="rail-list">
          {outline.map((entry, i) => (
            <li key={`${entry.page}-${i}`}>
              <button
                type="button"
                className={`rail-item depth-${Math.min(entry.depth, 3)}${
                  i === activeIndex ? ' is-active' : ''
                }`}
                onClick={() => onJump(entry.page)}
              >
                <span className="rail-item-title">{entry.title}</span>
                <span className="rail-item-page">{entry.page}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    )
  }

  return (
    <nav className="rail" aria-label="Pages">
      <p className="rail-label">Pages</p>
      <div className="rail-grid">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
          <button
            key={page}
            type="button"
            className={`rail-page${page === currentPage ? ' is-active' : ''}`}
            onClick={() => onJump(page)}
          >
            {page}
          </button>
        ))}
      </div>
    </nav>
  )
}
