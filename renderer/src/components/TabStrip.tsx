import type { DocTab } from '@/lib/tabs'
import { isStreaming } from '@/lib/tabs'

interface TabStripProps {
  tabs: DocTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

/**
 * The open papers. A tab still receiving an answer shows a live dot, so work
 * you started somewhere else stays visible while you read on.
 */
export function TabStrip({ tabs, activeId, onSelect, onClose, onNew }: TabStripProps) {
  return (
    <div className="tabstrip" role="tablist" aria-label="Open documents">
      <div className="tabstrip-scroll">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              className={`doctab${active ? ' is-active' : ''}`}
              role="tab"
              aria-selected={active}
            >
              <button
                type="button"
                className="doctab-label"
                onClick={() => onSelect(tab.id)}
                title={`${tab.title}\n${tab.id}`}
              >
                {isStreaming(tab) && <span className="doctab-live" aria-label="answer arriving" />}
                <span className="doctab-title">{tab.title}</span>
                {index < 9 && <span className="doctab-index">⌘{index + 1}</span>}
              </button>
              <button
                type="button"
                className="doctab-close"
                onClick={() => onClose(tab.id)}
                title="Close tab"
                aria-label={`Close ${tab.title}`}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="tabstrip-new" onClick={onNew} title="Open another PDF (⌘T)">
        +
      </button>
    </div>
  )
}
