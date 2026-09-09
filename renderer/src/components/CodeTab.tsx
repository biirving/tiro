import { useMemo, useState } from 'react'
import type { CodeLocation, Concept, ConceptCode, RepoLink } from '@shared/types'

export type CodeStatus = 'idle' | 'running' | 'ready' | 'error'

interface CodeTabProps {
  repo: RepoLink | null
  concepts: Concept[]
  matches: ConceptCode[]
  status: CodeStatus
  error: string | null
  setupMessage: string | null
  onLink: () => void
  onUnlink: () => void
  onMatch: () => void
  /** Opens the file full width, above the app. */
  onExpand: (location: CodeLocation) => Promise<void>
  onSettings: () => void
}

export function CodeTab({
  repo,
  concepts,
  matches,
  status,
  error,
  setupMessage,
  onLink,
  onUnlink,
  onMatch,
  onExpand,
  onSettings,
}: CodeTabProps) {
  const byConcept = useMemo(() => {
    const map = new Map<string, CodeLocation[]>()
    for (const match of matches) map.set(match.conceptId, match.locations)
    return map
  }, [matches])

  const matched = useMemo(
    () => concepts.filter((concept) => (byConcept.get(concept.id)?.length ?? 0) > 0),
    [concepts, byConcept],
  )

  if (!repo) {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">Link the repository</p>
        <p>
          Point Tiro at the code for this paper and it will find where each concept is actually
          implemented — with the file and line, not a guess.
        </p>
        <button type="button" className="button-primary" onClick={onLink}>
          Choose a folder
        </button>
        <p className="panel-note">
          The repository is searched on your machine. Only a shortlist of candidate snippets is
          ever sent to a model.
        </p>
      </div>
    )
  }

  return (
    <div className="code">
      <header className="repo-head">
        <div className="repo-id">
          <span className="repo-name">{repo.name}</span>
          <span className="repo-meta">
            {repo.fileCount.toLocaleString()} source file{repo.fileCount === 1 ? '' : 's'}
          </span>
        </div>
        <button type="button" className="repo-unlink" onClick={onUnlink} title="Unlink">
          ×
        </button>
      </header>

      {status === 'running' && (
        <div className="panel-empty">
          <div className="reading-bar" aria-hidden />
          <p className="panel-empty-title">Reading {repo.name}</p>
          <p>Searching for the code behind {concepts.length} concepts.</p>
        </div>
      )}

      {status === 'error' && (
        <div className="panel-empty">
          <p className="panel-empty-title">Could not match the code</p>
          <p className="panel-error">{error}</p>
          <button type="button" className="button-primary" onClick={onMatch}>
            Try again
          </button>
        </div>
      )}

      {status === 'idle' && concepts.length === 0 && (
        <div className="panel-empty">
          <p className="panel-empty-title">Find key concepts first</p>
          <p>The code pass works from the concept map, so that has to exist before this can run.</p>
        </div>
      )}

      {status === 'idle' && concepts.length > 0 && setupMessage && (
        <div className="panel-empty">
          <p className="panel-empty-title">Not set up yet</p>
          <p>{setupMessage}</p>
          <button type="button" className="button-primary" onClick={onSettings}>
            Open Settings
          </button>
        </div>
      )}

      {status === 'idle' && concepts.length > 0 && !setupMessage && (
        <div className="panel-empty">
          <p className="panel-empty-title">Match concepts to code</p>
          <p>
            Tiro searches {repo.name} for each of the {concepts.length} concepts, then asks the
            model which of the candidates it found are the real implementations.
          </p>
          <button type="button" className="button-primary" onClick={onMatch}>
            Match {concepts.length} concepts
          </button>
          <p className="panel-note">
            One pass. The paper is already cached, so only the candidate code is new.
          </p>
        </div>
      )}

      {status === 'ready' && (
        <>
          {matched.length === 0 ? (
            <p className="code-none">
              Nothing in {repo.name} matched these concepts. That is a real answer as often as not —
              a paper's claims and notation usually have no code behind them.
            </p>
          ) : (
            <ul className="code-list">
              {matched.map((concept) => (
                <ConceptCodeRow
                  key={concept.id}
                  concept={concept}
                  locations={byConcept.get(concept.id) ?? []}
                  onExpand={onExpand}
                />
              ))}
            </ul>
          )}
          <div className="code-rerun">
            <button type="button" className="button-ghost" onClick={onMatch}>
              Match again
            </button>
          </div>
        </>
      )}
    </div>
  )
}

interface ConceptCodeRowProps {
  concept: Concept
  locations: CodeLocation[]
  onExpand: (location: CodeLocation) => Promise<void>
}

function ConceptCodeRow({ concept, locations, onExpand }: ConceptCodeRowProps) {
  return (
    <li className="code-concept">
      <p className="code-concept-term">{concept.term}</p>
      {locations.map((location, i) => (
        <LocationCard
          key={`${location.path}-${location.startLine}-${i}`}
          location={location}
          onExpand={onExpand}
        />
      ))}
    </li>
  )
}

interface LocationCardProps {
  location: CodeLocation
  onExpand: (location: CodeLocation) => Promise<void>
}

function LocationCard({ location, onExpand }: LocationCardProps) {
  const [opening, setOpening] = useState(false)

  const open = async (): Promise<void> => {
    setOpening(true)
    await onExpand(location)
    setOpening(false)
  }

  return (
    <div className="code-loc">
      <div className="code-loc-head">
        <span className="code-path" title={location.path}>
          {location.path}
        </span>
        <span className="code-lines">
          {location.startLine}–{location.endLine}
        </span>
      </div>
      {location.symbol && <span className="code-symbol">{location.symbol}</span>}
      <p className="code-reason">{location.reason}</p>

      <pre className="code-snippet">
        <code>{location.snippet}</code>
      </pre>

      <button type="button" className="button-ghost" onClick={() => void open()} disabled={opening}>
        {opening ? 'Opening…' : 'Open whole file'}
      </button>
    </div>
  )
}
