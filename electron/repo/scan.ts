/**
 * Indexing a repository, entirely on disk.
 *
 * Nothing here costs a token. The point is to narrow a repository down to a
 * handful of plausible locations per concept locally, so the model is only ever
 * asked to judge a shortlist — and so every path it returns is one that exists.
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { RepoLink } from '@shared/types'

const run = promisify(execFile)

/** Source we can meaningfully match against a paper. */
const SOURCE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.rs', '.go', '.java', '.kt', '.scala', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cu', '.cuh',
  '.m', '.jl', '.r', '.lua', '.sh',
])

/** Guards against indexing a monorepo or a directory full of checkpoints. */
const MAX_FILES = 2000
const MAX_FILE_BYTES = 400_000
const MAX_TOTAL_BYTES = 24_000_000

export type SymbolKind = 'function' | 'class' | 'type' | 'value'

export interface RepoSymbol {
  name: string
  path: string
  /** 1-indexed. */
  line: number
  kind: SymbolKind
}

export interface RepoFile {
  path: string
  lines: string[]
  /** Lowercased once, so term scanning does not re-lower per concept. */
  lowered: string
}

export interface ScannedRepo {
  root: string
  name: string
  files: Map<string, RepoFile>
  symbols: RepoSymbol[]
  scannedAt: number
}

/**
 * Declaration patterns, per language family. Deliberately shallow: this only
 * has to produce candidates, and a wrong guess costs nothing because the model
 * sees the surrounding code and can reject it.
 */
const DECLARATIONS: { test: RegExp; kind: SymbolKind }[] = [
  { test: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { test: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { test: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { test: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { test: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { test: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'value' },
  { test: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { test: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/, kind: 'type' },
  { test: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
  { test: /^type\s+([A-Za-z_]\w*)/, kind: 'type' },
  { test: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|record)\s+([A-Za-z_]\w*)/, kind: 'class' },
]

function symbolsIn(path: string, lines: string[]): RepoSymbol[] {
  const found: RepoSymbol[] = []
  lines.forEach((line, i) => {
    if (line.length > 400) return
    for (const { test, kind } of DECLARATIONS) {
      const match = test.exec(line)
      if (match?.[1]) {
        found.push({ name: match[1], path, line: i + 1, kind })
        break
      }
    }
  })
  return found
}

/**
 * The file list.
 *
 * `git ls-files` is exact and free: it honours .gitignore, skips submodule
 * contents, and never walks into node_modules or a virtualenv. Reimplementing
 * gitignore would be worse, so a non-git directory is reported as such instead.
 *
 * `--others --exclude-standard` adds files that are new and not yet committed.
 * Without them, work in progress — often exactly what you are reading a paper
 * to write — would be invisible to the search.
 */
async function listFiles(root: string): Promise<string[]> {
  const { stdout } = await run(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  return [...new Set(stdout.split('\0').filter(Boolean))]
}

export class NotARepoError extends Error {
  constructor(path: string) {
    super(
      `${basename(path)} is not a git repository. Tiro uses \`git ls-files\` to know which ` +
        `files are real source rather than build output or dependencies.`,
    )
    this.name = 'NotARepoError'
  }
}

export class EmptyRepoError extends Error {
  constructor() {
    super('No source files found in that repository.')
    this.name = 'EmptyRepoError'
  }
}

export async function scanRepo(root: string): Promise<ScannedRepo> {
  const absolute = resolve(root)

  let names: string[]
  try {
    names = await listFiles(absolute)
  } catch {
    throw new NotARepoError(absolute)
  }

  const files = new Map<string, RepoFile>()
  const symbols: RepoSymbol[] = []
  let totalBytes = 0

  for (const name of names) {
    if (files.size >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break
    if (!SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) continue

    const full = join(absolute, name)
    try {
      const info = await stat(full)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      totalBytes += info.size

      const text = await readFile(full, 'utf8')
      const lines = text.split('\n')
      files.set(name, { path: name, lines, lowered: text.toLowerCase() })
      symbols.push(...symbolsIn(name, lines))
    } catch {
      // Unreadable or vanished between listing and reading; skip it.
    }
  }

  if (files.size === 0) throw new EmptyRepoError()

  return { root: absolute, name: basename(absolute), files, symbols, scannedAt: Date.now() }
}

export function describeRepo(repo: ScannedRepo): RepoLink {
  return { path: repo.root, name: repo.name, fileCount: repo.files.size }
}

/**
 * Resolves a repo-relative path, refusing anything that climbs out of the root.
 * The renderer only ever sends relative paths, but it is not the boundary.
 */
export function resolveInside(root: string, relativePath: string): string | null {
  const full = resolve(root, relativePath)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel.startsWith(sep) || resolve(rel) === rel) return null
  return full
}
