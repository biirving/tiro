/**
 * Provider choice, model choice, and API keys.
 *
 * Keys are encrypted with the OS keyring via `safeStorage` and written to the
 * app's own userData directory. They never reach the renderer — the window only
 * learns whether a key is present, and whether it could be encrypted.
 */

import { app, safeStorage } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProviderId } from '@shared/types'

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434'

/** Anthropic has one obvious answer; the other two are picked from a live list. */
const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: '',
  ollama: '',
}

const ENV_KEYS: Record<ProviderId, string | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: null,
}

export const PROVIDERS_WITHOUT_KEYS: ProviderId[] = ['ollama']

interface StoredSettings {
  provider: ProviderId
  /** Remembered per provider, so switching back and forth keeps your choice. */
  models: Partial<Record<ProviderId, string>>
  ollamaHost: string
}

const defaults = (): StoredSettings => ({
  provider: 'anthropic',
  models: { ...DEFAULT_MODELS },
  ollamaHost: DEFAULT_OLLAMA_HOST,
})

const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const keyFile = (provider: ProviderId) =>
  join(app.getPath('userData'), 'keys', `${provider}.bin`)

/** Where the single-provider build kept the Anthropic key. */
const legacyKeyFile = () => join(app.getPath('userData'), 'anthropic-key.bin')

/**
 * Moves a key written by the pre-multi-provider build into the per-provider
 * store. Without this the key is still on disk but nothing looks for it, and the
 * app reports "no key" to someone who definitely saved one.
 */
function migrateLegacyKey(provider: ProviderId): void {
  if (provider !== 'anthropic') return
  const target = keyFile(provider)
  const legacy = legacyKeyFile()
  if (existsSync(target) || !existsSync(legacy)) return

  try {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(legacy, target)
    rmSync(legacy, { force: true })
    console.log('[tiro] moved a previously saved Anthropic key into the per-provider key store')
  } catch (error) {
    console.error(
      `[tiro] could not migrate the legacy key file: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

let cache: StoredSettings | null = null

export function settings(): StoredSettings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSettings>
    cache = {
      ...defaults(),
      ...parsed,
      models: { ...DEFAULT_MODELS, ...(parsed.models ?? {}) },
    }
  } catch {
    cache = defaults()
  }
  return cache
}

function persist(next: StoredSettings): void {
  cache = next
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
}

export function activeProvider(): ProviderId {
  return settings().provider
}

export function activeModel(provider: ProviderId = activeProvider()): string {
  return settings().models[provider]?.trim() ?? ''
}

export function ollamaHost(): string {
  return settings().ollamaHost.replace(/\/+$/, '') || DEFAULT_OLLAMA_HOST
}

export function setProvider(provider: ProviderId, model: string): void {
  const current = settings()
  persist({
    ...current,
    provider,
    models: { ...current.models, [provider]: model.trim() },
  })
}

export function setOllamaHost(host: string): void {
  const trimmed = host.trim().replace(/\/+$/, '')
  persist({ ...settings(), ollamaHost: trimmed || DEFAULT_OLLAMA_HOST })
}

function envKey(provider: ProviderId): string | undefined {
  const name = ENV_KEYS[provider]
  if (!name) return undefined
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

/**
 * `unreadable` means a key file is on disk but will not decrypt. On macOS the
 * keychain entry is bound to the app's code signature, so an unsigned rebuild
 * or reinstall invalidates it. Reporting that as "no key" sends people in
 * circles re-entering one, so it gets its own state.
 */
export type KeyStatus = 'none' | 'saved' | 'environment' | 'unreadable'

const unreadable = new Set<ProviderId>()

export function getApiKey(provider: ProviderId = activeProvider()): string | undefined {
  const fromEnv = envKey(provider)
  if (fromEnv) return fromEnv

  migrateLegacyKey(provider)
  const file = keyFile(provider)
  if (!existsSync(file)) {
    unreadable.delete(provider)
    return undefined
  }
  try {
    const raw = readFileSync(file)
    const key = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    unreadable.delete(provider)
    return key.trim() || undefined
  } catch (error) {
    unreadable.add(provider)
    console.error(
      `[tiro] a saved ${provider} key could not be decrypted: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

export function keyStatus(provider: ProviderId): KeyStatus {
  if (envKey(provider)) return 'environment'
  migrateLegacyKey(provider)
  const present = existsSync(keyFile(provider))
  if (!present) return 'none'
  // Force a read so the unreadable flag reflects the current signature.
  const key = getApiKey(provider)
  if (key) return 'saved'
  return unreadable.has(provider) ? 'unreadable' : 'none'
}

export function setApiKey(provider: ProviderId, key: string): void {
  const file = keyFile(provider)
  mkdirSync(dirname(file), { recursive: true })
  const trimmed = key.trim()
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  writeFileSync(file, payload, { mode: 0o600 })
}

export function clearApiKey(provider: ProviderId): void {
  rmSync(keyFile(provider), { force: true })
  unreadable.delete(provider)
}

/**
 * Whether the OS keyring is usable. False on a Linux box with no keyring
 * daemon (gnome-keyring, kwallet), where keys fall back to plain text.
 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function keySourceIsEnv(provider: ProviderId): boolean {
  return Boolean(envKey(provider))
}
