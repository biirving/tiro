/**
 * Matching the concepts of a paper to the code that implements them.
 *
 * The repository is searched locally and for free; the model is only asked to
 * judge a shortlist. It answers with candidate ids, never paths, so every
 * location that reaches the reader is one the scan actually found on disk.
 */

import type { Concept, ConceptCode, CodeLocation } from '@shared/types'
import { CodeMatchSchema, codeTaskFor, type ConceptBlock } from '../providers/prompts'
import { runStructured } from '../providers'
import { candidatesFor, type Candidate } from './candidates'
import { describeRepo, scanRepo, type ScannedRepo } from './scan'

/** Ceiling on how much code goes into one request, in lines. */
const MAX_CANDIDATE_LINES = 5000
const MAX_CANDIDATES_PER_CONCEPT = 5

const scans = new Map<string, ScannedRepo>()

/** Rescans when the cached index is older than this, so edits show up. */
const SCAN_TTL_MS = 5 * 60 * 1000

export async function repoFor(path: string): Promise<ScannedRepo> {
  const cached = scans.get(path)
  if (cached && Date.now() - cached.scannedAt < SCAN_TTL_MS) return cached

  const scanned = await scanRepo(path)
  scans.set(path, scanned)
  return scanned
}

export async function linkRepo(path: string) {
  return describeRepo(await repoFor(path))
}

export async function matchCode(
  docId: string,
  repoPath: string,
  concepts: Concept[],
): Promise<ConceptCode[]> {
  const repo = await repoFor(repoPath)

  // Build the shortlists locally. Nothing here costs anything.
  const lookup = new Map<string, Candidate>()
  const blocks: ConceptBlock[] = []
  let lines = 0
  let next = 0

  for (const concept of concepts) {
    const candidates = candidatesFor(repo, concept, MAX_CANDIDATES_PER_CONCEPT)
    const kept: ConceptBlock['candidates'] = []

    for (const candidate of candidates) {
      const size = candidate.endLine - candidate.startLine + 1
      if (lines + size > MAX_CANDIDATE_LINES) break
      lines += size

      const id = `k${next++}`
      lookup.set(id, candidate)
      kept.push({
        id,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        symbol: candidate.symbol,
        code: candidate.code,
      })
    }

    if (kept.length > 0) {
      blocks.push({
        id: concept.id,
        term: concept.term,
        definition: concept.definition,
        candidates: kept,
      })
    }
  }

  // Nothing plausible turned up, so there is nothing worth asking about.
  if (blocks.length === 0) return []

  const parsed = await runStructured(`code:${docId}`, docId, {
    label: 'code',
    user: codeTaskFor(repo.name, blocks),
    schema: CodeMatchSchema,
    maxTokens: 12000,
  })

  const known = new Set(concepts.map((concept) => concept.id))
  const matched: ConceptCode[] = []

  for (const match of parsed.matches) {
    if (!known.has(match.conceptId)) continue

    const locations: CodeLocation[] = []
    for (const picked of match.locations.slice(0, 3)) {
      const candidate = lookup.get(picked.candidateId)
      // An id we did not issue is simply dropped; there is no path to invent.
      if (!candidate) continue
      locations.push({
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        symbol: candidate.symbol,
        reason: picked.reason,
        snippet: candidate.code,
      })
    }
    if (locations.length > 0) matched.push({ conceptId: match.conceptId, locations })
  }

  return matched
}
