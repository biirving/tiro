import type { ReactNode } from 'react'

export type PanelTab = 'concepts' | 'ask' | 'marks'

interface PanelProps {
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  conceptCount: number
  markCount: number
  children: ReactNode
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'concepts', label: 'Key concepts' },
  { id: 'ask', label: 'Ask' },
  { id: 'marks', label: 'Marks' },
]

export function Panel({ tab, onTab, conceptCount, markCount, children }: PanelProps) {
  const count = (id: PanelTab): number | null =>
    id === 'concepts' ? conceptCount || null : id === 'marks' ? markCount || null : null

  return (
    <aside className="panel">
      <nav className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab${tab === entry.id ? ' is-active' : ''}`}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
            {count(entry.id) !== null && <span className="tab-count">{count(entry.id)}</span>}
          </button>
        ))}
      </nav>
      <div className="panel-body">{children}</div>
    </aside>
  )
}
