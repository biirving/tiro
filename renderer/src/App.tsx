import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type {
  AskRequest,
  AskMode,
  ChatTurn,
  Concept,
  Highlight,
  OpenedPdf,
  ProviderState,
} from '@shared/types'
import { runAsk, type RunningAsk } from './lib/ask'
import { computeLayout, type PageSize } from './lib/layout'
import {
  documentTitle,
  extractPageText,
  openDocument,
  pageSize,
  readOutline,
  type OutlineEntry,
} from './lib/pdf'
import { clearSelection, type PickedSelection } from './lib/selection'
import {
  forgetRecent,
  loadRecord,
  newId,
  recents,
  rememberRecent,
  saveRecord,
  type RecentDoc,
} from './lib/store'
import { truncate, widenConceptPages } from './lib/text'
import { AskTab } from './components/AskTab'
import { ConceptsTab, type ConceptsStatus, type DeeperState } from './components/ConceptsTab'
import { FindBar } from './components/FindBar'
import { MarginRibbon, type RibbonTick } from './components/MarginRibbon'
import { MarksTab } from './components/MarksTab'
import { OutlineRail } from './components/OutlineRail'
import { Panel, type PanelTab } from './components/Panel'
import { SelectionMenu } from './components/SelectionMenu'
import { Settings } from './components/Settings'
import { TopBar } from './components/TopBar'
import { Viewer, type JumpRequest } from './components/Viewer'
import { Welcome } from './components/Welcome'

interface Session {
  path: string
  title: string
  pdf: PDFDocumentProxy
  numPages: number
  sizes: PageSize[]
  pageTexts: string[]
  outline: OutlineEntry[]
}

const MIN_SCALE = 0.5
const MAX_SCALE = 3

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)

  const [providerState, setProviderState] = useState<ProviderState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [tab, setTab] = useState<PanelTab>('concepts')

  const [scale, setScale] = useState(1.1)
  const [page, setPage] = useState(1)
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewport: 0 })
  const [jump, setJump] = useState<JumpRequest | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)

  const [selection, setSelection] = useState<PickedSelection | null>(null)
  const [pinned, setPinned] = useState<{ text: string; page: number } | null>(null)

  const [concepts, setConcepts] = useState<Concept[]>([])
  const [conceptsStatus, setConceptsStatus] = useState<ConceptsStatus>('idle')
  const [conceptsError, setConceptsError] = useState<string | null>(null)
  const [deeper, setDeeper] = useState<Record<string, DeeperState>>({})

  const [marks, setMarks] = useState<Highlight[]>([])
  const [chat, setChat] = useState<ChatTurn[]>([])
  const [recentList, setRecentList] = useState<RecentDoc[]>(() => recents())

  const running = useRef<RunningAsk | null>(null)
  const jumpSeq = useRef(0)

  /** What still has to be set up before a question can be asked, if anything. */
  const setupMessage = useMemo(() => {
    if (!providerState) return null
    if (providerState.ready) return null
    if (providerState.local) return 'Pick a local model in Settings to turn this on.'
    if (!providerState.hasKey) return 'Add an API key in Settings to turn this on.'
    return 'Pick a model in Settings to turn this on.'
  }, [providerState])

  const layout = useMemo(
    () => computeLayout(session?.sizes ?? [], scale),
    [session?.sizes, scale],
  )

  const marksByPage = useMemo(() => {
    const groups = new Map<number, Highlight[]>()
    for (const mark of marks) {
      const list = groups.get(mark.page) ?? []
      list.push(mark)
      groups.set(mark.page, list)
    }
    return groups
  }, [marks])

  const ribbon = useMemo(() => {
    const markTicks: RibbonTick[] = marks.map((mark) => ({
      id: mark.id,
      page: mark.page,
      within: mark.rects[0]?.y ?? 0,
      label: truncate(mark.text, 70),
    }))
    const anchorTicks: RibbonTick[] = concepts.map((concept) => ({
      id: concept.id,
      page: concept.firstPage,
      within: 0.5,
      label: concept.term,
    }))
    return { markTicks, anchorTicks }
  }, [marks, concepts])

  useEffect(() => {
    void window.tiro.getProviderState().then(setProviderState)
  }, [])

  const refreshProvider = useCallback(async () => {
    setProviderState(await window.tiro.getProviderState())
  }, [])

  // Persist marks, concepts, and the conversation against this file.
  useEffect(() => {
    if (!session) return
    saveRecord(session.path, { title: session.title, concepts, highlights: marks, chat })
  }, [session, concepts, marks, chat])

  useEffect(() => {
    if (!flashId) return
    const timer = window.setTimeout(() => setFlashId(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flashId])

  const jumpTo = useCallback((target: number, within?: number, flash?: string) => {
    jumpSeq.current += 1
    setJump({ page: target, seq: jumpSeq.current, offset: within })
    if (flash) setFlashId(flash)
  }, [])

  const registerDoc = useCallback(async (doc: Session): Promise<string | null> => {
    const result = await window.tiro.registerDoc({
      docId: doc.path,
      title: doc.title,
      pages: doc.pageTexts,
    })
    return result.ok ? null : result.message
  }, [])

  const openFile = useCallback(
    async (file: OpenedPdf) => {
      running.current?.cancel()
      running.current = null
      setOpenError(null)
      setDocError(null)
      setBusy('Opening…')

      try {
        const pdf = await openDocument(file.bytes)
        const title = await documentTitle(pdf, file.name)

        const sizes: PageSize[] = []
        for (let n = 1; n <= pdf.numPages; n++) {
          sizes.push(pageSize(await pdf.getPage(n), 1))
        }

        const pageTexts = await extractPageText(pdf, (done, total) =>
          setBusy(`Reading text — page ${done} of ${total}`),
        )
        const outline = await readOutline(pdf)

        const next: Session = {
          path: file.path,
          title,
          pdf,
          numPages: pdf.numPages,
          sizes,
          pageTexts,
          outline,
        }

        const record = loadRecord(file.path, title)
        const restored = record.concepts.length
          ? widenConceptPages(record.concepts, pageTexts)
          : []

        setSession(next)
        setConcepts(restored)
        setConceptsStatus(restored.length ? 'ready' : 'idle')
        setConceptsError(null)
        setDeeper({})
        setMarks(record.highlights)
        setChat(record.chat)
        setPage(1)
        setSelection(null)
        setPinned(null)
        setTab('concepts')
        jumpSeq.current += 1
        setJump({ page: 1, seq: jumpSeq.current })

        rememberRecent({ path: file.path, title, pages: pdf.numPages })
        setRecentList(recents())

        setDocError(await registerDoc(next))
      } catch (error) {
        setOpenError(
          error instanceof Error ? error.message : 'That file could not be opened as a PDF.',
        )
      } finally {
        setBusy(null)
      }
    },
    [registerDoc],
  )

  const chooseFile = useCallback(async () => {
    const file = await window.tiro.openPdf()
    if (file) await openFile(file)
  }, [openFile])

  const openByPath = useCallback(
    async (path: string) => {
      const file = await window.tiro.readPdf(path)
      if (file) await openFile(file)
      else {
        setOpenError('That file has moved or been deleted.')
        forgetRecent(path)
        setRecentList(recents())
      }
    },
    [openFile],
  )

  const changeZoom = useCallback(
    (delta: number) => {
      // Hold the reading position: remember where we are inside the current page.
      const index = page - 1
      const within =
        layout.heights[index] > 0
          ? (metrics.scrollTop - layout.offsets[index]) / layout.heights[index]
          : 0

      setScale((current) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((current + delta).toFixed(2))))
        if (next !== current) jumpTo(page, Math.max(0, Math.min(1, within)))
        return next
      })
    },
    [page, layout, metrics.scrollTop, jumpTo],
  )

  // --- asking -------------------------------------------------------------

  const reregister = useCallback(async () => {
    if (!session) return false
    const failure = await registerDoc(session)
    setDocError(failure)
    return failure === null
  }, [session, registerDoc])

  const history = useCallback(
    (): AskRequest['history'] =>
      chat
        .filter((turn) => turn.content.trim() && !turn.error)
        .map((turn) => ({
          role: turn.role,
          content: turn.quote
            ? `[from p. ${turn.quote.page}] "${turn.quote.text}"\n\n${turn.content}`
            : turn.content,
        })),
    [chat],
  )

  const askInChat = useCallback(
    (mode: AskMode, question: string, quote?: { text: string; page: number }) => {
      if (!session) return
      running.current?.cancel()

      const answerId = newId()
      setTab('ask')
      setChat((current) => [
        ...current,
        { id: newId(), role: 'user', content: question, quote },
        { id: answerId, role: 'assistant', content: '', streaming: true },
      ])
      setPinned(null)
      setSelection(null)
      clearSelection()

      const patch = (change: Partial<ChatTurn>) =>
        setChat((current) =>
          current.map((turn) => (turn.id === answerId ? { ...turn, ...change } : turn)),
        )

      const request: AskRequest = {
        docId: session.path,
        mode,
        question,
        selection: quote,
        history: history(),
      }

      running.current = runAsk(
        request,
        {
          onText: (chunk) =>
            setChat((current) =>
              current.map((turn) =>
                turn.id === answerId ? { ...turn, content: turn.content + chunk } : turn,
              ),
            ),
          onDone: () => patch({ streaming: false }),
          onError: (message, flags) => {
            patch({ streaming: false, error: message })
            if (flags.needsKey) void refreshProvider()
          },
        },
        reregister,
      )
    },
    [session, history, reregister, refreshProvider],
  )

  const askAboutSelection = useCallback(
    (mode: 'define' | 'explain') => {
      if (!selection) return
      const label = mode === 'define' ? 'Define this' : 'Explain this'
      askInChat(mode, label, { text: selection.text, page: selection.page })
    },
    [selection, askInChat],
  )

  const goDeeper = useCallback(
    (concept: Concept) => {
      if (!session) return
      running.current?.cancel()
      setDeeper((current) => ({ ...current, [concept.id]: { text: '', streaming: true } }))

      const patch = (change: Partial<DeeperState>) =>
        setDeeper((current) => ({
          ...current,
          [concept.id]: { ...current[concept.id], ...change },
        }))

      running.current = runAsk(
        {
          docId: session.path,
          mode: 'deeper',
          question: concept.term,
          history: [],
        },
        {
          onText: (chunk) =>
            setDeeper((current) => ({
              ...current,
              [concept.id]: {
                ...current[concept.id],
                text: (current[concept.id]?.text ?? '') + chunk,
              },
            })),
          onDone: () => patch({ streaming: false }),
          onError: (message, flags) => {
            patch({ streaming: false, error: message })
            if (flags.needsKey) void refreshProvider()
          },
        },
        reregister,
      )
    },
    [session, reregister, refreshProvider],
  )

  const findConcepts = useCallback(async () => {
    if (!session) return
    setConceptsStatus('running')
    setConceptsError(null)

    const attempt = async (retry: boolean): Promise<void> => {
      const result = await window.tiro.concepts(session.path)
      if (result.ok) {
        setConcepts(widenConceptPages(result.concepts, session.pageTexts))
        setConceptsStatus('ready')
        return
      }
      if (result.needsDoc && retry && (await reregister())) return attempt(false)
      if (result.needsKey) void refreshProvider()
      setConceptsError(result.message)
      setConceptsStatus('error')
    }

    await attempt(true)
  }, [session, reregister, refreshProvider])

  const stopAsk = useCallback(() => {
    running.current?.cancel()
    running.current = null
    setChat((current) => current.map((turn) => ({ ...turn, streaming: false })))
    setDeeper((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, state]) => [id, { ...state, streaming: false }]),
      ),
    )
  }, [])

  // --- marks --------------------------------------------------------------

  const addMark = useCallback(() => {
    if (!selection) return
    const created: Highlight[] = selection.byPage.map((group) => ({
      id: newId(),
      page: group.page,
      text: selection.text,
      rects: group.rects,
      createdAt: Date.now(),
    }))
    setMarks((current) => [...current, ...created])
    setSelection(null)
    clearSelection()
  }, [selection])

  // --- menu + keys --------------------------------------------------------

  useEffect(() => window.tiro.onOpenFile((file) => void openFile(file)), [openFile])

  useEffect(
    () =>
      window.tiro.onMenu((action) => {
        switch (action) {
          case 'open':
            void chooseFile()
            break
          case 'settings':
            setSettingsOpen(true)
            break
          case 'zoom-in':
            changeZoom(0.15)
            break
          case 'zoom-out':
            changeZoom(-0.15)
            break
          case 'zoom-reset':
            setScale(1.1)
            break
          case 'find':
            if (session) setFindOpen(true)
            break
        }
      }),
    [chooseFile, changeZoom, session],
  )

  // --- render -------------------------------------------------------------

  if (!session) {
    return (
      <div className="app">
        <div className="titlebar-drag" />
        <Welcome
          recents={recentList}
          setupMessage={setupMessage}
          busy={busy}
          error={openError}
          onOpen={() => void chooseFile()}
          onOpenPath={(path) => void openByPath(path)}
          onForget={(path) => {
            forgetRecent(path)
            setRecentList(recents())
          }}
          onSettings={() => setSettingsOpen(true)}
        />
        {settingsOpen && providerState && (
          <Settings
            state={providerState}
            onState={setProviderState}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    )
  }

  const streaming =
    chat.some((turn) => turn.streaming) ||
    Object.values(deeper).some((state) => state.streaming)

  return (
    <div className="app">
      <div className="titlebar-drag" />
      <TopBar
        title={session.title}
        page={page}
        numPages={session.numPages}
        scale={scale}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
        onJump={jumpTo}
        onZoom={changeZoom}
        onZoomReset={() => setScale(1.1)}
        onOpen={() => void chooseFile()}
        onSettings={() => setSettingsOpen(true)}
        needsSetup={Boolean(setupMessage)}
      />

      <main className="workspace">
        {railOpen && (
          <OutlineRail
            outline={session.outline}
            numPages={session.numPages}
            currentPage={page}
            onJump={jumpTo}
          />
        )}

        <div className="stage">
          {busy && (
            <div className="loading-strip">
              <div className="reading-bar" aria-hidden />
              <span>{busy}</span>
            </div>
          )}
          {openError && (
            <p className="banner">
              {openError}{' '}
              <button type="button" className="banner-action" onClick={() => setOpenError(null)}>
                Dismiss
              </button>
            </p>
          )}
          {docError && (
            <p className="banner">
              {docError}{' '}
              <button type="button" className="banner-action" onClick={() => void reregister()}>
                Retry
              </button>
            </p>
          )}
          {findOpen && (
            <FindBar
              pageTexts={session.pageTexts}
              onJump={jumpTo}
              onClose={() => setFindOpen(false)}
            />
          )}
          <Viewer
            pdf={session.pdf}
            layout={layout}
            scale={scale}
            highlightsByPage={marksByPage}
            flashId={flashId}
            jump={jump}
            scrollTop={metrics.scrollTop}
            viewport={metrics.viewport}
            onPageChange={setPage}
            onScroll={setMetrics}
            onSelect={setSelection}
          />
        </div>

        <MarginRibbon
          layout={layout}
          scrollTop={metrics.scrollTop}
          viewport={metrics.viewport}
          marks={ribbon.markTicks}
          anchors={ribbon.anchorTicks}
          onJump={jumpTo}
        />

        <Panel tab={tab} onTab={setTab} conceptCount={concepts.length} markCount={marks.length}>
          {tab === 'concepts' && (
            <ConceptsTab
              status={conceptsStatus}
              error={conceptsError}
              concepts={concepts}
              currentPage={page}
              numPages={session.numPages}
              deeper={deeper}
              setupMessage={setupMessage}
              onExtract={() => void findConcepts()}
              onJump={jumpTo}
              onDeeper={goDeeper}
              onSettings={() => setSettingsOpen(true)}
            />
          )}
          {tab === 'ask' && (
            <AskTab
              chat={chat}
              selection={pinned}
              setupMessage={setupMessage}
              streaming={streaming}
              onSend={(question) => askInChat('chat', question, pinned ?? undefined)}
              onStop={stopAsk}
              onClearSelection={() => setPinned(null)}
              onJump={jumpTo}
              onSettings={() => setSettingsOpen(true)}
              onClear={() => setChat([])}
            />
          )}
          {tab === 'marks' && (
            <MarksTab
              marks={marks}
              onJump={jumpTo}
              onRemove={(id) => setMarks((current) => current.filter((m) => m.id !== id))}
              onAsk={(mark) => {
                setPinned({ text: mark.text, page: mark.page })
                setTab('ask')
              }}
            />
          )}
        </Panel>
      </main>

      {selection && (
        <SelectionMenu
          selection={selection}
          onHighlight={addMark}
          onDefine={() => askAboutSelection('define')}
          onExplain={() => askAboutSelection('explain')}
          onAsk={() => {
            setPinned({ text: selection.text, page: selection.page })
            setTab('ask')
            setSelection(null)
            clearSelection()
          }}
        />
      )}

      {settingsOpen && providerState && (
        <Settings
          state={providerState}
          onState={setProviderState}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )

}
