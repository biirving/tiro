import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AskEvent,
  AskRequest,
  Concept,
  DocPayload,
  Failure,
  MenuAction,
  OpenedPdf,
  ProviderId,
} from '@shared/types'
import { putDoc } from './docs'
import {
  ask,
  cancelAsk,
  describeError,
  extractConcepts,
  listModels,
  providerState,
  sessionTotals,
} from './providers'
import { configureUsageLog, reportDocument, reportProvider } from './providers/usage'
import { linkRepo, matchCode } from './repo/match'
import { readCode } from './repo/read'
import { clearApiKey, setApiKey, setOllamaHost, setProvider } from './settings'

const isDev = !app.isPackaged
/** Diagnostics in a packaged build: TIRO_DEBUG=1 to see why a window came up blank. */
const isDebug = isDev || process.env.TIRO_DEBUG === '1'
const isMac = process.platform === 'darwin'
const RENDERER_ROOT = join(__dirname, '../renderer')

/**
 * Production loads the renderer over app:// rather than file://. A real origin
 * keeps module workers — pdf.js runs on one — and fetch behaving normally.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let mainWindow: BrowserWindow | null = null
/** PDFs handed to us before the window was ready. */
let queuedFiles: string[] = []

const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "worker-src 'self' blob:; " +
  "object-src 'none'; " +
  "frame-src 'none'"

function serveRenderer(): void {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const filePath = normalize(join(RENDERER_ROOT, relative))

    if (filePath !== RENDERER_ROOT && !filePath.startsWith(RENDERER_ROOT + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    const response = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CSP)
    return new Response(response.body, { status: response.status, headers })
  })
}

async function readPdf(path: string): Promise<OpenedPdf | null> {
  try {
    const bytes = new Uint8Array(await readFile(path))
    return { path, name: basename(path), bytes }
  } catch {
    return null
  }
}

function sendMenu(action: MenuAction): void {
  mainWindow?.webContents.send('tiro:menu', action)
}

async function openViaDialog(): Promise<OpenedPdf | null> {
  const result = await dialog.showOpenDialog({
    title: 'Open a PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  const path = result.filePaths[0]
  return result.canceled || !path ? null : readPdf(path)
}

/** Hands a PDF opened from Finder or the dock to the renderer. */
async function deliverFile(path: string): Promise<void> {
  if (!mainWindow) {
    queuedFiles.push(path)
    return
  }
  const file = await readPdf(path)
  if (file) mainWindow.webContents.send('tiro:open-file', file)
}

/** Supports `tiro a.pdf b.pdf`, opening each as its own tab. */
function pdfsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((arg) => arg.toLowerCase().endsWith('.pdf') && existsSync(arg))
}

function buildMenu(): void {
  const appMenu: Electron.MenuItemConstructorOptions[] = isMac
    ? [
        {
          role: 'appMenu',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              label: 'Settings…',
              accelerator: 'CmdOrCtrl+,',
              click: () => sendMenu('settings'),
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : []

  const template: Electron.MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => sendMenu('new-tab') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-tab') },
        // ⌘W belongs to the tab now, so the window moves to ⌘⇧W.
        isMac
          ? { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }
          : { role: 'quit' },
        // Settings lives in the app menu on macOS and here everywhere else.
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendMenu('settings'),
              },
            ] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Find in Document', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('find') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => sendMenu('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenu('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => sendMenu('zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? ([{ role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Next Tab',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => sendMenu('next-tab'),
        },
        {
          label: 'Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => sendMenu('prev-tab'),
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Get an Anthropic API key',
          click: () => shell.openExternal('https://console.anthropic.com/settings/keys'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f16',
    // The inset title bar is a macOS affordance; elsewhere keep the native frame.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }
      : {}),
    icon: process.platform === 'linux' ? join(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    const queued = queuedFiles
    queuedFiles = []
    // Sequential so the renderer builds the tabs in the order given.
    void queued.reduce<Promise<void>>(
      (chain, path) => chain.then(() => deliverFile(path)),
      Promise.resolve(),
    )
  })

  // If `ready-to-show` never arrives, show the window anyway. A blank frame with
  // an explanation beats an invisible failure the user can only call "frozen".
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.error('[tiro] renderer never became ready — showing the window anyway')
      mainWindow.show()
    }
  }, 10_000)
  mainWindow.once('show', () => clearTimeout(showFallback))
  mainWindow.on('closed', () => clearTimeout(showFallback))

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDebug) {
    // A preload that throws leaves window.tiro undefined, and the renderer dies
    // on its first line. This is the event that says so.
    mainWindow.webContents.on('preload-error', (_event, path, error) => {
      console.error(`[preload-error] ${path}: ${error.message}`)
      if (error.stack) console.error(error.stack)
    })
    mainWindow.webContents.on('console-message', (details) => {
      if (details.level === 'error' || details.level === 'warning') {
        const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
        console.log(`[renderer:${details.level}] ${details.message}${where}`)
      }
    })
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer gone]', details.reason, details.exitCode)
    })
    mainWindow.webContents.on('unresponsive', () => {
      console.error('[renderer unresponsive]')
    })
  }

  // External links open in the browser, never in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url)
    mainWindow?.show()
    dialog.showErrorBox(
      'Tiro could not start',
      `The interface failed to load (${desc}).\n\n${url}\n\n` +
        'If Tiro was just rebuilt or reinstalled while it was running, quit it ' +
        'completely — Tiro → Quit, not just closing the window — and open it again.',
    )
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadURL('app://tiro/index.html')
  }
}

function fail(error: unknown): Failure {
  return { ok: false, ...describeError(error) }
}

function registerIpc(): void {
  ipcMain.handle('tiro:open-pdf', () => openViaDialog())
  ipcMain.handle('tiro:read-pdf', (_event, path: string) => readPdf(path))

  ipcMain.handle('tiro:register-doc', (_event, payload: DocPayload) => {
    try {
      const doc = putDoc(payload)
      const state = providerState()
      reportDocument({
        title: doc.title,
        pages: doc.pages.length,
        chars: doc.text.length,
        provider: state.provider,
        model: state.model,
      })
      return { ok: true as const }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('tiro:concepts', async (_event, docId: string) => {
    try {
      return { ok: true as const, concepts: await extractConcepts(docId) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'tiro:ask',
    async (event: IpcMainInvokeEvent, streamId: string, request: AskRequest) => {
      const channel = `tiro:ask:${streamId}`
      const emit = (askEvent: AskEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, askEvent)
      }
      try {
        await ask(streamId, request, emit)
      } catch (error) {
        emit({ type: 'error', ...describeError(error) })
      }
    },
  )

  ipcMain.on('tiro:cancel-ask', (_event, streamId: string) => cancelAsk(streamId))

  ipcMain.handle('tiro:pick-repo', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose the repository for this paper',
      properties: ['openDirectory'],
      buttonLabel: 'Link repository',
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    try {
      return await linkRepo(path)
    } catch {
      // The renderer links explicitly next, which reports the real reason.
      return { path, name: path.split('/').pop() ?? path, fileCount: 0 }
    }
  })

  ipcMain.handle('tiro:link-repo', async (_event, path: string) => {
    try {
      return { ok: true as const, repo: await linkRepo(path) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'tiro:match-code',
    async (_event, docId: string, repoPath: string, concepts: Concept[]) => {
      try {
        return { ok: true as const, matches: await matchCode(docId, repoPath, concepts) }
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle('tiro:read-code', async (_event, repoPath: string, filePath: string) => {
    try {
      return { ok: true as const, file: await readCode(repoPath, filePath) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('tiro:provider-state', () => providerState())

  ipcMain.handle('tiro:set-provider', (_event, provider: ProviderId, model: string) => {
    setProvider(provider, model)
    return providerState()
  })

  ipcMain.handle('tiro:set-ollama-host', (_event, host: string) => {
    setOllamaHost(host)
    return providerState()
  })

  ipcMain.handle('tiro:list-models', async (_event, provider: ProviderId) => {
    try {
      return { ok: true as const, models: await listModels(provider) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('tiro:set-key', (_event, provider: ProviderId, key: string) => {
    try {
      setApiKey(provider, key)
      return { ok: true as const }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('tiro:clear-key', (_event, provider: ProviderId) => {
    clearApiKey(provider)
    return providerState()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // On macOS the app outlives its last window, so a relaunch often arrives
    // with nothing to focus. Without this, opening Tiro again does nothing at all.
    if (!mainWindow) {
      createWindow()
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    for (const path of pdfsFromArgv(argv)) void deliverFile(path)
  })

  // Fires before `ready` when the app is launched by double-clicking a PDF.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    void deliverFile(path)
  })

  void app.whenReady().then(() => {
    configureUsageLog(
      isDev || process.env.TIRO_USAGE_LOG === '1' || process.env.TIRO_CACHE_LOG === '1',
    )
    reportProvider(providerState())
    serveRenderer()
    registerIpc()
    buildMenu()

    queuedFiles = pdfsFromArgv(process.argv)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    const { requests, cost, unpriced } = sessionTotals()
    if (requests === 0) return
    const unpricedNote = unpriced > 0 ? ` (${unpriced} not priced)` : ''
    console.log(
      `[tiro] session total — ${requests} request${requests === 1 ? '' : 's'}, ` +
        `$${cost.toFixed(4)}${unpricedNote}`,
    )
  })
}
