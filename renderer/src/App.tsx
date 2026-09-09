import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AskRequest,
  AskMode,
  ChatTurn,
  CodeFile,
  Concept,
  Highlight,
  OpenedPdf,
  ProviderState,
} from '@shared/types'
import { runAsk, type RunningAsk } from './lib/ask'
import { computeLayout, type PageSize } from './lib/layout'
import { documentTitle, extractPageText, openDocument, pageSize, readOutline } from './lib/pdf'
import { clearSelection, type PickedSelection } from './lib/selection'
import {
  flushRecord,
  forgetRecent,
  loadRecord,
  newId,
  readPanelWidth,
  recents,
  rememberRecent,
  saveRecordSoon,
  writePanelWidth,
  type RecentDoc,
} from './lib/store'
import { applyPatch, isStreaming, neighbourOf, type DocTab, type TabPatch } from './lib/tabs'
import { truncate, widenConceptPages } from './lib/text'
import { AskTab } from './components/AskTab'
import { CodeTab } from './components/CodeTab'
import { ConceptsTab, type DeeperState } from './components/ConceptsTab'
import { FindBar } from './components/FindBar'
import { MarginRibbon, type RibbonTick } from './components/MarginRibbon'
import { MarksTab } from './components/MarksTab'
import { OutlineRail } from './components/OutlineRail'
import { Panel, type PanelTab } from './components/Panel'
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  PanelResizer,
} from './components/PanelResizer'
import { SelectionMenu } from './components/SelectionMenu'
import { Settings } from './components/Settings'
import { TabStrip } from './components/TabStrip'
import { TopBar } from './components/TopBar'
import { Viewer, type JumpRequest } from './components/Viewer'
import { Welcome } from './components/Welcome'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const DEFAULT_SCALE = 1.1

export function App() {
  const [tabs, setTabs] = useState<DocTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [providerState, setProviderState] = useState<ProviderState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [recentList, setRecentList] = useState<RecentDoc[]>(() => recents())
  /** What the reader asked for. Stored unclamped; clamped only when rendering. */
  const [preferredPanelWidth, setPreferredPanelWidth] = useState(
    () => readPanelWidth() ?? DEFAULT_PANEL_WIDTH,
  )
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)

  // Live state for whichever document is on screen. Updated every scroll frame,
  // so it is deliberately kept out of the tab objects.
  const [page, setPage] = useState(1)
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewport: 0 })
  const [jump, setJump] = useState<JumpRequest | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [selection, setSelection] = useState<PickedSelection | null>(null)

  /** Read inside callbacks so they never close over a stale tab list. */
  const tabsRef = useRef<DocTab[]>([])
  tabsRef.current = tabs

  /** One in-flight request per tab, so an answer survives switching away. */
  const running = useRef(new Map<string, RunningAsk>())
  /** Paths mid-open. Two files delivered at once must not become two tabs. */
  const opening = useRef(new Set<string>())
  const jumpSeq = useRef(0)
  const liveScroll = useRef(0)
  liveScroll.current = metrics.scrollTop

  const active = tabs.find((tab) => tab.id === activeId) ?? null

  const patchTab = useCallback((id: string, patch: TabPatch) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? applyPatch(tab, patch) : tab)))
  }, [])

  const setupMessage = useMemo(() => {
    if (!providerState) return null
    if (providerState.ready) return null
    if (providerState.local) return 'Pick a local model in Settings to turn this on.'
    if (!providerState.hasKey) return 'Add an API key in Settings to turn this on.'
    return 'Pick a model in Settings to turn this on.'
  }, [providerState])

  /** The top-right control names the model it opens, rather than a glyph. */
  const model = useMemo(() => {
    if (!providerState || !providerState.ready) {
      return { label: 'Model', title: 'Pick a model' }
    }
    return {
      label: providerState.model,
      title: `${providerState.provider} · ${providerState.model} — change model`,
    }
  }, [providerState])

  const layout = useMemo(
    () => computeLayout(active?.sizes ?? [], active?.scale ?? DEFAULT_SCALE),
    [active?.sizes, active?.scale],
  )

  const marksByPage = useMemo(() => {
    const groups = new Map<number, Highlight[]>()
    for (const mark of active?.marks ?? []) {
      const list = groups.get(mark.page) ?? []
      list.push(mark)
      groups.set(mark.page, list)
    }
    return groups
  }, [active?.marks])

  const ribbon = useMemo(() => {
    const markTicks: RibbonTick[] = (active?.marks ?? []).map((mark) => ({
      id: mark.id,
      page: mark.page,
      within: mark.rects[0]?.y ?? 0,
      label: truncate(mark.text, 70),
    }))
    const anchorTicks: RibbonTick[] = (active?.concepts ?? []).map((concept) => ({
      id: concept.id,
      page: concept.firstPage,
      within: 0.5,
      label: concept.term,
    }))
    return { markTicks, anchorTicks }
  }, [active?.marks, active?.concepts])

  useEffect(() => {
    void window.tiro.getProviderState().then(setProviderState)
  }, [])

  const refreshProvider = useCallback(async () => {
    setProviderState(await window.tiro.getProviderState())
  }, [])

  // Persist every tab's marks, concepts, and conversation, on a delay.
  useEffect(() => {
    for (const tab of tabs) {
      saveRecordSoon(tab.id, {
        title: tab.title,
        concepts: tab.concepts,
        highlights: tab.marks,
        chat: tab.chat,
        repo: tab.repo,
        codeMatches: tab.codeMatches,
      })
    }
  }, [tabs])

  const panelWidth = clampPanelWidth(preferredPanelWidth, viewportWidth)

  const resizePanel = useCallback((width: number) => {
    setPreferredPanelWidth(width)
    writePanelWidth(width)
  }, [])

  // Track the window so the panel gives room back as it narrows, and takes it
  // again as it widens.
  useEffect(() => {
    const onWindowResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [])

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

  // --- opening and closing ------------------------------------------------

  const registerDoc = useCallback(async (tab: DocTab): Promise<string | null> => {
    const result = await window.tiro.registerDoc({
      docId: tab.id,
      title: tab.title,
      pages: tab.pageTexts,
    })
    return result.ok ? null : result.message
  }, [])

  /** Stores the outgoing tab's scroll position so returning to it lands right. */
  const rememberScroll = useCallback(() => {
    const current = activeId
    if (current) patchTab(current, { scrollTop: liveScroll.current })
  }, [activeId, patchTab])

  const activate = useCallback(
    (id: string) => {
      if (id === activeId) return
      rememberScroll()
      setActiveId(id)
      setSelection(null)
      clearSelection()
      setFindOpen(false)
      setJump(null)
      const tab = tabsRef.current.find((entry) => entry.id === id)
      setPage(1)
      setMetrics({ scrollTop: tab?.scrollTop ?? 0, viewport: metrics.viewport })
    },
    [activeId, rememberScroll, metrics.viewport],
  )

  const openFile = useCallback(
    async (file: OpenedPdf) => {
      // Already open? Just go to it rather than loading a second copy.
      const existing = tabsRef.current.find((tab) => tab.id === file.path)
      if (existing) {
        activate(existing.id)
        return
      }
      if (opening.current.has(file.path)) return

      opening.current.add(file.path)
      setOpenError(null)
      setBusy('Opening…')
      try {
        const { pdf, destroy } = await openDocument(file.bytes)
        const title = await documentTitle(pdf, file.name)

        const sizes: PageSize[] = []
        for (let n = 1; n <= pdf.numPages; n++) {
          sizes.push(pageSize(await pdf.getPage(n), 1))
        }

        const pageTexts = await extractPageText(pdf, (done, total) =>
          setBusy(`Reading text — page ${done} of ${total}`),
        )
        const outline = await readOutline(pdf)

        const record = loadRecord(file.path, title)
        const restored = record.concepts.length
          ? widenConceptPages(record.concepts, pageTexts)
          : []

        const tab: DocTab = {
          id: file.path,
          title,
          pdf,
          destroy,
          numPages: pdf.numPages,
          sizes,
          pageTexts,
          outline,
          scale: DEFAULT_SCALE,
          scrollTop: 0,
          concepts: restored,
          conceptsStatus: restored.length ? 'ready' : 'idle',
          conceptsError: null,
          deeper: {},
          repo: record.repo ?? null,
          codeMatches: record.codeMatches ?? [],
          codeStatus: (record.codeMatches ?? []).length > 0 ? 'ready' : 'idle',
          codeError: null,
          marks: record.highlights,
          chat: record.chat,
          panelTab: 'concepts',
          pinned: null,
          docError: null,
        }

        rememberScroll()
        setTabs((current) => [...current, tab])
        setActiveId(tab.id)
        setPage(1)
        setMetrics({ scrollTop: 0, viewport: metrics.viewport })
        setSelection(null)
        setJump(null)

        rememberRecent({ path: file.path, title, pages: pdf.numPages })
        setRecentList(recents())

        const failure = await registerDoc(tab)
        if (failure) patchTab(tab.id, { docError: failure })
      } catch (error) {
        setOpenError(
          error instanceof Error ? error.message : 'That file could not be opened as a PDF.',
        )
      } finally {
        opening.current.delete(file.path)
        setBusy(null)
      }
    },
    [activate, rememberScroll, registerDoc, patchTab, metrics.viewport],
  )

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === id)
      if (!tab) return

      running.current.get(id)?.cancel()
      running.current.delete(id)

      // Get this document's work to disk before dropping it from memory.
      flushRecord(id, {
        title: tab.title,
        concepts: tab.concepts,
        highlights: tab.marks,
        chat: tab.chat,
        repo: tab.repo,
        codeMatches: tab.codeMatches,
      })
      void tab.destroy()

      const next = neighbourOf(tabsRef.current, id)
      setTabs((current) => current.filter((entry) => entry.id !== id))

      if (id === activeId) {
        setActiveId(next)
        setSelection(null)
        clearSelection()
        setFindOpen(false)
        setJump(null)
        setPage(1)
        const following = tabsRef.current.find((entry) => entry.id === next)
        setMetrics({ scrollTop: following?.scrollTop ?? 0, viewport: metrics.viewport })
      }
    },
    [activeId, metrics.viewport],
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
      if (!active) return
      const index = page - 1
      const within =
        layout.heights[index] > 0
          ? (metrics.scrollTop - layout.offsets[index]) / layout.heights[index]
          : 0

      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Number((active.scale + delta).toFixed(2))),
      )
      if (next === active.scale) return
      patchTab(active.id, { scale: next })
      jumpTo(page, Math.max(0, Math.min(1, within)))
    },
    [active, page, layout, metrics.scrollTop, patchTab, jumpTo],
  )

  // --- asking -------------------------------------------------------------

  const reregister = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId)
      if (!tab) return false
      const failure = await registerDoc(tab)
      patchTab(tabId, { docError: failure })
      return failure === null
    },
    [registerDoc, patchTab],
  )

  const historyFor = useCallback((tab: DocTab): AskRequest['history'] => {
    return tab.chat
      .filter((turn) => turn.content.trim() && !turn.error)
      .map((turn) => ({
        role: turn.role,
        content: turn.quote
          ? `[from p. ${turn.quote.page}] "${turn.quote.text}"\n\n${turn.content}`
          : turn.content,
      }))
  }, [])

  const askInChat = useCallback(
    (tabId: string, mode: AskMode, question: string, quote?: { text: string; page: number }) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId)
      if (!tab) return

      running.current.get(tabId)?.cancel()

      const answerId = newId()
      // Everything below is bound to tabId, not to whatever is active later.
      patchTab(tabId, (current) => ({
        panelTab: 'ask',
        pinned: null,
        chat: [
          ...current.chat,
          { id: newId(), role: 'user', content: question, quote, mode },
          { id: answerId, role: 'assistant', content: '', streaming: true },
        ],
      }))
      setSelection(null)
      clearSelection()

      const patchTurn = (change: Partial<ChatTurn>) =>
        patchTab(tabId, (current) => ({
          chat: current.chat.map((turn) => (turn.id === answerId ? { ...turn, ...change } : turn)),
        }))

      running.current.set(
        tabId,
        runAsk(
          {
            docId: tabId,
            mode,
            question,
            selection: quote,
            history: historyFor(tab),
            // Only when linked; without it the model has no repository tools.
            repoPath: tab.repo?.path,
          },
          {
            onText: (chunk) =>
              patchTab(tabId, (current) => ({
                chat: current.chat.map((turn) =>
                  turn.id === answerId ? { ...turn, content: turn.content + chunk } : turn,
                ),
              })),
            onTool: (note) =>
              patchTab(tabId, (current) => ({
                chat: current.chat.map((turn) =>
                  turn.id === answerId ? { ...turn, tools: [...(turn.tools ?? []), note] } : turn,
                ),
              })),
            onDone: () => {
              patchTurn({ streaming: false })
              running.current.delete(tabId)
            },
            onError: (message, flags) => {
              patchTurn({ streaming: false, error: message })
              running.current.delete(tabId)
              if (flags.needsKey) void refreshProvider()
            },
          },
          () => reregister(tabId),
        ),
      )
    },
    [patchTab, historyFor, reregister, refreshProvider],
  )

  const askAboutSelection = useCallback(
    (mode: 'define' | 'explain') => {
      if (!selection || !active) return
      const label = mode === 'define' ? 'Define this' : 'Explain this'
      askInChat(active.id, mode, label, { text: selection.text, page: selection.page })
    },
    [selection, active, askInChat],
  )

  const goDeeper = useCallback(
    (tabId: string, concept: Concept) => {
      running.current.get(tabId)?.cancel()
      patchTab(tabId, (current) => ({
        deeper: { ...current.deeper, [concept.id]: { text: '', streaming: true } },
      }))

      const patchDeeper = (change: Partial<DeeperState>) =>
        patchTab(tabId, (current) => ({
          deeper: {
            ...current.deeper,
            [concept.id]: { ...current.deeper[concept.id], ...change },
          },
        }))

      running.current.set(
        tabId,
        runAsk(
          { docId: tabId, mode: 'deeper', question: concept.term, history: [] },
          {
            onTool: () => {},
            onText: (chunk) =>
              patchTab(tabId, (current) => ({
                deeper: {
                  ...current.deeper,
                  [concept.id]: {
                    ...current.deeper[concept.id],
                    text: (current.deeper[concept.id]?.text ?? '') + chunk,
                  },
                },
              })),
            onDone: () => {
              patchDeeper({ streaming: false })
              running.current.delete(tabId)
            },
            onError: (message, flags) => {
              patchDeeper({ streaming: false, error: message })
              running.current.delete(tabId)
              if (flags.needsKey) void refreshProvider()
            },
          },
          () => reregister(tabId),
        ),
      )
    },
    [patchTab, reregister, refreshProvider],
  )

  const findConcepts = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId)
      if (!tab) return
      patchTab(tabId, { conceptsStatus: 'running', conceptsError: null })

      const attempt = async (retry: boolean): Promise<void> => {
        const result = await window.tiro.concepts(tabId)
        if (result.ok) {
          patchTab(tabId, {
            concepts: widenConceptPages(result.concepts, tab.pageTexts),
            conceptsStatus: 'ready',
          })
          return
        }
        if (result.needsDoc && retry && (await reregister(tabId))) return attempt(false)
        if (result.needsKey) void refreshProvider()
        patchTab(tabId, { conceptsError: result.message, conceptsStatus: 'error' })
      }

      await attempt(true)
    },
    [patchTab, reregister, refreshProvider],
  )

  // --- code ---------------------------------------------------------------

  const linkRepo = useCallback(
    async (tabId: string) => {
      const picked = await window.tiro.pickRepo()
      if (!picked) return
      const result = await window.tiro.linkRepo(picked.path)
      if (!result.ok) {
        patchTab(tabId, { codeStatus: 'error', codeError: result.message })
        return
      }
      patchTab(tabId, {
        repo: result.repo,
        codeStatus: 'idle',
        codeError: null,
        codeMatches: [],
      })
    },
    [patchTab],
  )

  const matchCode = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId)
      if (!tab?.repo || tab.concepts.length === 0) return

      patchTab(tabId, { codeStatus: 'running', codeError: null })
      const attempt = async (retry: boolean): Promise<void> => {
        const result = await window.tiro.matchCode(tabId, tab.repo!.path, tab.concepts)
        if (result.ok) {
          patchTab(tabId, { codeMatches: result.matches, codeStatus: 'ready' })
          return
        }
        if (result.needsDoc && retry && (await reregister(tabId))) return attempt(false)
        if (result.needsKey) void refreshProvider()
        patchTab(tabId, { codeStatus: 'error', codeError: result.message })
      }
      await attempt(true)
    },
    [patchTab, reregister, refreshProvider],
  )

  const readCode = useCallback(
    async (tabId: string, filePath: string): Promise<CodeFile | null> => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId)
      if (!tab?.repo) return null
      const result = await window.tiro.readCode(tab.repo.path, filePath)
      return result.ok ? result.file : null
    },
    [],
  )

  const stopAsk = useCallback(
    (tabId: string) => {
      running.current.get(tabId)?.cancel()
      running.current.delete(tabId)
      patchTab(tabId, (current) => ({
        chat: current.chat.map((turn) => ({ ...turn, streaming: false })),
        deeper: Object.fromEntries(
          Object.entries(current.deeper).map(([id, state]) => [
            id,
            { ...state, streaming: false },
          ]),
        ),
      }))
    },
    [patchTab],
  )

  // --- marks --------------------------------------------------------------

  const addMark = useCallback(() => {
    if (!selection || !active) return
    const created: Highlight[] = selection.byPage.map((group) => ({
      id: newId(),
      page: group.page,
      text: selection.text,
      rects: group.rects,
      createdAt: Date.now(),
    }))
    patchTab(active.id, (current) => ({ marks: [...current.marks, ...created] }))
    setSelection(null)
    clearSelection()
  }, [selection, active, patchTab])

  // --- menu + keys --------------------------------------------------------

  const cycleTab = useCallback(
    (delta: number) => {
      const list = tabsRef.current
      if (list.length < 2) return
      const index = list.findIndex((tab) => tab.id === activeId)
      const next = (index + delta + list.length) % list.length
      activate(list[next].id)
    },
    [activeId, activate],
  )

  useEffect(() => window.tiro.onOpenFile((file) => void openFile(file)), [openFile])

  useEffect(
    () =>
      window.tiro.onMenu((action) => {
        switch (action) {
          case 'open':
          case 'new-tab':
            void chooseFile()
            break
          case 'close-tab':
            if (activeId) closeTab(activeId)
            break
          case 'next-tab':
            cycleTab(1)
            break
          case 'prev-tab':
            cycleTab(-1)
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
            if (active) patchTab(active.id, { scale: DEFAULT_SCALE })
            break
          case 'find':
            if (active) setFindOpen(true)
            break
        }
      }),
    [chooseFile, closeTab, cycleTab, changeZoom, activeId, active, patchTab],
  )

  // ⌘1…⌘9 selects a tab by position.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return
      const digit = Number(event.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return
      const target = tabsRef.current[digit - 1]
      if (!target) return
      event.preventDefault()
      activate(target.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activate])

  // --- render -------------------------------------------------------------

  const settingsSheet =
    settingsOpen && providerState ? (
      <Settings
        state={providerState}
        onState={setProviderState}
        onClose={() => setSettingsOpen(false)}
      />
    ) : null

  if (!active) {
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
        {settingsSheet}
      </div>
    )
  }

  return (
    <div className="app">
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onSelect={activate}
        onClose={closeTab}
        onNew={() => void chooseFile()}
      />
      <TopBar
        page={page}
        numPages={active.numPages}
        scale={active.scale}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
        onJump={jumpTo}
        onZoom={changeZoom}
        onZoomReset={() => patchTab(active.id, { scale: DEFAULT_SCALE })}
        onOpen={() => void chooseFile()}
        onSettings={() => setSettingsOpen(true)}
        modelLabel={model.label}
        modelTitle={model.title}
        needsSetup={Boolean(setupMessage)}
      />

      <main className="workspace">
        {railOpen && (
          <OutlineRail
            outline={active.outline}
            numPages={active.numPages}
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
          {active.docError && (
            <p className="banner">
              {active.docError}{' '}
              <button
                type="button"
                className="banner-action"
                onClick={() => void reregister(active.id)}
              >
                Retry
              </button>
            </p>
          )}
          {findOpen && (
            <FindBar
              pageTexts={active.pageTexts}
              onJump={jumpTo}
              onClose={() => setFindOpen(false)}
            />
          )}
          <Viewer
            key={active.id}
            pdf={active.pdf}
            layout={layout}
            scale={active.scale}
            highlightsByPage={marksByPage}
            flashId={flashId}
            jump={jump}
            initialScrollTop={active.scrollTop}
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

        <PanelResizer
          width={panelWidth}
          onResize={resizePanel}
          onReset={() => resizePanel(DEFAULT_PANEL_WIDTH)}
        />

        <Panel
          width={panelWidth}
          tab={active.panelTab}
          onTab={(next: PanelTab) => patchTab(active.id, { panelTab: next })}
          conceptCount={active.concepts.length}
          markCount={active.marks.length}
          codeCount={active.codeMatches.length}
        >
          {active.panelTab === 'concepts' && (
            <ConceptsTab
              status={active.conceptsStatus}
              error={active.conceptsError}
              concepts={active.concepts}
              currentPage={page}
              numPages={active.numPages}
              deeper={active.deeper}
              setupMessage={setupMessage}
              onExtract={() => void findConcepts(active.id)}
              onJump={jumpTo}
              onDeeper={(concept) => goDeeper(active.id, concept)}
              onSettings={() => setSettingsOpen(true)}
            />
          )}
          {active.panelTab === 'ask' && (
            <AskTab
              chat={active.chat}
              selection={active.pinned}
              setupMessage={setupMessage}
              streaming={isStreaming(active)}
              repoName={active.repo?.name ?? null}
              onSend={(question) =>
                askInChat(active.id, 'chat', question, active.pinned ?? undefined)
              }
              onStop={() => stopAsk(active.id)}
              onClearSelection={() => patchTab(active.id, { pinned: null })}
              onJump={jumpTo}
              onSettings={() => setSettingsOpen(true)}
              onClear={() => patchTab(active.id, { chat: [] })}
            />
          )}
          {active.panelTab === 'code' && (
            <CodeTab
              repo={active.repo}
              concepts={active.concepts}
              matches={active.codeMatches}
              status={active.codeStatus}
              error={active.codeError}
              setupMessage={setupMessage}
              onLink={() => void linkRepo(active.id)}
              onUnlink={() =>
                patchTab(active.id, { repo: null, codeMatches: [], codeStatus: 'idle' })
              }
              onMatch={() => void matchCode(active.id)}
              onRead={(path) => readCode(active.id, path)}
              onSettings={() => setSettingsOpen(true)}
            />
          )}
          {active.panelTab === 'marks' && (
            <MarksTab
              marks={active.marks}
              onJump={jumpTo}
              onRemove={(id) =>
                patchTab(active.id, (current) => ({
                  marks: current.marks.filter((mark) => mark.id !== id),
                }))
              }
              onAsk={(mark) =>
                patchTab(active.id, {
                  pinned: { text: mark.text, page: mark.page },
                  panelTab: 'ask',
                })
              }
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
            patchTab(active.id, {
              pinned: { text: selection.text, page: selection.page },
              panelTab: 'ask',
            })
            setSelection(null)
            clearSelection()
          }}
        />
      )}

      {settingsSheet}
    </div>
  )
}
