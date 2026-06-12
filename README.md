# Grepmem

> Vectorless agent memory. Memory lives on disk as HTML files; the agent retrieves with grep. No embedding model. No vector database. No ingestion LLM calls.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Full documentation with styling: see [README.html](README.html).**
Architecture deep-dive: [DESIGN.md](DESIGN.md) / [DESIGN.html](DESIGN.html).

---

## What this is

An external memory store for AI agents. Memory lives on disk as **HTML files**. The agent queries them with **grep**. No embedding model. No vector database. No ingestion LLM calls.

The agent-as-retriever pattern: the agent owns the retrieval loop, the engine provides primitives.

## Headline result — LongMemEval-S

Full 500-question evaluation. R@5 = **98.9%**, R@10 = **99.6%**.

- Agent model: StepFun `step-3.7-flash` (`reasoning_effort=high`), single non-frontier model
- Zero embedding model. Zero vector DB. Zero ingestion LLM calls.
- From single-shot grep baseline of 24% → 98.9% via agent-as-retriever pattern

Reproduce: `LIMIT=500 MAX_TURNS=10 CONCURRENCY=4 node eval/longmemeval-s-agent.mjs`

See [README.html](README.html) for full ablation table, per-type breakdown, and failure analysis.

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

## Wire into Claude Code

```bash
claude mcp add grepmem -- node /absolute/path/to/mcp-server.mjs
```

6 tools exposed: `memory_recall`, `memory_read`, `memory_list`, `memory_store`, `memory_grep`, `memory_find_symbol`.

## Project structure

```
memory-html.js     # Core engine (MemoryEngine class)
html-template.js   # HTML serialization/deserialization
grep.js            # Multi-pass grep retrieval + synonym map
learner.js         # Fail-improve loop (synonym auto-learning)
mcp-server.mjs     # MCP server (6 tools, stdio transport)
server.mjs         # HTTP API server
eval/              # Benchmarks, unit tests, scale tests
bench/             # Supermemory MemoryBench integration (fork)
```

## Key files

| File | Purpose |
|------|---------|
| [`README.html`](README.html) | Full product overview with styling |
| [`DESIGN.md`](DESIGN.md) / [`DESIGN.html`](DESIGN.html) | Architecture deep-dive |
| [`LICENSE`](LICENSE) | MIT |

## Tests

```bash
npm test           # 76 unit tests (engine + html + errors)
npm run test:scale # 9 scale tests (100 / 1K / 10K nodes, concurrency)
```

## License

MIT — see [LICENSE](LICENSE).
