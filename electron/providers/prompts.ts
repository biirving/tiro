/**
 * The prompts, shared by every provider.
 *
 * Two rules hold across all of them. The document goes last in the prefix and
 * never changes byte for byte, so prefix caching can work — explicit breakpoints
 * on Anthropic, automatic prefix caching on OpenAI, KV reuse on a local model.
 * And whatever the reader is asking for goes in the user turn, never up here.
 */

import * as z from 'zod'
import type { AskRequest, Concept } from '@shared/types'
import type { StoredDoc } from '../docs'

export const GUIDE = `You are the reading companion built into Tiro, a PDF reader. Someone is reading the document below and asking about it as they go. They are mid-page and do not want to go hunting.

Ground every answer in this document.

- Cite pages inline as [p. 12]. Those render as links the reader can click, so cite the page where the thing actually is.
- When the document defines a term, use its definition, not the textbook one. When it doesn't, say so in a clause and then give the standard meaning.
- Lead with the answer. No preamble, no restating the question, no praise for the question.
- Plain prose in short paragraphs. A list only when the content is genuinely a list.
- Write every symbol, variable, and equation as LaTeX: $x_t$ inline, $$...$$ for a display equation. It is rendered, so never describe math in words that the notation says better.
- For notation, say what each symbol stands for in this document's usage.
- If the answer is not in the document, say that in one sentence and stop. Do not fill the gap with plausible detail.
- Refer to it as the paper, the document, or by its title — never "the provided text" or "the context".`

export function documentBlock(doc: StoredDoc): string {
  return `<document title="${doc.title}" pages="${doc.pages.length}">\n${doc.text}\n</document>`
}

function quote(text: string, page: number): string {
  return `The reader has this selected on page ${page}:\n\n<selection>\n${text.trim()}\n</selection>`
}

/** The whole of what varies between requests. */
export function userTurn(request: AskRequest): string {
  const { mode, question, selection } = request

  switch (mode) {
    case 'define':
      return `${quote(selection?.text ?? '', selection?.page ?? 1)}

Define the key term in that selection as this document uses it, in two or three sentences. Cite the page where the document establishes it. If the document never defines it, say so first, then give the standard meaning in one sentence.`

    case 'explain':
      return `${quote(selection?.text ?? '', selection?.page ?? 1)}

Explain that passage in plain language, under 120 words. Name what it depends on from earlier in the document and cite those pages. If it rests on a term the reader had to pick up earlier, define that term in a clause so they don't have to go back.`

    case 'deeper':
      return `Go deeper on "${question}" as this document treats it: where it does the real work, how it connects to the rest of the argument, and what a careful reader should watch for. Under 200 words, with page citations.`

    case 'chat':
      return selection ? `${quote(selection.text, selection.page)}\n\n${question}` : question
  }
}

export const CONCEPTS_TASK = `Read the whole document and pull out what a reader has to hold in their head to follow it.

Include:
- terms the document defines and then leans on
- methods, models, or datasets that later sections assume
- the central claims it argues for
- notation and symbols that carry meaning
- named entities — people, systems, prior work — that recur and matter

Leave out anything a reader could skip without losing the thread, and background the document only mentions in passing. Aim for 12 to 30 entries; go past that only for a genuinely dense document.

The reader will use this as a reference while scrolling, so every definition has to stand on its own without the surrounding page.

Order the entries the way the document first introduces them.`

const ConceptSchema = z.object({
  term: z
    .string()
    .describe('The term exactly as the document writes it, so it can be found on the page.'),
  definition: z
    .string()
    .describe("One or two sentences, in this document's sense of the term. No hedging."),
  significance: z.string().describe('One sentence on what the reader loses by forgetting it.'),
  kind: z.enum(['term', 'method', 'claim', 'notation', 'entity']),
  firstPage: z.number().int().describe('1-indexed page where the document establishes it.'),
  pages: z
    .array(z.number().int())
    .describe('Every 1-indexed page where it is used in a load-bearing way.'),
})

export const ConceptsSchema = z.object({
  concepts: z.array(ConceptSchema),
})

/** The same shape as JSON Schema, for providers that take one directly. */
export function conceptsJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ConceptsSchema) as Record<string, unknown>
  delete schema.$schema
  return schema
}

export type ParsedConcepts = z.infer<typeof ConceptsSchema>

/** Trusts nothing: clamps pages into range and drops empty entries. */
export function normalizeConcepts(parsed: ParsedConcepts, pageCount: number): Concept[] {
  const clamp = (page: number) => Math.min(Math.max(Math.round(page), 1), pageCount)

  return parsed.concepts
    .filter((concept) => concept.term.trim().length > 0)
    .map((concept, i) => ({
      ...concept,
      id: `c${i}-${concept.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      firstPage: clamp(concept.firstPage),
      pages: [...new Set(concept.pages.map(clamp))].sort((a, b) => a - b),
    }))
}

/**
 * Pulls the JSON object out of a model's reply.
 *
 * Anthropic and OpenAI both guarantee schema-valid JSON, but a local model asked
 * for JSON may still wrap it in prose or a code fence.
 */
export function parseConceptsReply(raw: string, pageCount: number): Concept[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidate = (fenced?.[1] ?? raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('The model did not return JSON. Try a larger or instruction-tuned model.')
  }

  let json: unknown
  try {
    json = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    throw new Error('The model returned malformed JSON. Try again, or use a larger model.')
  }

  const result = ConceptsSchema.safeParse(json)
  if (!result.success) {
    throw new Error(
      'The model returned JSON that does not match the concept shape. Try a larger model.',
    )
  }
  return normalizeConcepts(result.data, pageCount)
}
