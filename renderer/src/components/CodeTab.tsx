import { useEffect, useMemo, useRef, useState } from 'react'
import type { CodeFile, CodeLocation, Concept, ConceptCode, RepoLink } from '@shared/types'

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
  onRead: (path: string) => Promise<CodeFile | null>
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
  onRead,
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
                  onRead={onRead}
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
  onRead: (path: string) => Promise<CodeFile | null>
}

function ConceptCodeRow({ concept, locations, onRead }: ConceptCodeRowProps) {
  return (
    <li className="code-concept">
      <p className="code-concept-term">{concept.term}</p>
      {locations.map((location, i) => (
        <LocationCard key={`${location.path}-${location.startLine}-${i}`} location={location} onRead={onRead} />
      ))}
    </li>
  )
}

interface LocationCardProps {
  location: CodeLocation
  onRead: (path: string) => Promise<CodeFile | null>
}

function LocationCard({ location, onRead }: LocationCardProps) {
  const [file, setFile] = useState<CodeFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const expand = async (): Promise<void> => {
    if (file) {
      setFile(null)
      return
    }
    setLoading(true)
    setFailed(null)
    const read = await onRead(location.path)
    setLoading(false)
    if (read) setFile(read)
    else setFailed('That file could not be read.')
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

      {file ? (
        <FileView file={file} from={location.startLine} to={location.endLine} />
      ) : (
        <pre className="code-snippet">
          <code>{location.snippet}</code>
        </pre>
      )}

      {failed && <p className="panel-error">{failed}</p>}

      <button type="button" className="button-ghost" onClick={() => void expand()} disabled={loading}>
        {loading ? 'Opening…' : file ? 'Collapse to snippet' : 'Open whole file'}
      </button>
    </div>
  )
}

interface FileViewProps {
  file: CodeFile
  from: number
  to: number
}

/** The whole file, with the matched range marked and scrolled into view. */
function FileView({ file, from, to }: FileViewProps) {
  const lines = useMemo(() => file.content.split('\n'), [file.content])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const markRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const box = boxRef.current
    const mark = markRef.current
    if (!box || !mark) return
    // Put the match a little below the top rather than flush against it.
    box.scrollTop = Math.max(0, mark.offsetTop - box.clientHeight / 3)
  }, [file.path, from])

  return (
    <div className="code-file" ref={boxRef}>
      {lines.map((line, i) => {
        const number = i + 1
        const inRange = number >= from && number <= to
        return (
          <div
            key={number}
            ref={number === from ? markRef : undefined}
            className={`code-line${inRange ? ' is-match' : ''}`}
          >
            <span className="code-ln">{number}</span>
            <span className="code-src">{line || ' '}</span>
          </div>
        )
      })}
      {file.truncated && <p className="code-truncated">File truncated at {lines.length} lines.</p>}
    </div>
  )
}
