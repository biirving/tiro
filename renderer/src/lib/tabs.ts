/**
 * One open document.
 *
 * Everything a paper carries with it lives here — its own zoom, scroll
 * position, concept map, marks and conversation — so switching papers restores
 * where you were rather than resetting it.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ChatTurn, Concept, Highlight } from '@shared/types'
import type { ConceptsStatus, DeeperState } from '@/components/ConceptsTab'
import type { PanelTab } from '@/components/Panel'
import type { PageSize } from './layout'
import type { OutlineEntry } from './pdf'

export interface DocTab {
  /** The file's path on disk, which is also its identity everywhere else. */
  id: string
  title: string
  pdf: PDFDocumentProxy
  /** Frees the pdf.js worker resources when the tab closes. */
  destroy: () => Promise<void>
  numPages: number
  sizes: PageSize[]
  pageTexts: string[]
  outline: OutlineEntry[]

  /** Kept per tab so two papers can sit at different zoom levels. */
  scale: number
  /** Written on the way out, restored on the way back in. */
  scrollTop: number

  concepts: Concept[]
  conceptsStatus: ConceptsStatus
  conceptsError: string | null
  deeper: Record<string, DeeperState>

  marks: Highlight[]
  chat: ChatTurn[]
  panelTab: PanelTab
  /** A passage carried into the composer, waiting on a question. */
  pinned: { text: string; page: number } | null
  /** Set when the main process has no text for this document. */
  docError: string | null
}

export type TabPatch = Partial<DocTab> | ((tab: DocTab) => Partial<DocTab>)

export function applyPatch(tab: DocTab, patch: TabPatch): DocTab {
  return { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) }
}

/** True while this tab has an answer still arriving. */
export function isStreaming(tab: DocTab): boolean {
  return (
    tab.chat.some((turn) => turn.streaming) ||
    Object.values(tab.deeper).some((state) => state.streaming)
  )
}

/** Which tab to show after closing `id`: the one to its right, else its left. */
export function neighbourOf(tabs: DocTab[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return null
  const remaining = tabs.filter((tab) => tab.id !== id)
  if (remaining.length === 0) return null
  return remaining[Math.min(index, remaining.length - 1)].id
}
