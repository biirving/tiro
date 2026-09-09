import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Highlight } from '@shared/types'
import { readPageLinks, renderPage, type PageLink, type RenderedPage } from '@/lib/pdf'

interface PageViewProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  width: number
  height: number
  scale: number
  /** Pages outside the render window keep their box but stay unpainted. */
  active: boolean
  highlights: Highlight[]
  flashId: string | null
  onFollowLink: (link: PageLink, at: { x: number; y: number }) => void
}

function PageViewInner({
  pdf,
  pageNumber,
  width,
  height,
  scale,
  active,
  highlights,
  flashId,
  onFollowLink,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [painted, setPainted] = useState(false)
  const [links, setLinks] = useState<PageLink[]>([])

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const textLayer = textRef.current
    if (!canvas || !textLayer) return

    let cancelled = false
    let rendered: RenderedPage | null = null

    void (async () => {
      const page = await pdf.getPage(pageNumber)
      if (cancelled) return
      rendered = renderPage(page, scale, canvas, textLayer)
      await rendered.done
      if (!cancelled) setPainted(true)
    })()

    return () => {
      cancelled = true
      rendered?.cancel()
      setPainted(false)
    }
  }, [active, pdf, pageNumber, scale])

  // A paper's own citations are link annotations; without this layer they are
  // just blue text that does nothing.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void readPageLinks(pdf, pageNumber).then((found) => {
      if (!cancelled) setLinks(found)
    })
    return () => {
      cancelled = true
    }
  }, [active, pdf, pageNumber])

  const style = {
    width: `${width}px`,
    height: `${height}px`,
    '--total-scale-factor': scale,
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
  } as CSSProperties

  return (
    <div className="page" data-page={pageNumber} style={style}>
      {active ? (
        <>
          <canvas ref={canvasRef} className="page-canvas" />
          <div className="mark-layer" aria-hidden>
            {highlights.map((mark) =>
              mark.rects.map((rect, i) => (
                <span
                  key={`${mark.id}-${i}`}
                  className={`mark${flashId === mark.id ? ' mark-flash' : ''}`}
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.w * 100}%`,
                    height: `${rect.h * 100}%`,
                  }}
                />
              )),
            )}
          </div>
          <div ref={textRef} className="textLayer" />
          <div className="link-layer">
            {links.map((link, i) => (
              <button
                key={i}
                type="button"
                className="page-link"
                style={{
                  left: `${link.rect.x * 100}%`,
                  top: `${link.rect.y * 100}%`,
                  width: `${link.rect.w * 100}%`,
                  height: `${link.rect.h * 100}%`,
                }}
                title={link.url ?? 'Show this reference'}
                onClick={(event) =>
                  onFollowLink(link, { x: event.clientX, y: event.clientY })
                }
              />
            ))}
          </div>
          {!painted && <div className="page-loading" aria-hidden />}
        </>
      ) : (
        <div className="page-placeholder" aria-hidden>
          <span className="page-placeholder-num">{pageNumber}</span>
        </div>
      )}
      <span className="page-tag">{pageNumber}</span>
    </div>
  )
}

export const PageView = memo(PageViewInner)
