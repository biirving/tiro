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
 * Tiro forwards document tools and nothing else.
 *
 * Ferry's own surface is agent memory — remember, recall, persona, forget —
 * which has nothing to do with reading a textbook. Forwarding those to a model
 * under a prompt announcing "a search index over this document" would be a lie
 * the model then acts on, so the index counts as usable only when tools under
 * this prefix are actually present.
 */
const DOC_TOOL_PREFIX = 'doc_'

const isDocTool = (name: string): boolean => name.startsWith(DOC_TOOL_PREFIX)

function unavailable(reason: string): FerryStatus {
  return {
    installed: false,
    available: false,
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
      const docTools = advertised.filter((tool) => isDocTool(tool.name))
      session = { client, command: candidate.command, source: candidate.source, tools: docTools }

      return {
        installed: true,
        available: docTools.length > 0,
        source: candidate.source,
        command: candidate.command,
        reason:
          docTools.length > 0
            ? null
            : `Found ferry, but it exposes no ${DOC_TOOL_PREFIX}* tools, so there is no ` +
              'document index to search. Tiro works the same without one.',
        tools: docTools.map((tool) => ({ name: tool.name, description: tool.description })),
        otherTools: advertised
          .filter((tool) => !isDocTool(tool.name))
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

export function shutdownFerry(): void {
  session?.client.stop()
  session = null
}
