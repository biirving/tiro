/**
 * Read-only tools over a linked repository.
 *
 * Not filesystem access. Every call is answered from the in-memory index built
 * by `scanRepo`, which only ever contains source files `git ls-files` reported
 * inside that one repository — so there is no path to escape, nothing outside
 * the repo is reachable, and nothing can be written.
 */

import { repoFor } from './match'

/** Provider-neutral; each provider maps this onto its own tool shape. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const MAX_MATCHES = 40
const MAX_READ_LINES = 400
const MAX_LISTED = 120

export const CODE_TOOLS: ToolSpec[] = [
  {
    name: 'search_code',
    description:
      'Search the linked repository for a literal string — an identifier, a phrase from a ' +
      'comment, anything. Case-insensitive. Returns matching lines with their file path and ' +
      'line number. Start here when you need to find where something lives.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find. Not a regular expression.' },
        limit: {
          type: 'integer',
          description: `Most matches to return, up to ${MAX_MATCHES}. Default 20.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read lines from a file in the linked repository. Use the path exactly as search_code ' +
      'reported it. Read a range around a match rather than a whole large file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path.' },
        start_line: { type: 'integer', description: '1-indexed. Defaults to the first line.' },
        end_line: { type: 'integer', description: `1-indexed. At most ${MAX_READ_LINES} lines.` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List source files in the linked repository, optionally filtered by a path fragment. ' +
      'Useful for getting your bearings before searching.',
    parameters: {
      type: 'object',
      properties: {
        contains: {
          type: 'string',
          description: 'Only paths containing this fragment. Omit for everything.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
]

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

/** A short line describing a call, shown to the reader while it runs. */
export function describeToolCall(name: string, input: unknown): string {
  const args = asRecord(input)
  switch (name) {
    case 'search_code':
      return `Searched the repository for “${str(args.query) ?? ''}”`
    case 'read_file': {
      const from = num(args.start_line)
      const to = num(args.end_line)
      const range = from && to ? ` ${from}–${to}` : ''
      return `Read ${str(args.path) ?? 'a file'}${range}`
    }
    case 'list_files':
      return str(args.contains)
        ? `Listed files matching “${str(args.contains)}”`
        : 'Listed the repository'
    default:
      return `Ran ${name}`
  }
}

export async function runCodeTool(
  repoPath: string,
  name: string,
  input: unknown,
): Promise<string> {
  const repo = await repoFor(repoPath)
  const args = asRecord(input)

  if (name === 'search_code') {
    const query = str(args.query)
    if (!query) return 'No query given.'
    const limit = Math.min(num(args.limit) ?? 20, MAX_MATCHES)
    const needle = query.toLowerCase()

    const hits: string[] = []
    for (const file of repo.files.values()) {
      if (!file.lowered.includes(needle)) continue
      for (let i = 0; i < file.lines.length && hits.length < limit; i++) {
        if (file.lines[i].toLowerCase().includes(needle)) {
          hits.push(`${file.path}:${i + 1}: ${file.lines[i].trim().slice(0, 200)}`)
        }
      }
      if (hits.length >= limit) break
    }
    return hits.length === 0
      ? `No match for "${query}" in ${repo.name}.`
      : `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}":\n${hits.join('\n')}`
  }

  if (name === 'read_file') {
    const path = str(args.path)
    if (!path) return 'No path given.'
    const file = repo.files.get(path)
    if (!file) {
      return `${path} is not an indexed source file in ${repo.name}. Use search_code or list_files to find the real path.`
    }
    const from = Math.max(1, num(args.start_line) ?? 1)
    const to = Math.min(file.lines.length, num(args.end_line) ?? from + MAX_READ_LINES - 1)
    const end = Math.min(to, from + MAX_READ_LINES - 1)
    const body = file.lines
      .slice(from - 1, end)
      .map((line, i) => `${from + i}: ${line}`)
      .join('\n')
    return `${path} lines ${from}-${end} of ${file.lines.length}:\n${body}`
  }

  if (name === 'list_files') {
    const contains = str(args.contains)?.toLowerCase()
    const paths = [...repo.files.keys()]
      .filter((path) => !contains || path.toLowerCase().includes(contains))
      .sort()
    const shown = paths.slice(0, MAX_LISTED)
    const more = paths.length - shown.length
    return shown.length === 0
      ? `No source files${contains ? ` matching "${contains}"` : ''} in ${repo.name}.`
      : `${paths.length} file${paths.length === 1 ? '' : 's'}:\n${shown.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}`
  }

  return `Unknown tool: ${name}`
}
