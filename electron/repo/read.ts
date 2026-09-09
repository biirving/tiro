import { readFile } from 'node:fs/promises'
import type { CodeFile } from '@shared/types'
import { repoFor } from './match'
import { resolveInside } from './scan'

/** Long enough for any real source file; a guard against a generated monster. */
const MAX_LINES = 6000

/**
 * Reads one file out of a linked repository.
 *
 * Served from the in-memory index where possible. Anything else is resolved
 * against the repository root and refused if it climbs out — the renderer only
 * ever sends relative paths, but it is not the security boundary.
 */
export async function readCode(repoPath: string, filePath: string): Promise<CodeFile> {
  const repo = await repoFor(repoPath)

  const indexed = repo.files.get(filePath)
  if (indexed) {
    const truncated = indexed.lines.length > MAX_LINES
    return {
      path: filePath,
      content: (truncated ? indexed.lines.slice(0, MAX_LINES) : indexed.lines).join('\n'),
      lineCount: indexed.lines.length,
      truncated,
    }
  }

  const full = resolveInside(repo.root, filePath)
  if (!full) throw new Error('That path is outside the linked repository.')

  const text = await readFile(full, 'utf8')
  const lines = text.split('\n')
  const truncated = lines.length > MAX_LINES
  return {
    path: filePath,
    content: (truncated ? lines.slice(0, MAX_LINES) : lines).join('\n'),
    lineCount: lines.length,
    truncated,
  }
}
