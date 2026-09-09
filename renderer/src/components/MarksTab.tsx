import { useMemo } from 'react'
import type { Highlight } from '@shared/types'

interface MarksTabProps {
  marks: Highlight[]
  onJump: (page: number, within?: number, flash?: string) => void
  onRemove: (id: string) => void
  onAsk: (mark: Highlight) => void
}

export function MarksTab({ marks, onJump, onRemove, onAsk }: MarksTabProps) {
  const byPage = useMemo(() => {
    const groups = new Map<number, Highlight[]>()
    for (const mark of [...marks].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)) {
      const list = groups.get(mark.page) ?? []
      list.push(mark)
      groups.set(mark.page, list)
    }
    return [...groups.entries()]
  }, [marks])

  if (marks.length === 0) {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">Nothing marked yet</p>
        <p>Select a passage and hit Highlight. Marks show up here and as ticks in the margin.</p>
      </div>
    )
  }

  return (
    <div className="marks">
      {byPage.map(([page, group]) => (
        <section key={page} className="marks-group">
          <button type="button" className="marks-page" onClick={() => onJump(page)}>
            Page {page}
          </button>
          <ul>
            {group.map((mark) => (
              <li key={mark.id} className="mark-row">
                <button
                  type="button"
                  className="mark-text"
                  onClick={() => onJump(mark.page, mark.rects[0]?.y ?? 0, mark.id)}
                >
                  {mark.text}
                </button>
                <div className="mark-actions">
                  <button type="button" className="button-ghost" onClick={() => onAsk(mark)}>
                    Ask
                  </button>
                  <button
                    type="button"
                    className="button-ghost is-danger"
                    onClick={() => onRemove(mark.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
