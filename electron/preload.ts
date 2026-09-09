import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AskEvent,
  AskRequest,
  Concept,
  DocPayload,
  MenuAction,
  OpenedPdf,
  ProviderId,
  TiroBridge,
} from '@shared/types'

const bridge: TiroBridge = {
  openPdf: () => ipcRenderer.invoke('tiro:open-pdf'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  readPdf: (path) => ipcRenderer.invoke('tiro:read-pdf', path),
  registerDoc: (payload: DocPayload) => ipcRenderer.invoke('tiro:register-doc', payload),
  concepts: (docId) => ipcRenderer.invoke('tiro:concepts', docId),

  pickRepo: () => ipcRenderer.invoke('tiro:pick-repo'),
  linkRepo: (path: string) => ipcRenderer.invoke('tiro:link-repo', path),
  matchCode: (docId: string, repoPath: string, concepts: Concept[]) =>
    ipcRenderer.invoke('tiro:match-code', docId, repoPath, concepts),
  readCode: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke('tiro:read-code', repoPath, filePath),

  ask: (streamId, request: AskRequest, onEvent) => {
    const channel = `tiro:ask:${streamId}`
    const listener = (_event: unknown, askEvent: AskEvent) => onEvent(askEvent)
    ipcRenderer.on(channel, listener)
    return ipcRenderer
      .invoke('tiro:ask', streamId, request)
      .finally(() => ipcRenderer.removeListener(channel, listener))
  },
  cancelAsk: (streamId) => ipcRenderer.send('tiro:cancel-ask', streamId),

  getProviderState: () => ipcRenderer.invoke('tiro:provider-state'),
  setProvider: (provider: ProviderId, model: string) =>
    ipcRenderer.invoke('tiro:set-provider', provider, model),
  setOllamaHost: (host: string) => ipcRenderer.invoke('tiro:set-ollama-host', host),
  listModels: (provider: ProviderId) => ipcRenderer.invoke('tiro:list-models', provider),
  setApiKey: (provider: ProviderId, key: string) =>
    ipcRenderer.invoke('tiro:set-key', provider, key),
  clearApiKey: (provider: ProviderId) => ipcRenderer.invoke('tiro:clear-key', provider),

  openExternal: (url: string) => ipcRenderer.send('tiro:open-external', url),

  onOpenFile: (handler) => {
    const listener = (_event: unknown, file: OpenedPdf) => handler(file)
    ipcRenderer.on('tiro:open-file', listener)
    return () => ipcRenderer.removeListener('tiro:open-file', listener)
  },
  onMenu: (handler) => {
    const listener = (_event: unknown, action: MenuAction) => handler(action)
    ipcRenderer.on('tiro:menu', listener)
    return () => ipcRenderer.removeListener('tiro:menu', listener)
  },

  platform: process.platform,
}

contextBridge.exposeInMainWorld('tiro', bridge)
