import { useMemo, useState } from 'react'
import type { Concept, ConceptKind } from '@shared/types'
import { conceptsForPage } from '@/lib/text'
import { Prose, RichText, type CodeRefHandler } from './Prose'

export interface DeeperState {
  text: string
  streaming: boolean
  error?: string
}

export type ConceptsStatus = 'idle' | 'running' | 'ready' | 'error'

interface ConceptsTabProps {
  status: ConceptsStatus
  error: string | null
  concepts: Concept[]
  currentPage: number
  numPages: number
  deeper: Record<string, DeeperState>
  /** Non-null when a provider still needs setting up. */
  setupMessage: string | null
  onExtract: () => void
  onJump: (page: number) => void
  onDeeper: (concept: Concept) => void
  onOpenCode?: CodeRefHandler
  onSettings: () => void
}

const KIND_ORDER: ConceptKind[] = ['term', 'method', 'claim', 'notation', 'entity']

const KIND_LABEL: Record<ConceptKind, string> = {
  term: 'term',
  method: 'method',
  claim: 'claim',
  notation: 'notation',
  entity: 'entity',
}

export function ConceptsTab({
  status,
  error,
  concepts,
  currentPage,
  numPages,
  deeper,
  setupMessage,
  onExtract,
  onJump,
  onDeeper,
  onOpenCode,
  onSettings,
}: ConceptsTabProps) {
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<ConceptKind[]>([])
  const [openId, setOpenId] = useState<string | null>(null)

  const slice = useMemo(() => conceptsForPage(concepts, currentPage), [concepts, currentPage])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return concepts.filter((concept) => {
      if (kinds.length && !kinds.includes(concept.kind)) return false
      if (!needle) return true
      return (
        concept.term.toLowerCase().includes(needle) ||
        concept.definition.toLowerCase().includes(needle)
      )
    })
  }, [concepts, kinds, query])

  const present = useMemo(
    () => KIND_ORDER.filter((kind) => concepts.some((concept) => concept.kind === kind)),
    [concepts],
  )

  // A map cached from an earlier session is exactly what this tab is for, so it
  // stays readable with no model configured. Only "Go deeper" needs one.
  if (setupMessage && concepts.length === 0) {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">Not set up yet</p>
        <p>Key concepts needs one read of the whole document, which means a model call.</p>
        <p>{setupMessage}</p>
        <button type="button" className="button-primary" onClick={onSettings}>
          Open Settings
        </button>
      </div>
    )
  }

  if (status === 'idle' && !setupMessage) {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">Read the document once</p>
        <p>
          Claude reads all {numPages} pages and pulls out the terms, methods, claims, and notation
          the argument rests on. After that, every definition is a click away instead of a scroll
          back.
        </p>
        <button type="button" className="button-primary" onClick={onExtract}>
          Find key concepts
        </button>
        <p className="panel-note">One pass. Cached afterwards, so reopening this file is free.</p>
      </div>
    )
  }

  if (status === 'running') {
    return (
      <div className="panel-empty">
        <div className="reading-bar" aria-hidden />
        <p className="panel-empty-title">Reading {numPages} pages</p>
        <p>Building the concept map. This takes a moment on a long document.</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">Could not read the document</p>
        <p className="panel-error">{error}</p>
        <button type="button" className="button-primary" onClick={onExtract}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="concepts">
      <section className="here">
        <header className="here-head">
          <span className="here-eyebrow">On page {currentPage}</span>
        </header>

        {slice.carried.length === 0 && slice.introduced.length === 0 ? (
          <p className="here-none">Nothing from the concept map appears on this page.</p>
        ) : null}

        {slice.carried.length > 0 && (
          <div className="here-group">
            <p className="here-group-label">Defined earlier</p>
            <ul className="here-list">
              {slice.carried.map((concept) => (
                <li key={concept.id} className="here-row">
                  <button
                    type="button"
                    className="here-item"
                    onClick={() => setOpenId(concept.id)}
                  >
                    <span className="here-term">
                      <RichText text={concept.term} onJump={onJump} />
                    </span>
                    <span className="here-def">
                      <RichText text={concept.definition} onJump={onJump} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="here-page"
                    onClick={() => onJump(concept.firstPage)}
                    title={`Go to p. ${concept.firstPage}, where it is established`}
                  >
                    p. {concept.firstPage}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {slice.introduced.length > 0 && (
          <div className="here-group">
            <p className="here-group-label">Introduced here</p>
            <ul className="here-list">
              {slice.introduced.map((concept) => (
                <li key={concept.id} className="here-row">
                  <button
                    type="button"
                    className="here-item is-new"
                    onClick={() => setOpenId(concept.id)}
                  >
                    <span className="here-term">
                      <RichText text={concept.term} onJump={onJump} />
                    </span>
                    <span className="here-def">
                      <RichText text={concept.definition} onJump={onJump} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="concepts-controls">
        <input
          className="search"
          value={query}
          placeholder={`Search ${concepts.length} concepts`}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="kind-filters">
          {present.map((kind) => {
            const on = kinds.includes(kind)
            return (
              <button
                key={kind}
                type="button"
                className={`kind-chip${on ? ' is-on' : ''}`}
                onClick={() =>
                  setKinds((current) =>
                    on ? current.filter((k) => k !== kind) : [...current, kind],
                  )
                }
              >
                {KIND_LABEL[kind]}
              </button>
            )
          })}
        </div>
      </div>

      <ul className="concept-list">
        {filtered.map((concept) => (
          <ConceptCard
            key={concept.id}
            concept={concept}
            open={openId === concept.id}
            deeper={deeper[concept.id]}
            deeperBlocked={setupMessage}
            onOpenCode={onOpenCode}
            onToggle={() => setOpenId((id) => (id === concept.id ? null : concept.id))}
            onJump={onJump}
            onDeeper={() => onDeeper(concept)}
          />
        ))}
        {filtered.length === 0 && <li className="concept-none">No concept matches that.</li>}
      </ul>
    </div>
  )
}

interface ConceptCardProps {
  concept: Concept
  open: boolean
  deeper: DeeperState | undefined
  /** Non-null when no model is configured, so going deeper is unavailable. */
  deeperBlocked: string | null
  onOpenCode?: CodeRefHandler
  onToggle: () => void
  onJump: (page: number) => void
  onDeeper: () => void
}

function ConceptCard({
  concept,
  open,
  deeper,
  deeperBlocked,
  onOpenCode,
  onToggle,
  onJump,
  onDeeper,
}: ConceptCardProps) {
  const others = concept.pages.filter((page) => page !== concept.firstPage)

  return (
    <li className={`concept${open ? ' is-open' : ''}`} id={`concept-${concept.id}`}>
      <button type="button" className="concept-head" onClick={onToggle} aria-expanded={open}>
        <span className={`concept-kind kind-${concept.kind}`}>{KIND_LABEL[concept.kind]}</span>
        <span className="concept-term">
          <RichText text={concept.term} onJump={onJump} />
        </span>
        <span className="concept-first">p. {concept.firstPage}</span>
      </button>

      <p className="concept-def">
        <RichText text={concept.definition} onJump={onJump} />
      </p>

      {open && (
        <div className="concept-body">
          <p className="concept-why">
            <RichText text={concept.significance} onJump={onJump} />
          </p>

          <div className="concept-pages">
            <span className="concept-pages-label">Appears on</span>
            <button type="button" className="page-ref" onClick={() => onJump(concept.firstPage)}>
              p. {concept.firstPage}
            </button>
            {others.slice(0, 14).map((page) => (
              <button
                key={page}
                type="button"
                className="page-ref is-quiet"
                onClick={() => onJump(page)}
              >
                {page}
              </button>
            ))}
            {others.length > 14 && <span className="concept-pages-more">+{others.length - 14}</span>}
          </div>

          {deeper?.text ? (
            <div className="concept-deeper">
              <Prose text={deeper.text} onJump={onJump} onOpenCode={onOpenCode} />
              {deeper.streaming && <span className="caret" aria-hidden />}
            </div>
          ) : null}

          {deeper?.error ? <p className="panel-error">{deeper.error}</p> : null}

          {!deeper?.text && (
            <button
              type="button"
              className="button-ghost"
              onClick={onDeeper}
              disabled={deeper?.streaming || Boolean(deeperBlocked)}
              title={deeperBlocked ?? undefined}
            >
              {deeper?.streaming ? 'Thinking…' : 'Go deeper'}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
