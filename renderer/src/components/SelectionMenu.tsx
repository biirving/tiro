import { useLayoutEffect, useRef, useState } from 'react'
import type { PickedSelection } from '@/lib/selection'
import { truncate } from '@/lib/text'

interface SelectionMenuProps {
  selection: PickedSelection
  onHighlight: () => void
  onDefine: () => void
  onExplain: () => void
  onAsk: () => void
}

/** The bar that appears under a selection. Amber action is yours; teal ones ask Claude. */
export function SelectionMenu({
  selection,
  onHighlight,
  onDefine,
  onExplain,
  onAsk,
}: SelectionMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState({ left: selection.anchor.x, top: selection.anchor.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 12

    const left = Math.min(
      Math.max(selection.anchor.x - width / 2, margin),
      window.innerWidth - width - margin,
    )
    const below = selection.anchor.y + 10
    const top = below + height > window.innerHeight - margin ? selection.anchor.y - height - 20 : below

    setPlacement({ left, top })
  }, [selection])

  return (
    <div ref={ref} className="selection-menu" style={{ left: placement.left, top: placement.top }}>
      <span className="selection-menu-quote" title={selection.text}>
        {truncate(selection.text, 46)}
      </span>
      <span className="selection-menu-rule" />
      <button type="button" className="chip chip-mark" onClick={onHighlight}>
        Highlight
      </button>
      <button type="button" className="chip chip-ai" onClick={onDefine}>
        Define
      </button>
      <button type="button" className="chip chip-ai" onClick={onExplain}>
        Explain
      </button>
      <button type="button" className="chip chip-ai" onClick={onAsk}>
        Ask…
      </button>
    </div>
  )
}
