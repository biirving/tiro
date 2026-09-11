export interface IndexState {
  indexed: boolean
  /** Set while a pass is running. */
  progress: { done: number; total: number } | null
  error: string | null
}

interface IndexRowProps {
  /** What is being indexed, for the label: "this paper", "tiro". */
  label: string
  what: 'document' | 'code'
  state: IndexState
  onIndex: () => void
}

/**
 * The offer to index, and the state of having done so.
 *
 * Deliberately an offer: indexing costs time and embedding, so it happens when
 * asked for and not on a guess about document size. Rendered only where ferry
 * is installed and writable, so it never appears as a button that cannot work.
 */
export function IndexRow({ label, what, state, onIndex }: IndexRowProps) {
  if (state.progress) {
    const { done, total } = state.progress
    return (
      <div className="index-row">
        <div className="reading-bar" aria-hidden />
        <span className="index-note">
          Indexing {label} — {done.toLocaleString()} of {total.toLocaleString()} passages
        </span>
      </div>
    )
  }

  return (
    <div className="index-row">
      <span className="index-note">
        {state.indexed
          ? `${label} is indexed — long questions search it instead of carrying the whole thing.`
          : what === 'document'
            ? `Index ${label} to search it rather than send it whole.`
            : `Index ${label} to search the code by meaning, not just by name.`}
      </span>
      <button type="button" className="button-ghost" onClick={onIndex}>
        {state.indexed ? 'Re-index' : 'Index'}
      </button>
      {state.error && <p className="panel-error">{state.error}</p>}
    </div>
  )
}
