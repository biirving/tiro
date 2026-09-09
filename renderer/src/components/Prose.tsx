import { Fragment, useMemo } from 'react'
import katex from 'katex'
import { parseBlocks, parseInline } from '@/lib/text'

interface TeXProps {
  tex: string
  display: boolean
}

/**
 * Renders one LaTeX fragment.
 *
 * `trust: false` keeps commands that emit markup or links (\href,
 * \includegraphics) inert — the TeX here is model output, not ours. Errors
 * render in place rather than throwing, so one bad formula never blanks an
 * answer.
 */
function TeX({ tex, display }: TeXProps) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      })
    } catch {
      return null
    }
  }, [tex, display])

  if (html === null) {
    return <code className="prose-code">{tex}</code>
  }
  return (
    <span
      className={display ? 'math-block' : 'math-inline'}
      // KaTeX output, with \href and friends disabled above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

interface RichTextProps {
  text: string
  onJump: (page: number) => void
}

/** One line of model output: math, page citations, and light emphasis. */
export function RichText({ text, onJump }: RichTextProps) {
  const runs = useMemo(() => parseInline(text), [text])

  return (
    <>
      {runs.map((run, i) => {
        switch (run.kind) {
          case 'strong':
            return <strong key={i}>{run.text}</strong>
          case 'em':
            return <em key={i}>{run.text}</em>
          case 'code':
            return (
              <code key={i} className="prose-code">
                {run.text}
              </code>
            )
          case 'math':
            return <TeX key={i} tex={run.tex} display={run.display} />
          case 'page':
            return (
              <button
                key={i}
                type="button"
                className="page-ref"
                onClick={() => onJump(run.page)}
                title={`Go to page ${run.page}`}
              >
                {run.label}
              </button>
            )
          case 'text':
            return <Fragment key={i}>{run.text}</Fragment>
        }
      })}
    </>
  )
}

interface ProseProps {
  text: string
  onJump: (page: number) => void
}

/** A whole answer: paragraphs, the occasional list, display equations. */
export function Prose({ text, onJump }: ProseProps) {
  const blocks = useMemo(() => parseBlocks(text), [text])

  return (
    <div className="prose">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <h4 key={i}>
                <RichText text={block.text} onJump={onJump} />
              </h4>
            )
          case 'math':
            return (
              <div key={i} className="math-display">
                <TeX tex={block.tex} display />
              </div>
            )
          case 'bullets':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <RichText text={item} onJump={onJump} />
                  </li>
                ))}
              </ul>
            )
          case 'steps':
            return (
              <ol key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <RichText text={item} onJump={onJump} />
                  </li>
                ))}
              </ol>
            )
          case 'para':
            return (
              <p key={i}>
                <RichText text={block.lines.join(' ')} onJump={onJump} />
              </p>
            )
        }
      })}
    </div>
  )
}
