# Grepmem

> Vectorless agent memory. HTML on disk, grep at retrieval. The just-in-time context loading pattern, applied to the agent's own memory.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
**LongMemEval-S: R@5 = 98.9%** • Zero embeddings • Zero vector DB • Zero ingestion LLM

An external memory store for AI agents. Memory lives on disk as **HTML files**. The agent queries them with **grep**. No embedding model. No vector database. No ingestion LLM calls.

> **Memory lives on disk, not in context.** The agent loads only what it needs, when it needs it. If the context is lost, the agent just re-greps.

---

## Why this architecture

For three years, the default RAG stack has been: chunk → embed → store vectors → cosine similarity. In 2025-2026, that consensus broke.

Research pointing to agent-as-retriever as the new default:

- **Anthropic removed vector search from Claude Code in May 2025.** Boris Cherny (creator): *"grep outperformed everything. By a lot, and this was surprising."*
- **Amazon Science (AAAI 2026)**: agentic keyword search reaches **94.5% of RAG faithfulness with zero vector store**.
- **Search-R1** (arXiv:2503.09516): RL-trained retrieval policy, +24% relative over RAG baselines on 7 QA datasets, no vectors.
- **Chroma Context-1** (March 2026): 20B agentic-search model, ~10× faster and ~25× cheaper than frontier models on retrieval.
- **Anthropic multi-agent research system**: agent-as-retriever pattern, +90.2% over single-agent baseline on internal research evals.

**The pattern:** in 2026, the default retrieval is no longer vectors. The default is *give the agent tools, let it retrieve just-in-time*. Add vectors only where the workload genuinely demands them.

This project applies that pattern to **the agent's own memory**. Memory is just another data source the agent retrieves from on demand. As Anthropic's own engineering post puts it: *"agents maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools."*

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Agent (Claude Code, Cursor, any LLM)           │
│                                                 │
│  "How do I connect to production Redis?"        │
│         │                                       │
│         ▼  tool call: recall / grep             │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  Memory Engine                          │    │
│  │                                         │    │
│  │  1. Tokenize query                      │    │
│  │  2. Multi-pass ripgrep on memory.html   │    │
│  │     - trigger surface (weight 3.0)      │    │
│  │     - tag surface      (weight 2.0)     │    │
│  │     - full text        (weight 1.0-1.5) │    │
│  │     - synonym expansion(weight 1.5)     │    │
│  │  3. Weighted scoring × salience         │    │
│  │  4. Return top results                  │    │
│  └─────────────────────────────────────────┘    │
│         │                                       │
│         ▼                                       │
│  memory.html                                    │
│  • <article> per memory, with data-tags, edges  │
│  • Human-readable in any browser                │
│  • Agent reads with grep, human reads with eyes │
└─────────────────────────────────────────────────┘
```

### Storage format

```html
<article id="abc123" data-type="knowledge" data-tags="Redis,password,6379,cluster">
  <h2>Production Redis: password r3d1s_v2_2025!, port 6379, host 192.168.1.101</h2>
  <p class="detail">3-node cluster. Sentinels on 101/102/103. Pool size 100.</p>
  <ul class="triggers">
    <li>Redis password</li>
    <li>Redis connection config</li>
  </ul>
  <nav class="edges"><a href="#xyz">admin-panel deployment</a></nav>
</article>

<article id="conv-2026-06-10" data-type="conversation" data-timestamp="...">
  <h2>Redis upgrade discussion</h2>
  <div class="conversation-body">
    User: Should we rotate the production Redis password?
    AI: Recommended — current one is 2 years old.
  </div>
</article>
```

Two article types in one file: **knowledge** (compiled facts) and **conversation** (raw history). One covers config/Q&A recall, the other covers "what did we discuss about X". Storing both in one place means the same search surface can answer "what's the prod Redis password?" and "what did we discuss about caching last week?".

### How retrieval works

Four-pass grep with weighted scoring:

1. **Trigger search** — grep `<ul class="triggers">` (weight 3.0)
2. **Tag search** — grep `data-tags` attribute (weight 2.0)
3. **Full-text search** — grep entire file (weight 1.0-1.5)
4. **Synonym expansion** — cache→Redis, crashed→failure, password→bcrypt (weight 1.5)

Score = Σ(term hits × field weight) × effectiveSalience. Sorted descending.

*The built-in synonym map and Chinese stopword list (see `grep.js` and `learner.js`) cover common cross-language cases (cache→Redis, 缓存→Redis, crashed→failure). English-only users can clear `SYNONYMS` in `grep.js` — it's a plain object, no other code depends on its contents.*

### Fail-Improve Loop

Every query records which terms matched which articles. When a term co-occurs with a tag/trigger N times (and the term is NOT already in the article), it auto-promotes to a learned synonym. The system gets smarter the more you use it — without ever calling an LLM.

```
'k8s' → [kubernetes, pod, nodeselector, kubectl, ...]   // learned after 3 co-occurrences
```

---

## Headline benchmark — LongMemEval-S

Full 500-question evaluation across 6 categories. Each question has ~50 haystack sessions; the agent must surface the right one(s).

| Configuration | R@5 | R@10 | Notes |
|---|---|---|---|
| Single-shot grep (recall → top-K) | 24.0% | 49.0% | The "grep alone" baseline. Why pure grep loses single-shot: query vocabulary ≠ answer vocabulary. |
| + Agent loop, 1 tool, T=4 (30 Q sample) | 86.7% | 90.0% | LLM rewrites query across turns. **+62.7pt** just from agent iteration. |
| + memory_grep + memory_read tools (30 Q sample) | 90.0% | 90.0% | Agent can grep raw HTML and verify candidates by reading full text. |
| + Dynamic prompt by category (30 Q sample) | 93.3% | 93.3% | Per-type tip in system prompt. |
| **+ Hard-rules prompt + MAX_TURNS=10 (full 500 Q)** | **98.9%** | **99.6%** | **Final config.** |

**Model used:** `step-3.7-flash` (StepFun, ~11B active params, sparse MoE). All numbers above are produced by this single model with `reasoning_effort=high` for the agent loop. No call to GPT, Claude, or Gemini is made at any point — not for embeddings (none), not for ingestion (none), not for retrieval iteration (this model only).

**What's running underneath the 98.9%:**

- **Agent model:** StepFun `step-3.7-flash`, `reasoning_effort=high`. Accessed via Step Plan endpoint (`api.stepfun.com/step_plan/v1`).
- **Zero embedding model.** No transformers, no GPU.
- **Zero vector database.** No Chroma, no Pinecone, no Postgres+pgvector.
- **Zero ingestion LLM calls.** Sessions go verbatim into HTML.
- **991ms median query latency at 10K nodes.** Memory file stays under 6MB.
- **Human-readable storage.** Open `memory.html` in any browser; diff it with git.

*Methodology: full 500 Q (non-_abs = 470 evaluable), fresh namespace per question, MAX_TURNS=10, TOP_K=5, CONCURRENCY=4, deterministic answer_session_id match. Checkpoint + resume supported. Reproducible: `LIMIT=500 MAX_TURNS=10 CONCURRENCY=4 node eval/longmemeval-s-agent.mjs`.*

### Per-type breakdown (full 500 questions, final config)

| Category | R@5 | R@10 | n | Notes |
|---|---|---|---|---|
| single-session-user | 98% | 100% | 64 | What did the user say about X |
| single-session-assistant | 98% | 100% | 56 | What did AI tell the user |
| **single-session-preference** | **100%** | **100%** | 30 | Perfect on the type other systems struggle with |
| multi-session | 98% | 99% | 121 | Synthesize across sessions |
| temporal-reasoning | 99% | 99% | 127 | Date/time logic |
| **knowledge-update** | **100%** | **100%** | 72 | Track preference changes over time |

### What we miss (2 / 470 questions)

Both failures are **benchmark-structural**, not retrieval bugs:

- **multi-session, "How long have I been in my current role?"** — the user casually mentions "started as Marketing Coordinator, worked my way up to Senior Marketing Specialist after 2 years and 4 months" inside a question about presentation templates. The query vocabulary (employment, tenure, hire date) does not appear anywhere in the answer session.
- **temporal, "What kitchen appliance did I buy 10 days ago?"** — the answer session text mentions "I just got a smoker today" but never uses "10 days ago" — that offset is computed from the session timestamp. Pure-text retrieval cannot find a date that does not exist as a string.

Both require write-time fact extraction (parse sessions at ingest, store structured facts). We deliberately don't do this — it would mean abandoning the "zero ingestion LLM calls" principle. 99.6% R@10 is the trade-off.

---

## Quick start

```bash
# Install deps (only MCP SDK + Zod)
npm install

# Start the HTTP server
npm start
# → Grepmem Server listening on http://localhost:18234

# Or run the MCP server (for Claude Code / Cursor / Cline)
node mcp-server.mjs
```

### Add a memory

```bash
curl -X POST http://localhost:18234/add \
  -H 'Content-Type: application/json' \
  -d '{
    "summary": "Production Redis password r3d1s, port 6379",
    "detail": "3-node cluster. Sentinels on 101/102/103.",
    "triggers": ["Redis password", "Redis connection"],
    "type": "knowledge"
  }'
```

### Search

```bash
curl -X POST http://localhost:18234/recall \
  -H 'Content-Type: application/json' \
  -d '{"query": "how to connect to Redis"}'
```

### Open memory in browser

`namespaces/default/memory.html` — fully human-readable.

## Configuration

All configuration is via environment variables. Copy [`.env.example`](.env.example) to `.env` and edit.

### Production (server / MCP)

| Var | Default | Description |
|-----|---------|-------------|
| `MEMORY_PATH` | `./namespaces/default` | Where to store `memory.html`. Switch per-project / per-user / per-agent. |
| `MEMORY_PORT` | `18234` | HTTP server port (server.mjs only) |

### Eval scripts

| Var | Default | Description |
|-----|---------|-------------|
| `LLM_KEY` | — | Required for agent-as-retriever benchmark. StepFun / OpenAI / any OpenAI-compatible API key. |
| `LLM_BASE` | — | API endpoint. Recommended: `https://api.stepfun.com/step_plan/v1` |
| `LLM_MODEL` | `step-3.7-flash` | Model name |
| `LIMIT` | `20` | Number of questions to evaluate |
| `MAX_TURNS` | `5` | Tool calls per question |
| `CONCURRENCY` | `4` | Parallel questions |
| `RESUME` | `1` | `1` = resume from checkpoint, `0` = start fresh |

## Examples

| Example | What it shows |
|---------|---------------|
| [`examples/basic-usage.mjs`](examples/basic-usage.mjs) | Use the engine as a library — no HTTP server. Store knowledge + conversation, recall, focus. |
| [`examples/http-client.mjs`](examples/http-client.mjs) | Talk to the HTTP server from any language via `fetch`. |
| [`examples/claude-code-setup.md`](examples/claude-code-setup.md) | Wire Grepmem into Claude Code as an MCP tool. |

Run example 1 to see it work end-to-end:

```bash
node examples/basic-usage.mjs
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/add` | Add memory `{ summary, triggers?, detail?, author?, type? }` |
| POST | `/recall` | Search `{ query, spreadDepth?, typeFilter? }` |
| POST | `/addBatch` | Batch add `{ items: [...] }` |
| GET | `/focus/:id` | Get full memory by ID |
| POST | `/update` | Update `{ nodeId, ...fields }` |
| POST | `/remove` | Delete `{ nodeId }` |
| POST | `/link` | Link memories `{ source, target, strength? }` |
| GET | `/stats` | Node/edge counts |
| GET | `/health` | Health check |

## Wire into Claude Code

```bash
claude mcp add grepmem -- node /absolute/path/to/mcp-server.mjs
```

6 tools exposed: `memory_recall`, `memory_read`, `memory_list`, `memory_store`, `memory_grep`, `memory_find_symbol`.

See [`examples/claude-code-setup.md`](examples/claude-code-setup.md) for the full walkthrough.

## Why this exists

| The old model | This model |
|---------------|------------|
| Memory = vector DB. Every write costs an embedding call. Every query is cosine similarity. Memory is opaque — you can't read it, can't diff it, can't grep it. The DB lives somewhere, your data leaves your machine. | Memory = HTML on disk. Write is just file append. Query is grep. Memory is transparent — open it in a browser, diff it with git, grep it from CLI. Your data never leaves your machine. |

## Roadmap

- **Shipped**: HTML storage, grep retrieval, fail-improve loop, dual-layer knowledge/conversation, MCP server with 6 tools (recall / read / list / store / grep / find_symbol).
- **Shipped**: Agent-as-retriever benchmark — LongMemEval-S R@5 = 98.9% on full 500 questions.
- **Next**: End-to-end QA evaluation on LongMemEval (retrieve → answer → judge), so the project has a comparable accuracy number alongside the retrieval number.
- **Next**: Cross-benchmark validation — run the same agent harness on LoCoMo and ConvoMem to confirm the pattern generalizes beyond LongMemEval.
- **Later**: Lightweight write-time fact extraction (optional, off by default) — a compromise that captures the 2 missed questions without making zero-ingestion-LLM the default mode.
- **Later**: Production dogfooding — wire the MCP server into Claude Code / Cursor for real-world daily use and measure recall latency / hit rate on actual user queries.

## Project structure

```
memory-html.js     # Core engine (MemoryEngine class)
html-template.js   # HTML serialization/deserialization
grep.js            # Multi-pass grep retrieval + synonym map
learner.js         # Fail-improve loop (synonym auto-learning)
mcp-server.mjs     # MCP server (6 tools, stdio transport)
server.mjs         # HTTP API server
examples/          # Usage examples
eval/              # Benchmarks, unit tests, scale tests
```

## Tests

```bash
npm test           # 76 unit tests (engine + html + errors)
npm run test:scale # 9 scale tests (100 / 1K / 10K nodes, concurrency)
```

## Documentation

- **[DESIGN.md](DESIGN.md)** — Architecture deep-dive (storage format, retrieval engine, fail-improve loop, write operations, design tradeoffs, known limitations)
- **[README.html](README.html)** — Same content as this README, but with custom styling for local viewing

## References

- [Is Grep All You Need? How Agent Harnesses Reshape Agentic Search (PwCUS, 2026)](https://arxiv.org/abs/2605.15184) — the paper that directly motivated our agent-as-retriever approach.
- [AI Agents Don't Need Vector Search Anymore (2026 survey)](https://buzzgrewal.medium.com/ai-agents-dont-need-vector-search-anymore-inside-the-agentic-search-stack-replacing-rag-in-2026-58efcabe4f6f) — survey of the agentic search stack.
- [Keyword Search Is All You Need (Amazon, AAAI 2026)](https://arxiv.org/abs/2602.23368) — 94.5% of RAG faithfulness with zero vectors.
- [Search-R1](https://arxiv.org/abs/2503.09516) — RL-trained retrieval policy.
- [DCI-Agent](https://arxiv.org/abs/2605.05242) — direct corpus interaction.
- [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — just-in-time context loading.

## License

MIT — see [LICENSE](LICENSE).
