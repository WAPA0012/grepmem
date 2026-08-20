# grepmem on MemoryAgentBench — End-to-End Evaluation

Independent end-to-end (E2E) evaluation of grepmem on **MemoryAgentBench** (MAB, ICLR 2026,
[arXiv 2507.05257](https://arxiv.org/abs/2507.05257)): **21 task configurations, 3,671 queries**,
using grepmem's own agent-as-retriever configuration (MAX_TURNS=10, three tools, hard-rules prompt,
per-type tips) as the retrieval layer.

This fills the roadmap item *"End-to-end QA evaluation on LongMemEval (retrieve → answer → judge)"*
with a retrieval-vs-answer attribution analysis, and documents a content-filter behavior of the
StepFun `step_plan` gateway that affects reproducibility (see [§451](#step_plan-gateway-content-filter)).

## TL;DR

| Task family | Result |
|---|---|
| Lexical-hit tasks (RULER, EventQA, ICL, FC-SH) | **76–97% official, up to 98% answered-only** — grep retrieval is top-tier |
| Multi-hop conflict resolution (FC-MH) | 15–70%, degrades with context length — needs cross-fact reasoning |
| LongMemEval-S* E2E | **34.7% official / 36.6% answered-only** — see [attribution](#longmemeval-s-why-e2e-is-harder-than-r5) |
| grepmem's published 98.9% | R@5 **retrieval** recall on whole sessions — a different protocol, not contradicted |

## Results (official / answered-only)

`official` = substring_exact_match over all queries. `answered-only` = hits ÷ (n − empty outputs);
empty outputs are queries where answer generation was blocked by the endpoint content filter
(see §451) — they say nothing about retrieval quality.

| Config | n | official | answered-only | empty |
|---|---|---|---|---|
| factconsolidation-sh-6k | 100 | **97.0** | 98.0 | 1 |
| ruler_qa1-197K | 100 | **93.0** | 93.9 | 1 |
| factconsolidation-sh-32k | 100 | **91.0** | 94.8 | 4 |
| icl_banking77 | 100 | **90.0** | 96.8 | 7 |
| eventqa-64k | 500 | 88.6 | **98.4** | 50 |
| factconsolidation-sh-64k | 100 | 88.0 | 91.7 | 4 |
| icl_clinic150 | 100 | 84.0 | 94.4 | 11 |
| eventqa-128k | 500 | 82.6 | **96.5** | 72 |
| icl_nlu | 100 | 76.0 | 90.5 | 16 |
| ruler_qa2-421K | 100 | 76.0 | 76.8 | 1 |
| factconsolidation-mh-6k | 100 | 70.0 | 76.9 | 9 |
| eventqa-full | 500 | 55.2 | **87.9** | 186 |
| detective-qa | 71 | 49.3 | 85.4 | 30 |
| icl_trec_coarse | 100 | 37.0 | **84.1** | 56 |
| **longmemeval-s\*** | 300 | **34.7** | 36.6 | 16 |
| icl_trec_fine | 100 | 31.0 | 72.1 | 57 |
| factconsolidation-mh-32k | 100 | 34.0 | 49.3 | 31 |
| factconsolidation-mh-64k | 100 | 22.0 | 32.4 | 32 |
| factconsolidation-mh-262k | 100 | 15.0 | 34.9 | 57 |
| infbench-sum | 100 | 0.0\* | — | 33 |

\* substring metric is not applicable to summarization; rougeL-f1 = 10.5 (compare against
same-task baselines only). `recsys_redial` was not run (requires an entity-mapping asset not
present in the local data bundle).

LongMemEval-S* per question type: single-session-assistant 66.7%, single-session-user 64.4%,
knowledge-update 42.2%, temporal-reasoning 25.3%, multi-session 22.7%, single-session-preference 0.0%
(gold answers are long derived statements; substring scoring requires near-verbatim reproduction,
which concise-answer prompts never produce — an answering-layer artifact, not retrieval failure).

## Setup

- **Benchmark**: MemoryAgentBench harness, local parquet data (`max_test_samples=5` for
  LongMemEval-S\* = 5 × 60 = 300 queries; other configs as listed).
- **Protocol**: contexts are chunked to 4,096 tokens and streamed to the memory system
  (`Add`-equivalent per chunk); per query the agent retrieves, then one generator call answers.
- **Adapter**: `AgentWrapper` type `gpm` in the MAB `agent.py` (see `gpm_mab_adapter.py`).
  Memorize → one `conversation` node per chunk (`summary: "chunk N"`, unique per context).
  Query → the agent-as-retriever loop ported from `eval/longmemeval-s-agent.mjs`
  (MAX_TURNS=10; `memory_recall` with spreadDepth 0 / `memory_grep` / `memory_read`;
  hard-rules prompt; 6-way type tip selected by a zero-temperature classifier; verified > grep >
  recall-count ranking), then the top-10 ranked chunks' full bodies are answered from with a
  BM25-shaped prompt for baseline comparability.
- **Generator**: `step-3.7-flash` (temperature 0, `enable_thinking: false`,
  `max_tokens ≥ 2000` with a 6000-token retry on empty content). The MAB paper's table uses
  gpt-4o-mini — absolute numbers are not directly comparable to the paper.
- **Server**: this branch adds `/grep` (raw rg over memory.html, line→article mapping) and
  `/read` (fetch by summary label), plus `GREPMEM_DEDUP_THRESHOLD` env (we run 1.01 = disabled,
  matching `eval/longmemeval-s-agent.mjs`; chunk streams share tags and 0.85 silently drops them).
- **Cost/latency**: ~5–10 LLM calls per query, ~30–50 s/query sequential.

## LongMemEval-S\*: why E2E is harder than R@5

Measured against a BM25 baseline on identical chunks / generator / scoring:

| | grepmem | BM25 |
|---|---|---|
| E2E substring_exact_match | 34.7% | 41.3% |
| Single-shot recall, gold in top-10 | 32.0% | **51.7%** |
| Single-shot recall, gold in top-30 | 40.3% | — |
| Answer-context volume (tokens) | ~41.5K (10 chunks) | ~41.5K |

Attribution:

1. **MAB shreds the structures grepmem relies on.** MAB streams 4,096-token chunks, so sessions
   fragment across nodes; node ids become `chunk N`; per-session timestamps only survive inside
   text. The types grepmem's own harness scores 98–100% (knowledge-update, temporal) depend on
   session-level structure and drop to 42% / 25% under chunking.
2. **High-weight channels idle on raw text.** Trigger (×3.0) and tag (×2.0) surfaces are designed
   for structured knowledge cards; with verbatim chunks the score degenerates to a single
   fulltext channel with a harsh max-possible-score normalization — weaker ranking than BM25's
   tf-idf saturation on "which chunk talks about X most" queries (−20 pt top-10 gold coverage).
3. **The loop adds +2.7 pt** (32.0% coverage → 34.7% E2E) but cannot close a 20 pt base gap.
4. Not the cause: context volume (identical), empty outputs (fewer than BM25's), access-count
   pollution (hit rate flat across within-context position), matchThreshold truncation (recall
   always returns 10).

Also observed: the synonym learner is stateful across queries in one namespace, making retrieval
order-dependent (two identical replays differed by 9/300 queries). For batch evaluation, isolate
namespaces per history or disable the learner.

## Optimization iteration: v2 → v2g (what transfers and what doesn't)

Following the attribution above, we added three literature-backed layers and measured them
across the full suite (uniform config, no dataset labels):

1. **Session reconstruction** — split the chunk stream on `Chat Time:` markers into whole-session
   nodes with parsed timestamps (content-triggered at ≥3 markers; LongMemEval-native granularity,
   Zep/MemOS-style temporal binding).
2. **BM25 + RRF fusion** (k=60) of the loop ranking with BM25 over the same nodes (hybrid
   retrieval standard; our measured BM25 top-10 gold coverage was +20pt over single-pass grep
   on conversational text).
3. **Chain-of-Note / quote-recency answering** — date-prefixed memory blocks, brief notes then
   `Answer:` line, verbatim quoting for preference questions, latest-date wins on conflicts
   (LongMemEval authors report +10pt from structured reading prompts).

**Result on LongMemEval-S\*: 34.7% → 48.3% (v2 global) → 49.3% (v2g)** — beating the BM25
baseline (41.3%) by 7pt. Per-type gains vs v1: knowledge-update 42.2→64.4, multi-session
22.7→45.3, temporal 25.3→40.0, single-session-user 64.4→75.6. single-session-preference stays
0/30 for every system including BM25: gold answers are annotator-derived statements not present
verbatim in the haystack — structurally unanswerable under substring scoring.

**But the fusion stack transfers negatively to synthetic exact-match corpora** (uniform v2,
Δ vs v1): RULER-q1 **−16**, factconsolidation-mh-6k **−23**, sh −4…−7, ICL −6…−9. On needle
corpora, grep's exact-token channels are already optimal and BM25's tf-idf ranking dilutes
them in the RRF merge. Query-weighted, global v2 is net-negative across the suite.

**v2g (final): content-gated.** The fusion + CoN answering stack activates only when session
markers were detected (conversational corpora); everything else falls back to the v1 path
byte-for-byte. Zero dataset labels — pure content adaptation. Final numbers:
**LongMemEval-S\* 49.3% official / 49.8% answered-only (3/300 empty)** with all other configs
keeping their v1 scores above.

| | LME-S\* official | notes |
|---|---|---|
| BM25 baseline (same generator/scoring) | 41.3 | single-shot retrieve top-10 |
| grepmem v1 (agent loop) | 34.7 | loop +2.7pt over single-shot 32% coverage |
| **grepmem v2g (final)** | **49.3** | + sessions+timestamps, BM25 RRF, CoN answering |

## step_plan gateway content filter

Answering EventQA (detective/crime novels) through `api.stepfun.com/step_plan/v1` triggers
HTTP 451 `{'type': 'censorship_blocked'}` at scale. Controlled experiments:

- Deterministic per payload: a blocked prompt fails 10/10; passes under zero load. A passing
  prompt passes 3/3 solo **and** 3/3 while 6 concurrent blocked prompts are being rejected —
  the decision is content-determined, not load-determined.
- Input-side: fails even with `max_tokens=1`.
- Density-based, not keyword-blocklist: a flagged 4.2K-char segment fails alone but passes when
  diluted 1:1 with neutral text; no isolated short span triggers alone.
- Endpoint-specific: the identical payload passes on `api.stepfun.com/v1` (separate pay-as-you-go
  quota; the Step Plan subscription does not cover it).

Impact: official scores on eventqa-full/128k and the trec pair are suppressed 20–50 pt
(the `empty` column); answered-only scores reflect retrieval quality. Synthetic-text tasks
(RULER, factconsolidation) never trigger it.

## Reproduce

1. Set up [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) with local parquet data.
2. Apply `gpm_mab_adapter.py` methods to its `agent.py` and register the `gpm` type.
3. Run the grepmem server: `MEMORY_PORT=18235 MEMORY_PATH=<ns> GREPMEM_DEDUP_THRESHOLD=1.01 node server.mjs`
4. `OPENAI_BASE_URL=… OPENAI_API_KEY=… python main.py --agent_config <gpm.yaml> --dataset_config <cfg> --force`

Query-level checkpointing is built into MAB; delete a config's `*results.json` before re-running
it from scratch (`--force` does not bypass per-query resume).
