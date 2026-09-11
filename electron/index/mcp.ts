/**
 * A minimal MCP client over stdio.
 *
 * One line of JSON-RPC per message on stdin, one per response on stdout, with
 * stderr reserved for the server's own logs — the transport ferry's MCP server
 * speaks. Only what Tiro needs: initialize, tools/list, tools/call.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const PROTOCOL_VERSION = '2024-11-05'

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private exited: string | null = null

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {},
  ) {}

  /** Spawns the server and completes the handshake. Rejects if either fails. */
  async start(timeoutMs = 8000): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.absorb(chunk))

    // The server's diagnostics, kept off the protocol pipe by design.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (process.env.TIRO_DEBUG === '1') process.stderr.write(`[mcp] ${chunk}`)
    })

    child.on('error', (error) => this.fail(`could not start: ${error.message}`))
    child.on('exit', (code, signal) =>
      this.fail(`exited (${signal ?? `code ${code}`})`),
    )

    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'tiro', version: '0.1.0' },
      },
      timeoutMs,
    )
    this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[]
    }
    return (result.tools ?? [])
      .filter((tool): tool is McpTool & { name: string } => Boolean(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      }))
  }

  /** Calls a tool and flattens the reply to text, which is all Tiro passes on. */
  async callTool(name: string, args: unknown, timeoutMs = 60_000): Promise<string> {
    const result = (await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      timeoutMs,
    )) as { content?: { type?: string; text?: string }[]; isError?: boolean }

    const text = (result.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()

    if (result.isError) return `That lookup failed: ${text || 'no detail given'}`
    return text || '(no result)'
  }

  stop(): void {
    this.fail('stopped')
    this.child?.kill()
    this.child = null
  }

  get running(): boolean {
    return this.child !== null && this.exited === null
  }

  private absorb(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line) this.dispatch(line)
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      // A server that writes anything but JSON-RPC to stdout is not one we
      // can talk to; ignore the line rather than tearing down the session.
      return
    }
    if (typeof message.id !== 'number') return

    const waiting = this.pending.get(message.id)
    if (!waiting) return
    this.pending.delete(message.id)
    clearTimeout(waiting.timer)

    if (message.error) waiting.reject(new Error(message.error.message ?? 'MCP error'))
    else waiting.resolve(message.result)
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.child
    if (!child || this.exited) {
      return Promise.reject(new Error(this.exited ?? 'not started'))
    }
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** Rejects everything outstanding once the server is gone. */
  private fail(reason: string): void {
    if (this.exited) return
    this.exited = reason
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(`MCP server ${reason}`))
    }
    this.pending.clear()
  }
}
