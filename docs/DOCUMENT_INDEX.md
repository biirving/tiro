# The document index — handoff

Tiro can hand a document or a repository to an external index and then let a
model search it, instead of carrying the whole thing in context. **Tiro's half is
built and tested. Ferry's half does not exist yet.** This document is everything
needed to write it.

Read it as a contract plus the reasoning behind it — several decisions here look
arbitrary and are not, and one of them would silently corrupt the graph if
reversed.

---

## 1. Why this exists

A 686-page textbook (Nocedal & Wright, *Numerical Optimization*) measures
**377,578 tokens**. It fits in a 1M context window. The problem is not capacity:

| | cost |
|---|---|
| cold cache write (1h TTL, 2×) | **$3.78** |
| every question after, cached (0.1×) | **$0.19** |
| a 24-page paper, cached | **$0.01** |

Twenty times a paper, per question, and it never improves. The fix is to search
the document and read what matters, rather than send it whole.

---

## 2. What is already done (Tiro side)

All of this is written, typechecked, and verified end to end against a stand-in
MCP server.

| Piece | File | State |
|---|---|---|
| MCP stdio client | `electron/index/mcp.ts` | works — `initialize`, `tools/list`, `tools/call` |
| Discovery, lifecycle, status | `electron/index/ferry.ts` | works — absent in ~4ms, never throws |
| Chunking, prose and code | `electron/index/chunks.ts` | works — unit-tested |
| Per-request tool assembly | `electron/tools/registry.ts` | works |
| Index buttons + progress | `IndexRow.tsx`, `AskTab.tsx`, `CodeTab.tsx` | works |
| Tool loop in both providers | `providers/anthropic.ts`, `openai.ts` | works — 24 rounds, graceful wrap-up |

Measured against real inputs:

```
smolVLA.pdf  (24 pages)  ->    83 passages, pages 1-24, avg 1174 chars, max 1400
this repo    (47 files)  -> 1,176 passages, 95% named for their declaration
ferry absent             -> unavailable in 4ms, no UI trace of indexing anywhere
```

---

## 3. What is missing (ferry side)

Ferry indexes text today — `Ferry.remember()` embeds a string and puts it in the
fluffy graph, exposed over MCP as `ferry_remember`. That path cannot be reused
here, for four reasons:

1. **No slot for provenance.** The signature is
   `remember(turn: str, *, user_text=None, occurred_at=None)`. Grepping
   `client.py` for `attributes|metadata|page|doc_id` finds one unrelated comment.
   A passage goes in and comes back with no way to say *page 12 of smolVLA.pdf*,
   which kills Tiro's `[p. 12]` citation contract at the boundary.
2. **It is chat-shaped.** A Fact is built by *LLM extraction* — "LLM extraction →
   embed → dedup/version". Running 83 paper passages through that produces
   distilled personal facts, plus an LLM call per batch. Wrong output, real cost.
3. **Retrieval returns memory, not passages.** `recall()` hands back
   `persona` / `facts` / `transcript`, not "three passages and their pages".
4. **Scoping is per-person** — `user_id`, `chat_id`, `project_id`. Nothing is
   document-shaped.

What is needed is a path that takes *(text + attributes)* and returns
*(text + attributes)* with no distillation in between. The engine one layer down
already does exactly that; only ferry's memory framing has no slot for it.

> **Naming.** Earlier drafts called this a "DocumentStore", by analogy to
> `FactStore` / `TranscriptStore`. All three names are fiction: the real class is
> `MemoryStore`, and the other two survive only in the README and two comments
> marked *legacy*. Call the new thing whatever fits; only the tool contract below
> is fixed, because Tiro already speaks it.

---

## 4. The tool contract

Four tools. Two are called by Tiro, two are offered to the model — and Tiro
**never** forwards the management pair, so a model cannot rewrite the index.

### `doc_index` — called by Tiro

Sent in batches of **120 passages**.

```jsonc
{
  "scope_id": "/Users/me/Downloads/smolVLA.pdf",  // absolute path; also the repo path for code
  "title": "SmolVLA: A Vision-Language-Action Model…",
  "kind": "document",   // or "code"
  "first": true,        // clear anything already held for this scope
  "last": false,        // build indexes and flush
  "passages": [ /* see below */ ]
}
```

Document passage:

```jsonc
{ "id": "<scope_id>#p3#17", "page": 3, "text": "…" }
```

Code passage:

```jsonc
{
  "id": "<scope_id>#renderer/src/App.tsx#120",
  "path": "renderer/src/App.tsx",
  "start_line": 120,
  "end_line": 158,
  "symbol": "openFile",     // "" when the chunk is a file preamble or a window
  "text": "…"
}
```

`first` and `last` make re-indexing replace rather than duplicate. Reply text is
ignored unless it begins with `That lookup failed`, which surfaces as an error.

### `doc_status` — called by Tiro

`{ "scope_id": "…" }` → **a JSON string** Tiro parses:

```json
{ "indexed": true, "passages": 83 }
```

Anything unparseable is treated as *not indexed* rather than as a failure, so an
older ferry degrades quietly.

### `doc_search` — offered to the model

Must return passages **with their provenance** — page for documents,
`path:line` for code — or citations break. Text reply; shape is yours.

### `doc_read_pages` — offered to the model

Read a page range back out.

`code_search` is also on Tiro's allowlist if you want code retrieval separate
from prose.

### Adding a tool

`MODEL_TOOLS` in `electron/index/ferry.ts` is an **allowlist**, not a prefix
match. This is deliberate: the first version forwarded everything `tools/list`
advertised, which meant a model would have been handed `ferry_remember` and
`ferry_recall` under a system prompt announcing *"a search index over this
document is available"* — a lie it would then act on. Adding a tool is a
one-line change there, and worth the friction.

---

## 5. The engine

`MemoryGraphManager`, from the vendored `.so` in `ferry/src/ferry/native/`.
Verified loading on macOS arm64; it is ABI-locked to **Python 3.12**
(`uv python install 3.12`).

```python
MemoryGraphManager(path, hnsw_dim=768, hnsw_degree=32, hnsw_M=16, dist_type=…)

add_entity(entity_id: str, attributes: list[tuple[str, str]] = [],
           embedding=None, auto_k: int = 5) -> ErrorCode
add_relationship(src_entity_id, relationship_id, dst_entity_id,
                 attributes=[], embedding=None) -> ErrorCode
search_hybrid(query_vec, keyword_query: str, top_k) -> (ErrorCode, list[str])
search_nearest_entities(query_vec, top_k)
search_keyword(query: str, top_k)
get_entity_attributes(entity_id, attr)
find_k_hop(entity_id, k)  /  get_neighbors(entity_id, mask)
ensure_entity_vector_index()  /  ensure_keyword_index()  /  flush()  /  load()
```

Attributes are arbitrary `(key, value)` string pairs — this is where `page`,
`path`, `start_line`, and `symbol` live, and why provenance survives retrieval.

**Use `search_hybrid`.** It fuses dense HNSW with BM25 via RRF in a single call.
Identifiers are exact tokens, so lexical search is unusually strong on code;
embeddings earn their place on intent. Choosing between them is a false choice.

### The one decision that would quietly corrupt the graph

```python
add_entity(..., auto_k=5)   # default: auto-connect to 5 nearest vector neighbours
```

Keep that for **prose** — it is a free "related passages" graph.

Pass **`auto_k=0` for code**. Every getter embeds like every other getter, so
auto-connection wires up hundreds of syntactically similar, semantically
unrelated edges — and `find_k_hop` then propagates that noise into every
traversal. Code should get its edges from structure instead (§7).

### Embedding

Prefix code passages with their location before embedding —
`src/policy.py › class ActionExpert › predict` — because `return a + b` embeds
to nothing on its own. Prose needs no such prefix.

Ferry's `onnx-embed` extra (onnxruntime + tokenizers) runs locally on macOS at
768 dims, matching the HNSW default, which keeps textbooks entirely on-machine.

---

## 6. Chunking, already done

Tiro sends passages; ferry does not need to parse anything.

**Prose** is cut per page at paragraph boundaries, so every passage carries an
exact page. An over-long paragraph splits on a sentence end. Fragments under 220
chars fold into the next passage; nothing exceeds 1400.

**Code** is cut by declaration — a function with its body is the unit people ask
about. A file's imports become their own passage, a declaration longer than 80
lines splits while keeping its name, and files with no declarations found fall
back to 60-line windows.

> **Known limitation.** Paragraph detection leans on blank lines, and a
> two-column PDF extracts with few of them. On such a paper passages land near
> the 1400-char cap and are cut on sentence boundaries rather than true paragraph
> breaks — clean, but coarser than ideal. Improving this means detecting
> paragraph starts by indentation or line-length statistics.

---

## 7. The code graph — designed, not built

Nothing emits edges today. `chunkCode` produces flat passages. This is the piece
that makes code indexing *different* rather than just differently chunked.

Prose is linear; adjacency means something. A codebase is a graph — file order is
arbitrary, and two functions far apart can be tightly coupled. So prose retrieval
can return top-k passages, while code retrieval usually wants *this function,
plus what it calls, plus who calls it*: a neighbourhood, which is what
`find_k_hop` is for.

| Edge | Cost |
|---|---|
| `file -[contains]-> symbol` | free — declaration lines are already known |
| `symbol -[contains]-> symbol` | free — nesting |
| `file -[imports]-> file` | regex-reliable per language |
| `symbol -[references]-> symbol` | needs name resolution (below) |
| `concept -[implements]-> symbol` | **the bridge — see §8** |

For `references` without a parser: resolve identifiers in a chunk against the
symbol table by name. It works better than it sounds, because codebases use
distinctive names — but it over-links on `get`, `run`, `next`, so skip names
under ~4 characters or appearing in more than a handful of files. tree-sitter
(`web-tree-sitter`, WASM, no native build) makes it exact; a language server
makes it correct. Start with the approximation and *say so in the UI* rather
than calling it a call graph.

---

## 8. Why one store, not two

Tiro's Code tab already computes concept→code matches with an LLM pass, and
already has a concept map with `firstPage` and `pages` per term. Persist those as
`concept -[implements]-> symbol` edges and "what code implements this idea"
becomes a graph hop with no model call — and the reverse becomes possible for the
first time: point at a function, get the parts of the paper it realises.

That payoff is the reason documents and code belong in one graph despite every
other asymmetry between them.

---

## 9. Verification

No ferry is needed to develop against this. A stand-in MCP server — newline
JSON-RPC on stdio, ~40 lines of Node — that records what it receives is enough to
drive the whole path:

```bash
TIRO_FERRY_COMMAND="node /path/to/stand-in.mjs" npm run dev
```

Reproduce these numbers before believing an implementation:

| Check | Expected |
|---|---|
| index a 24-page paper | 83 passages, `page` present, 1..24, none over 1400 chars |
| index this repo | ~1,176 passages, ~95% with a non-empty `symbol` |
| `doc_status` after indexing | `{"indexed": true, "passages": 83}` |
| unset `TIRO_FERRY_COMMAND`, no `ferry` on PATH | no index row in any tab; the word *index* appears nowhere in the UI |
| ferry installed but no `doc_*` tools | Settings says so and names the tools it is leaving alone; still no buttons |

That last row is the current real-world state, and it is a pass, not a bug.

---

## 10. How Tiro finds ferry

In order: `TIRO_FERRY_COMMAND` → a path saved in Settings → `ferry` on PATH.
A sibling `../ferry` checkout is deliberately **not** guessed at, because running
it needs a Python 3.12 environment with dependencies and silently picking the
wrong interpreter is worse than reporting nothing.

```bash
uv venv --python 3.12 ~/.venvs/ferry
uv pip install --python ~/.venvs/ferry/bin/python -e ~/projects/ferry
```

That produces a working `ferry` binary (verified). Probed today it reports:

```
handshake ok in 266ms
advertises: ferry_remember, ferry_recall, ferry_get_persona, ferry_forget
forwarded : (none)
canIndex  : false
```

Two separate gates in `FerryStatus`: `available` needs a search tool,
`canIndex` needs `doc_index`. The buttons require both.

---

## 11. Decisions to leave alone

- **Indexing is a button.** Being indexed is what turns the search tools on —
  there is no size threshold deciding for the reader. An earlier version engaged
  the index past ~120k tokens automatically; that was replaced deliberately.
- **Tool definitions render ahead of the system prompt**, so attaching them to an
  unindexed document would buy a second prompt-cache entry for nothing. This is
  also why linking a repository costs one extra document write per session.
- **Absence is a normal outcome, never an error.** Nothing probes at startup in a
  way that can block; a failed probe is cached as unavailable rather than retried
  into a stall.
