# Grepmem — Design Document

> Vectorless agent memory. Memory lives on disk as HTML files; the agent retrieves with grep. No embedding model. No vector database. No ingestion LLM calls.

## 1. Core philosophy

Three principles, in priority order:

1. **Memory lives on disk, not in context.** The agent loads only what it needs, when it needs it. If context is lost, the agent re-greps.
2. **Storage is human-readable.** `memory.html` opens in any browser. You can diff it with git, grep it from the CLI, and read it with your eyes.
3. **Zero hidden LLM calls.** No embedding model runs at write time. No ingestion summarizer runs at write time. The only LLM in the system is whatever model the agent itself uses to read the retrieved results.

Everything else follows from these.

## 2. System architecture

```
┌─────────────────────────────────────────────────────────┐
│  Interfaces                                              │
│    HTTP server (server.mjs)                              │
│    MCP server (mcp-server.mjs)                           │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Memory Engine (memory-html.js)                         │
│    add() / update() / remove()                          │
│    land(query) → searchAndScore → top-K                 │
│    focus(id) / spread(id, depth, energy)                │
└────────────────────────┬────────────────────────────────┘
                         │
       ┌─────────────────┴─────────────────┐
       ▼                                   ▼
┌──────────────────┐              ┌────────────────────┐
│  Storage         │              │  Retrieval         │
│  memory.html     │              │  grep.js           │
│  memory.html.bak │              │  ripgrep subprocess│
└──────────────────┘              └────────────────────┘
       ▲                                   │
       │                                   │
       └───────── file system ─────────────┘
```

Three layers, each replaceable:

- **Storage** — single HTML file per namespace, atomically swapped via `.bak`.
- **Engine** — in-memory `_articles` Map, dirty-flag deferred flush.
- **Interface** — HTTP for curl/scripts, MCP for agents.

The engine never calls a model. It does filesystem and ripgrep. That's it.

## 3. Storage format (`memory.html`)

One file per namespace. Schema:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Grepmem</title>
  <style>/* human-readable styling */</style>
</head>
<body>
<!-- INDEX: id|salience|accessCount|lastAccess|author -->
<!-- abc123|0.53|3|2026-06-11|agent-1 -->

<article id="abc123"
         data-type="knowledge"
         data-tags="Redis,password,6379,cluster"
         data-author="agent-1"
         data-salience="0.5"
         data-access-count="3"
         data-last-access="2026-06-11"
         data-timestamp="2026-06-10T14:30:00Z">
  <h2>Production Redis password r3d1s, port 6379 <span class="type-badge type-knowledge">knowledge</span></h2>
  <p class="detail">3-node cluster. Sentinels on 101/102/103. Pool size 100.</p>
  <ul class="triggers">
    <li>Redis connection config</li>
    <li>Redis password</li>
  </ul>
  <nav class="edges"><a href="#xyz">admin-panel deployment</a></nav>
</article>

<article id="conv-2026-06-10"
         data-type="conversation"
         data-timestamp="2026-06-10T...">
  <h2>Redis upgrade discussion <span class="type-badge type-conversation">conversation</span></h2>
  <div class="conversation-body">
    User: Should we rotate the production Redis password?
    AI: Recommended — current one is 2 years old.
  </div>
</article>
</body>
</html>
```

### Field reference

| Field | Where | Purpose |
|-------|-------|---------|
| `id` | `<article id>` attr | SHA-256 prefix of summary. Stable across renames. |
| `data-type` | `<article>` attr | `knowledge` (compiled facts) or `conversation` (raw history) |
| `data-tags` | `<article>` attr | Comma-joined keywords extracted at write time. High-density grep target. |
| `data-salience` | `<article>` attr | `baseSalience` 0-1. Boosted by access, decayed by time. |
| `data-timestamp` | `<article>` attr | When the underlying event happened (chat time, doc creation, etc.) |
| `data-superseded-by` | `<article>` attr | If set, this node is replaced by another. CSS greys it out. |
| `<h2>` | first child | `summary` — the one-line headline shown in recall results. |
| `<p class="detail">` | optional | Long-form text for knowledge articles. |
| `<div class="conversation-body">` | optional | Verbatim chat for conversation articles. |
| `<ul class="triggers">` | optional | Future scenarios that should resurface this memory. Grep weight 3.0. |
| `<nav class="edges">` | optional | Typed links to other articles. `<a data-strength="0.5">` per edge. |
| `<!-- INDEX: ... -->` | HTML comment | Fast ID lookup; ripgrep can hit it without DOM parsing. |

### Why HTML (not Markdown, not JSON)

- **Browser-native.** Open the file, read it like a doc.
- **Semantic structure.** `<article>`, `<h2>`, `<nav>`, `<ul>` are real semantic tags. Markdown has no article boundaries; JSON has no display layer.
- **grep-friendly.** Tags and triggers are in attribute values; full-text is in element bodies. Ripgrep hits both without parsing.
- **git-diffable.** One article per `<article>` block, one line per field. Diffs are reviewable.
- **No parser needed for reads.** Ripgrep + regex extracts fields. (Writes use a small serializer; reads use line-range mapping.)

## 4. Retrieval engine (`grep.js`)

### 4.1 Why not embeddings

Embeddings are great at bridging vocabulary gaps. They are also:

- Expensive at write time (one model call per write).
- Opaque (you can't read a vector).
- Heavy (transformer runtime, ~500MB deps).
- Hard to debug (why did this match? cosine says 0.73, that's why).

For agent memory — where the agent is already a capable LLM — embeddings are redundant. The agent can rewrite its own query 5 different ways and grep each one. That's what agent-as-retriever means.

### 4.2 Four-pass multi-strategy grep

```
score = 0
for each extracted query term:
  hit lines = rg <term> memory.html
  for each hit:
    article_id = find_article_for_line(hit)
    field = which_field(hit)        # trigger / tag / detail / conversation
    score[article_id] += term.weight × field.weight

sort articles by score × effectiveSalience, descending
```

| Pass | What it greps | Weight | Why |
|------|--------------|--------|-----|
| Trigger | `<ul class="triggers">` block | 3.0 | Author-curated "future scenarios that should resurface this". Highest signal. |
| Tag | `data-tags` attribute | 2.0 | Auto-extracted keywords. Dense token surface. |
| Full-text | entire file | 1.0–1.5 | Catch-all. |
| Synonym | manually-expanded terms | 1.5 | Cache → Redis, crashed → failure, password → bcrypt. Built-in map + learned map. |

### 4.3 Query term extraction (`extractQueryTerms`)

A query string is broken into a list of `{pattern, weight, type}` terms:

| Pattern type | Regex | Weight | Example |
|--------------|-------|--------|---------|
| Whole-query exact | entire string | 3.0 | `"how to connect Redis"` |
| English word | `[a-zA-Z][a-zA-Z0-9_.\-]+` | 2.0 (+1.5 case-insensitive) | `Redis`, `6379` |
| Chinese bigram | consecutive CJK pairs | 1.5 | `缓存` → `缓存` |
| Chinese trigram | consecutive CJK triples | 2.0 | `Redis配置` |
| IP / port | `\d+\.\d+\.\d+\.\d+(:\d+)?` | 3.0 | `192.168.1.101` |
| Bare numbers | `\d{2,}` | 1.5 | `6379`, `2024` |
| Synonyms (built-in) | expansion map | 1.5 | `缓存` → `Redis`, `redis` |
| Synonyms (learned) | learner output | 1.8 | `k8s` → `kubernetes`, `pod`, `kubectl` |

The case-insensitive flag and learned-synonym weight (1.8 > 1.5) reflect that learned synonyms are domain-specific and high-precision.

The built-in synonym map ships with English and Chinese entries (cache→Redis, 缓存→Redis, crashed→failure). It's a plain object in `grep.js`; English-only deployments can clear it without touching any other code.

### 4.4 Salience weighting

Each article's `effectiveSalience` scales its match score before sort:

```
effectiveSalience = clamp(
  baseSalience              // default 0.5
  + accessCount × 0.03      // capped at +0.3
  - days_since_last_access × 0.005,
  0.1, 1.0
)
```

A frequently-accessed recent memory outranks a stale one, even with identical match scores. decayRate = 0.005 means roughly half-life of 200 days — slow enough that "yesterday's discussion" beats "last year's reference" but fast enough that dead config entries fade.

### 4.5 Match threshold

`matchThreshold = 0.20`. Anything below is filtered out as noise. Set low because grep's scoring is generous (synonym + tag overlap can rack up points quickly even on partial matches).

## 5. Fail-Improve Loop (`learner.js`)

A query-only subsystem. When a term keeps co-occurring with retrieved articles that contain a tag the term doesn't match, we promote the term to a learned synonym.

### 5.1 Algorithm

```
on every land(query) with results:
  extract query terms (English words + Chinese bigrams)
  for top 3 matched articles:
    for each tag in article.tags:
      for each query term not already in tag:
        record_query_term({ term, tag })

on recorded_count(term, tag) >= LEARN_THRESHOLD:  // = 2
  promote: learned_synonyms[term] = [tag, ...]
  write to .synonyms.json
```

### 5.2 Hot reload

`grep.js` reads `globalThis.__SYNONYM_LEARNER` on every query. New synonyms take effect on the next `land()` call — no restart, no engine reload.

### 5.3 Example

```
Day 1: user types "k8s" → grep hits "kubernetes" articles (via tag).
        record (k8s, kubernetes).
Day 1: user types "k8s" again → another hit.
        record (k8s, kubernetes). Promote.
Day 2: user types "k8s" → now expanded to [k8s, kubernetes, pod, ...]
```

Two co-occurrences is the threshold. Low enough that real patterns promote fast; high enough that one-off typos don't.

## 6. Write operations

### 6.1 `add({ summary, detail, triggers, author, type, conversation, timestamp })`

```
1. Auto-generate triggers if not provided.
2. Extract tags from summary + detail (or summary + conversation).
3. Dedup check FIRST — before generating an ID:
   - SHA-256 prefix of summary
   - If article with same prefix exists and not superseded → return duplicate
   - Jaccard similarity on tags ≥ 0.85 → return duplicate
4. Generate ID (SHA-256 prefix; -N suffix only on hash collision).
5. Auto-link: for each existing article with tag Jaccard ≥ 0.5, add bidirectional edges.
6. Create node, set in-memory map, mark dirty.
7. _maybeFlush (deferred — see 6.5).
```

### 6.2 Why triggers are optional

If `triggers` is `undefined` or `null`, auto-generate. If `[]` (explicit empty), respect — the caller is signaling "no triggers". This distinction matters: a chat-history article has no meaningful triggers, but a config article wants them.

### 6.3 Auto-triggers

When auto-generating, the engine extracts:
- First 30 chars of summary
- Chinese 2-4 char phrases
- English technical terms (`[a-zA-Z][a-zA-Z0-9_.\-]{2,}`)
- IP patterns

Capped at 5 triggers per article. Cheap, no LLM.

### 6.4 `update`, `remove`, `supersede`, `link`

- **update** — modify summary/detail/triggers; re-extract tags.
- **remove** — delete article; clean inbound edges from other articles.
- **supersede(old, new)** — mark old as `data-superseded-by=new`, re-link inbound edges to new. Old stays in file (greyed out via CSS), so you can audit history.
- **link(source, target, strength)** — add typed edge. Strength persisted via `data-strength` attribute.

### 6.5 Deferred flush (`_maybeFlush`)

The engine does NOT write to disk on every `add()`. It writes when:

- 10 access-buffered updates accumulate, OR
- 60 seconds have passed since last flush.

Why: benchmarks ingest 50+ sessions per question. A full HTML rewrite per add() is wasteful, and on Windows the rename-then-write sequence races with concurrent readers (ripgrep in eval scripts), producing EPERM. Deferred flush solves both.

Callers needing immediate durability can `await engine._flush()` explicitly.

### 6.6 Atomic write

```
rename memory.html → memory.html.bak
writeFileSync(memory.html, serialized)
```

If write fails, the `.bak` is still there. Next `init()` falls back to `.bak` if `memory.html` is missing/corrupt.

## 7. Read operations

### 7.1 `land(query, spreadDepth=1, typeFilter=null)`

The main entry point. Returns ranked hits.

```
1. extractQueryTerms(query)
2. for each term: grepSearch(term.pattern, memory.html, {ci})
3. scoreResults(hits, articles)
4. filter by matchThreshold (0.20)
5. filter by typeFilter if provided
6. record query terms into learner
7. update access stats on top-5 results
8. spread() from top-1 if spreadDepth > 0
9. return sorted hits
```

### 7.2 `focus(nodeId)`

Reads one article's full content + edges. Used by `memory_read` MCP tool. Updates accessCount as a side effect.

### 7.3 `spread(nodeId, depth=2, energy=1.0)`

Graph traversal. BFS over edges, decaying energy by `strength` per hop. Stops when energy < 0.1.

Used by `land()` for one hop of context expansion after primary match — surfaces "the article next to your hit".

## 8. Namespaces

A namespace = one directory with `memory.html` + `memory.html.bak` + `.synonyms.json`.

- Multi-agent isolation: each agent gets its own basePath.
- Multi-user isolation: each user gets their own basePath.
- Multi-project isolation: each project gets its own basePath.

The engine constructor takes `{ basePath }` — that's the only knob. No tenant IDs in queries, no ACL checks. The filesystem is the isolation layer.

MCP server reads `MEMORY_PATH` env var to pick the namespace. Switch projects by switching env vars.

## 9. Interfaces

### 9.1 HTTP (`server.mjs`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/add` | Add memory `{summary, triggers?, detail?, author?, type?}` |
| POST | `/recall` | Search `{query, spreadDepth?, typeFilter?}` |
| POST | `/addBatch` | Batch add `{items: [...]}` |
| GET  | `/focus/:id` | Get full memory by ID |
| POST | `/update` | Update `{nodeId, ...fields}` |
| POST | `/remove` | Delete `{nodeId}` |
| POST | `/link` | Link memories `{source, target, strength?}` |
| GET  | `/stats` | Node/edge counts |
| GET  | `/health` | Health check |

### 9.2 MCP (`mcp-server.mjs`)

Six tools exposed over MCP (stdio transport), works with Claude Code, Cursor, Cline:

| Tool | Purpose |
|------|---------|
| `memory_recall` | Same as HTTP `/recall` |
| `memory_read` | Same as HTTP `/focus` — agent verifies candidates |
| `memory_list` | Browse by type/tag (no query) |
| `memory_store` | Same as HTTP `/add` |
| `memory_grep` | Raw ripgrep over HTML — bypasses scorer |
| `memory_find_symbol` | Regex-based AST-lite symbol search for code memories |

The `memory_grep` and `memory_read` tools exist because the agent needs to drive the retrieval loop itself. `recall` returns ranked hits; if those miss, the agent can grep raw and read full text to verify.

This is the agent-as-retriever pattern: the engine provides primitives, the agent provides strategy.

## 10. Agent-as-Retriever harness

For benchmarks like LongMemEval-S (500 questions, ~50 haystack sessions each), single-shot recall is insufficient — the query vocabulary rarely matches the answer session's vocabulary. The fix is an agent loop:

### 10.1 Architecture

```
for each question:
  ingest haystack sessions → memory.html
  spawn agent with 3 tools (recall, grep, read)
  for up to MAX_TURNS turns:
    agent picks tool + args
    engine executes, returns results
    agent decides: verify / rewrite query / output final list
  collect agent's session_ids, score against answer_session_ids
```

### 10.2 What made it work (from 24% single-shot to 98.9% agent)

| Change | Δ R@5 |
|--------|-------|
| Baseline: single-shot `recall(query)` → top-K | 24.0% |
| + Agent loop with 1 tool, T=4 | +62.7 |
| + `memory_grep` + `memory_read` tools | +3.3 |
| + Dynamic system prompt per question type | +3.3 |
| + Hard rules prompt (≥2 distinct recalls in first 3 turns, ≤6 reads) + T=10 | +5.6 |
| **Final** | **98.9%** |

The biggest jump (+62.7) comes from query rewriting. The agent doesn't ask the same thing 5 times — it tries the question's keywords, then synonyms, then entity names, then dates.

### 10.3 Concurrency + checkpointing

- `CONCURRENCY=4` workers run questions in parallel (Step Plan allows 5 concurrent requests).
- Each completed question appends a line to `.failures/_progress.jsonl`.
- Restart skips already-done `question_id`s and restores cumulative stats.
- Failed questions dump full traces to `.failures/<type>/<qid>.json` (query sequence, agent's collected sessions, missed answer session text).

This makes a 3.5-hour full-500 run crash-resumable.

## 11. Design tradeoffs

| Decision | Why | Cost |
|----------|-----|------|
| HTML storage, not vector DB | Transparent, git-diffable, no DB ops | Single-file rewrite on flush (optimized by deferred flush) |
| grep, not embeddings | No model runtime, no opaque vectors | Single-shot grep loses to vector retrieval on semantic-gap queries (24% vs ~80%); recovers via agent loop |
| Zero ingestion LLM calls | Predictable write cost, zero model dependency | Can't extract structured facts at write time; 2 of 500 LongMemEval questions are unreachable |
| Single-file namespace | Simple, portable, inspectable | Doesn't shard; 10K-node file is 6MB, 100K-node would be 60MB |
| Agent drives retrieval loop | Highest retrieval accuracy | Each query costs N LLM calls; latency = N × per-call time |
| Salience decay over time | Stale memories fade naturally | Requires tuning decayRate; current 0.005 is conservative |

## 12. Known limitations

- **Single-shot recall has a semantic-gap ceiling.** `recall("what's my favorite hobby")` won't find a session that says "I love hiking on weekends" without an agent rewriting the query. Mitigated by agent loop; not eliminated.
- **No write-time fact extraction.** The 2 missed LongMemEval questions are unreachable because the answer is hidden in passing ("by the way, I've been in marketing for 2 years and 4 months") inside a session about an unrelated topic. Bridging this requires LLM extraction at write time, which we don't do.
- **HTML file doesn't shard.** At very large scale (100K+ memories) a single file becomes a perf bottleneck. Solution would be sharding by tag prefix, not yet implemented.
- **No multi-tenant auth.** Namespaces are isolated by directory; the engine trusts whatever basePath it's given. Authentication is the host's job (HTTP server / MCP transport).
- **No garbage collection.** Removed articles leave gaps; superseded articles stay in the file (greyed out). A compaction pass would help at scale.

## 13. Evaluation results

### 13.1 LongMemEval-S — Agent-as-Retriever (the headline benchmark)

**Dataset**: longmemeval_s, 500 questions × 6 categories (single-session-user/asst/preference, multi-session, temporal, knowledge-update). Each question has ~50 haystack sessions. Full evaluation (470 questions after dropping 30 _abs).

**Protocol**: fresh namespace per question, ingest all haystack sessions verbatim into `memory.html`, run LLM as retriever (MAX_TURNS=10, 3 tools: `memory_recall` / `memory_grep` / `memory_read`). Hit criterion: `agent's top-K session_ids ∩ answer_session_ids` is non-empty.

**Model**: StepFun `step-3.7-flash` (sparse MoE, ~11B active params), `reasoning_effort=high`, via Step Plan endpoint (`api.stepfun.com/step_plan/v1`). No GPT / Claude / Gemini called at any stage — not for embeddings (none), not for ingestion (verbatim), not for retrieval iteration (this model only).

**Ablation** (cumulative, same `step-3.7-flash`):

| Config | Sample | R@5 | R@10 | Δ |
|--------|--------|-----|------|---|
| Single-shot grep (recall → top-K, no agent) | — | 24.0% | 49.0% | baseline |
| + Agent loop, 1 tool (`memory_recall`), T=4 | 30 Q | 86.7% | 90.0% | **+62.7** |
| + `memory_grep` + `memory_read` tools, T=6 | 30 Q | 90.0% | 90.0% | +3.3 |
| + Dynamic prompt by category | 30 Q | 93.3% | 93.3% | +3.3 |
| **+ Hard-rules prompt + T=10 + Step Plan concurrency** | **full 500** | **98.9%** | **99.6%** | **+5.6** |

**Architecture characteristics**:

| Dimension | Value |
|-----------|-------|
| Embedding model | None |
| Vector database | None |
| Ingestion LLM calls | Zero (sessions written verbatim) |
| Agent loop model | step-3.7-flash (non-frontier) |
| 10K-node query median latency | 991ms |
| 10K-node HTML file size | 6MB |
| Storage format | HTML (browser-readable, git-diffable) |

**Key observations**:

1. Single-shot grep at 24% is the expected ceiling — confirmed by arXiv:2605.15184. Embeddings bridge vocabulary gaps at write time; the agent-as-retriever pattern bridges them at query time via rewriting.
2. Agent iteration is the single biggest lever (+62.7pt).
3. `memory_read` acts as a built-in LLM-as-reranker — the agent reads full text and decides whether to promote the candidate. Recovered temporal category from 75% to 100%.
4. Dynamic prompts (per-category tips) fixed multi-session from 75% to 100% ("collect 3+ sessions, each contains a piece").
5. Hard-rules prompt (≥2 distinct recalls in first 3 turns, read ≤6, stop early when verified) lifted ss-user from 89% to 98%.
6. Step Plan endpoint bypasses V0 RPM=10 limit; CONCURRENCY=4 cut full-run time from 5.8h to 3.5h.

### 13.2 Per-type breakdown (full 500 questions)

| Category | R@5 | R@10 | n |
|----------|-----|------|---|
| single-session-user | 98% | 100% | 64 |
| single-session-assistant | 98% | 100% | 56 |
| **single-session-preference** | **100%** | **100%** | 30 |
| multi-session | 98% | 99% | 121 |
| temporal-reasoning | 99% | 99% | 127 |
| **knowledge-update** | **100%** | **100%** | 72 |

ss-pref and knowledge-update are perfect. Two categories missed at most 1 question each.

### 13.3 Failure analysis (2 / 470 questions)

Both failures are benchmark-structural, not retrieval bugs:

| Type | Example | Root cause | Fixable? |
|------|---------|-----------|----------|
| multi | "How long have I been in my current role?" | Answer session is about presentation templates; the user mentions in passing "started as Coordinator, worked up after 2 years and 4 months". Query vocabulary (employment, tenure) doesn't appear. | ❌ Requires write-time fact extraction |
| temporal | "What kitchen appliance did I buy 10 days ago?" | Answer session says "I just got a smoker today" but never uses "10 days ago" — that offset is computed from the session timestamp. | ❌ Requires temporal anchoring |

Both require write-time extraction (parse sessions at ingest, store structured facts). We deliberately don't do this — it would mean abandoning the "zero ingestion LLM calls" principle. 99.6% R@10 is the trade-off.

### 13.4 Scale and tests

- 10K nodes: 6MB HTML, 991ms query latency (< 30s budget)
- 1K nodes: insert + query under 100ms
- 100 concurrent writes: 90%+ success rate
- 85 unit/integration tests pass (engine 30 + html 21 + errors 25 + scale 9)
