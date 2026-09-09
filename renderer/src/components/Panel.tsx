import type { ReactNode } from 'react'

export type PanelTab = 'concepts' | 'ask' | 'marks' | 'code'

interface PanelProps {
  width: number
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  conceptCount: number
  markCount: number
  codeCount: number
  children: ReactNode
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'concepts', label: 'Key concepts' },
  { id: 'ask', label: 'Ask' },
  { id: 'marks', label: 'Marks' },
  { id: 'code', label: 'Code' },
]

export function Panel({
  width,
  tab,
  onTab,
  conceptCount,
  markCount,
  codeCount,
  children,
}: PanelProps) {
  const count = (id: PanelTab): number | null => {
    if (id === 'concepts') return conceptCount || null
    if (id === 'marks') return markCount || null
    if (id === 'code') return codeCount || null
    return null
  }

  return (
    <aside className="panel" style={{ width: `${width}px` }}>
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
