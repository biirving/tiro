import { useCallback, useEffect, useState } from 'react'
import type { FerryStatus, ModelOption, ProviderId, ProviderState } from '@shared/types'

interface SettingsProps {
  state: ProviderState
  onState: (next: ProviderState) => void
  onClose: () => void
}

const PROVIDERS: { id: ProviderId; label: string; note: string }[] = [
  { id: 'anthropic', label: 'Anthropic', note: 'Claude. Best whole-document reasoning.' },
  { id: 'openai', label: 'OpenAI', note: 'GPT models through your own API key.' },
  { id: 'ollama', label: 'Local', note: 'Ollama on this machine. No key, no data leaves.' },
]

const KEY_HINT: Partial<Record<ProviderId, string>> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
}

const KEY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}

export function Settings({ state, onState, onClose }: SettingsProps) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [host, setHost] = useState(state.ollamaHost)
  const [ferry, setFerry] = useState<FerryStatus | null>(null)
  const [ferryPath, setFerryPath] = useState('')
  const [lookingForFerry, setLookingForFerry] = useState(false)

  const provider = state.provider
  const label = PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const loadModels = useCallback(
    async (target: ProviderId) => {
      setLoadingModels(true)
      setModelError(null)
      const result = await window.tiro.listModels(target)
      setLoadingModels(false)
      if (result.ok) setModels(result.models)
      else {
        setModels([])
        setModelError(result.message)
      }
    },
    [],
  )

  // Only worth fetching once the provider can actually answer.
  useEffect(() => {
    setModels([])
    setModelError(null)
    if (state.local || state.hasKey) void loadModels(provider)
  }, [provider, state.local, state.hasKey, loadModels])

  // Optional, so it is reported quietly and never blocks the sheet.
  useEffect(() => {
    void window.tiro.getFerryStatus().then(setFerry)
  }, [])

  const lookForFerry = async (command?: string): Promise<void> => {
    setLookingForFerry(true)
    setFerry(
      command !== undefined
        ? await window.tiro.setFerryCommand(command)
        : await window.tiro.getFerryStatus(true),
    )
    setLookingForFerry(false)
  }

  const pickProvider = async (next: ProviderId): Promise<void> => {
    setError(null)
    setKey('')
    onState(await window.tiro.setProvider(next, ''))
  }

  const pickModel = async (model: string): Promise<void> => {
    onState(await window.tiro.setProvider(provider, model))
  }

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    setError(null)
    const result = await window.tiro.setApiKey(provider, key.trim())
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setKey('')
    onState(await window.tiro.getProviderState())
  }

  const saveHost = async (): Promise<void> => {
    onState(await window.tiro.setOllamaHost(host))
    void loadModels('ollama')
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <h3>Model</h3>
          <button type="button" className="sheet-close" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="seg" role="tablist" aria-label="Provider">
          {PROVIDERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={provider === entry.id}
              className={`seg-item${provider === entry.id ? ' is-on' : ''}`}
              onClick={() => void pickProvider(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <p className="sheet-copy">{PROVIDERS.find((e) => e.id === provider)?.note}</p>

        {state.local ? (
          <div className="field">
            <label className="field-label" htmlFor="ollama-host">
              Ollama host
            </label>
            <div className="field-row">
              <input
                id="ollama-host"
                className="sheet-input is-plain"
                value={host}
                spellCheck={false}
                onChange={(event) => setHost(event.target.value)}
                onBlur={() => void saveHost()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveHost()
                }}
              />
              <button type="button" className="button-ghost" onClick={() => void saveHost()}>
                Connect
              </button>
            </div>
            <p className="panel-note">
              Start it with <code>ollama serve</code>, then pull a long-context model — a whole
              paper is tens of thousands of tokens.
            </p>
          </div>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor="api-key">
              {label} API key
            </label>

            {state.keyUnreadable && (
              <p className="warn">
                A saved key is on disk but will not decrypt. macOS ties the keychain entry to the
                app's signature, so rebuilding or reinstalling an unsigned Tiro invalidates it.
                Enter the key again.
              </p>
            )}

            {state.keyFromEnv ? (
              <p className="sheet-status">
                Using <code>{KEY_ENV[provider]}</code> from the environment. That takes priority
                over a saved key.
              </p>
            ) : state.hasKey ? (
              <p className="sheet-status">A key is saved. Enter a new one to replace it.</p>
            ) : null}

            <div className="field-row">
              <input
                id="api-key"
                className="sheet-input"
                type="password"
                value={key}
                placeholder={KEY_HINT[provider]}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey()
                }}
              />
              <button
                type="button"
                className="button-primary"
                onClick={() => void saveKey()}
                disabled={busy || !key.trim()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>

            {!state.keyEncrypted && (
              <p className="warn">
                No OS keyring available, so the key is stored as a plain file readable only by your
                user. Install <code>gnome-keyring</code> or <code>kwallet</code> to have it
                encrypted.
              </p>
            )}

            {error && <p className="panel-error">{error}</p>}
          </div>
        )}

        <div className="field">
          <label className="field-label" htmlFor="model">
            Model
          </label>
          <div className="field-row">
            <select
              id="model"
              className="sheet-select"
              value={state.model}
              onChange={(event) => void pickModel(event.target.value)}
              disabled={loadingModels || (!state.local && !state.hasKey)}
            >
              <option value="">
                {loadingModels ? 'Loading…' : models.length ? 'Choose a model' : 'No models listed'}
              </option>
              {state.model && !models.some((m) => m.id === state.model) && (
                <option value={state.model}>{state.model}</option>
              )}
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id}
                  {option.detail ? ` — ${option.detail}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button-ghost"
              onClick={() => void loadModels(provider)}
              disabled={loadingModels || (!state.local && !state.hasKey)}
            >
              Refresh
            </button>
          </div>
          {modelError && <p className="panel-error">{modelError}</p>}
          {!state.local && !state.hasKey && (
            <p className="panel-note">Save a key first and the model list fills in.</p>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="ferry-path">
            Document index — optional
          </label>

          {ferry === null ? (
            <p className="panel-note">Checking…</p>
          ) : ferry.available ? (
            <p className="sheet-status">
              Found <code>{ferry.command}</code>
              {ferry.source === 'path' ? ' on PATH' : ` (${ferry.source})`} ·{' '}
              {ferry.tools.map((tool) => tool.name).join(', ')}. Long documents will be searched
              rather than sent whole.
            </p>
          ) : (
            <>
              <p className="panel-note">{ferry.reason}</p>
              {ferry.installed && ferry.otherTools.length > 0 && (
                <p className="panel-note">
                  It does expose {ferry.otherTools.join(', ')}, which Tiro leaves alone.
                </p>
              )}
            </>
          )}

          <div className="field-row">
            <input
              id="ferry-path"
              className="sheet-input is-plain"
              value={ferryPath}
              placeholder={ferry?.command ?? 'path to the ferry executable'}
              spellCheck={false}
              onChange={(event) => setFerryPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void lookForFerry(ferryPath)
              }}
            />
            <button
              type="button"
              className="button-ghost"
              disabled={lookingForFerry}
              onClick={() => void lookForFerry(ferryPath || undefined)}
            >
              {lookingForFerry ? 'Looking…' : 'Look again'}
            </button>
          </div>
          <p className="panel-note">
            Only used for documents long enough to warrant it — a textbook, not a paper. Tiro
            works the same without it.
          </p>
        </div>

        <div className="sheet-actions">
          {state.hasKey && !state.keyFromEnv && !state.local && (
            <button
              type="button"
              className="button-ghost is-danger"
              onClick={async () => onState(await window.tiro.clearApiKey(provider))}
            >
              Remove saved key
            </button>
          )}
          <span className="sheet-spacer" />
          <button type="button" className="button-primary" onClick={onClose}>
            Done
          </button>
        </div>

        <p className="panel-note">
          {state.local
            ? 'Local models never send the document anywhere. Expect weaker concept maps than a frontier model.'
            : 'Keys stay in the app process — the window never sees them, and they only leave in requests to the provider.'}
        </p>
      </div>
    </div>
  )
}
