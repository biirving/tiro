/**
 * The tools available for one question.
 *
 * Assembled per request from whatever happens to be present: the repository
 * tools when a repo is linked, ferry's document tools when ferry is installed.
 * Nothing here is required — with neither, the list is empty and the providers
 * send no tools at all, which is exactly how Tiro behaved before either existed.
 */

import type { AskRequest, McpToolSpec } from '@shared/types'
import { estimateTokens, type StoredDoc } from '../docs'
import { ferryStatus, ferryTools, runFerryTool } from '../index/ferry'
import { CODE_TOOLS, describeToolCall, runCodeTool } from '../repo/tools'
import { REPO_GUIDE } from '../providers/prompts'

export interface ToolBundle {
  specs: McpToolSpec[]
  /** Extra guidance for the system prefix, empty when there are no tools. */
  guide: string
  run(name: string, input: unknown): Promise<string>
  describe(name: string, input: unknown): string
}

const EMPTY: ToolBundle = {
  specs: [],
  guide: '',
  run: async () => 'No tools are available.',
  describe: (name) => `Ran ${name}`,
}

export const INDEX_GUIDE = `A search index over this document is available, which matters for anything long enough that reading it end to end is not the point.

- Use it to find where something is treated, then read those pages. It returns passages with their page numbers, so cite them as [p. 12] like anything else.
- The index is one view of the document, not a replacement for it. When the passage you are given is not enough, read around it.`

function describeIndexCall(name: string, input: unknown): string {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const query = typeof args.query === 'string' ? args.query : null
  return query ? `Searched the index for “${query}”` : `Ran ${name}`
}

/**
 * Below this, whole-document context is both better and cheaper, so the index
 * stays out of the way. Tool definitions render ahead of the system prompt, so
 * adding them to a short paper would buy a second cache entry for nothing.
 * Roughly 150 dense pages.
 */
const INDEX_FROM_TOKENS = 120_000

export async function toolsFor(request: AskRequest, doc: StoredDoc): Promise<ToolBundle> {
  const repo = Boolean(request.repoPath)
  const longEnough = estimateTokens(doc.text.length) >= INDEX_FROM_TOKENS
  // Only probed for a document long enough to want it. Absence costs one
  // cached lookup and never throws.
  const index = longEnough ? await ferryStatus() : { available: false as const }

  const fromIndex = index.available ? await ferryTools() : []
  if (!repo && fromIndex.length === 0) return EMPTY

  const specs: McpToolSpec[] = [
    ...(repo ? CODE_TOOLS.map((tool) => ({ ...tool })) : []),
    ...fromIndex,
  ]
  const indexNames = new Set(fromIndex.map((tool) => tool.name))
  const guide = [repo ? REPO_GUIDE : '', fromIndex.length > 0 ? INDEX_GUIDE : '']
    .filter(Boolean)
    .join('\n\n')

  return {
    specs,
    guide,
    async run(name, input) {
      if (indexNames.has(name)) return runFerryTool(name, input)
      if (request.repoPath) return runCodeTool(request.repoPath, name, input)
      return `Unknown tool: ${name}`
    },
    describe(name, input) {
      return indexNames.has(name) ? describeIndexCall(name, input) : describeToolCall(name, input)
    },
  }
}
