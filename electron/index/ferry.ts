/**
 * Ferry, if it happens to be installed.
 *
 * Every path here treats absence as an ordinary outcome, never an error: Tiro
 * behaves identically with no ferry on the machine, and the document index is
 * simply a capability that did not turn up. Nothing probes at startup in a way
 * that can block, and a probe that fails is cached as "not available" rather
 * than retried into a stall.
 */

import type { FerryStatus, McpToolSpec } from '@shared/types'
import { McpClient, type McpTool } from './mcp'
import { ferryCommand as savedCommand } from '../settings'

/** Long enough for a cold Python start, short enough not to hold anything up. */
const PROBE_TIMEOUT_MS = 12_000

interface Session {
  client: McpClient
  command: string
  source: FerryStatus['source']
  tools: McpTool[]
}

let session: Session | null = null
let status: FerryStatus | null = null
let probing: Promise<FerryStatus> | null = null

/**
 * How to launch it, most explicit first.
 *
 * Installing ferry (`pip install -e path/to/ferry`) puts a `ferry` binary on
 * PATH, which is the ordinary case. A sibling checkout is deliberately not
 * guessed at: running it needs a Python 3.12 environment with its dependencies,
 * and silently picking the wrong interpreter is worse than reporting nothing.
 */
function candidates(): { command: string; args: string[]; source: FerryStatus['source'] }[] {
  const found: { command: string; args: string[]; source: FerryStatus['source'] }[] = []

  const override = process.env.TIRO_FERRY_COMMAND?.trim()
  if (override) {
    const [command, ...args] = override.split(/\s+/)
    found.push({ command, args: [...args, 'serve'], source: 'environment' })
  }

  const configured = savedCommand()
  if (configured) found.push({ command: configured, args: ['serve'], source: 'setting' })

  found.push({ command: 'ferry', args: ['serve'], source: 'path' })
  return found
}

/**
 * Which of ferry's tools reach a model, by name.
 *
 * An allowlist rather than a prefix, because the first version forwarded
 * everything advertised — and ferry's own surface is agent memory (remember,
 * recall, persona, forget), which would have been handed to a model under a
 * prompt announcing "a search index over this document". Naming them costs a
 * one-line change when ferry gains a tool, and is worth it.
 */
const MODEL_TOOLS = new Set(['doc_search', 'doc_read_pages', 'code_search'])

/** Called by Tiro itself, never offered to a model — these write the index. */
const INDEX_TOOL = 'doc_index'
const STATUS_TOOL = 'doc_status'

const isModelTool = (name: string): boolean => MODEL_TOOLS.has(name)

function unavailable(reason: string): FerryStatus {
  return {
    installed: false,
    available: false,
    canIndex: false,
    source: 'none',
    command: null,
    reason,
    tools: [],
    otherTools: [],
  }
}

async function probe(): Promise<FerryStatus> {
  for (const candidate of candidates()) {
    const client = new McpClient(candidate.command, candidate.args)
    try {
      await client.start(PROBE_TIMEOUT_MS)
      const advertised = await client.listTools()
      const docTools = advertised.filter((tool) => isModelTool(tool.name))
      const names = new Set(advertised.map((tool) => tool.name))
      session = { client, command: candidate.command, source: candidate.source, tools: docTools }

      return {
        installed: true,
        available: docTools.length > 0,
        source: candidate.source,
        command: candidate.command,
        canIndex: names.has(INDEX_TOOL),
        reason:
          docTools.length > 0
            ? null
            : 'Found ferry, but it exposes no search tools, so there is no index to ' +
              'query. Tiro works the same without one.',
        tools: docTools.map((tool) => ({ name: tool.name, description: tool.description })),
        otherTools: advertised
          .filter((tool) => !isModelTool(tool.name))
          .map((tool) => tool.name),
      }
    } catch {
      // Not there, or not speaking MCP. Try the next candidate.
      client.stop()
    }
  }
  return unavailable(
    'No ferry found. Install it (`pip install -e path/to/ferry`) to index long documents; ' +
      'everything else in Tiro works without it.',
  )
}

/** The cached answer, probing at most once unless asked to look again. */
export async function ferryStatus(refresh = false): Promise<FerryStatus> {
  if (refresh) {
    session?.client.stop()
    session = null
    status = null
    probing = null
  }
  if (status) return status
  if (!probing) {
    probing = probe()
      .then((result) => {
        status = result
        return result
      })
      .catch(() => {
        // A probe must never throw into the caller.
        status = unavailable('Could not probe for ferry.')
        return status
      })
  }
  return probing
}

/** The tools ferry advertises, or none. Tiro forwards whatever it finds. */
export async function ferryTools(): Promise<McpToolSpec[]> {
  const current = await ferryStatus()
  if (!current.available || !session) return []
  return session.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }))
}

export async function runFerryTool(name: string, input: unknown): Promise<string> {
  const current = await ferryStatus()
  if (!current.available || !session) {
    return 'The document index is not available on this machine.'
  }
  if (!session.client.running) {
    // The server died mid-session; report it plainly and re-probe next time.
    status = null
    session = null
    return 'The document index stopped responding. It will be retried on the next question.'
  }
  try {
    return await session.client.callTool(name, input)
  } catch (error) {
    return `That lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`
  }
}

export interface IndexProgress {
  done: number
  total: number
}

/** How many passages go in one call. Small enough to report progress against. */
const BATCH = 120

/**
 * Sends passages to ferry in batches.
 *
 * `first` clears whatever was indexed for this scope, so re-indexing replaces
 * rather than duplicates; `last` tells ferry to build and flush. Returns null
 * on success, or a message worth showing.
 */
export async function indexPassages(
  scopeId: string,
  title: string,
  kind: 'document' | 'code',
  passages: Record<string, unknown>[],
  onProgress: (progress: IndexProgress) => void,
): Promise<string | null> {
  const current = await ferryStatus()
  if (!current.available || !current.canIndex || !session) {
    return 'No document index is available on this machine.'
  }

  const total = passages.length
  if (total === 0) return 'There was nothing to index in this document.'

  for (let at = 0; at < total; at += BATCH) {
    const batch = passages.slice(at, at + BATCH)
    const reply = await session.client.callTool(
      INDEX_TOOL,
      {
        scope_id: scopeId,
        title,
        kind,
        first: at === 0,
        last: at + batch.length >= total,
        passages: batch,
      },
      120_000,
    )
    if (reply.startsWith('That lookup failed')) return reply
    onProgress({ done: Math.min(at + batch.length, total), total })
  }
  return null
}

export interface IndexedScope {
  indexed: boolean
  passages: number
}

/** Asks ferry what it holds, rather than Tiro remembering and being wrong. */
export async function indexedScope(scopeId: string): Promise<IndexedScope> {
  const current = await ferryStatus()
  if (!current.available || !session) return { indexed: false, passages: 0 }
  try {
    const reply = await session.client.callTool(STATUS_TOOL, { scope_id: scopeId }, 15_000)
    const parsed = JSON.parse(reply) as { indexed?: boolean; passages?: number }
    return { indexed: Boolean(parsed.indexed), passages: Number(parsed.passages ?? 0) }
  } catch {
    // An older ferry, or no status tool: treat as not indexed rather than fail.
    return { indexed: false, passages: 0 }
  }
}

export function shutdownFerry(): void {
  session?.client.stop()
  session = null
}
