/**
 * LongMemEval-S agent-as-retriever benchmark.
 *
 * Difference from longmemeval-s-retrieval.mjs:
 *   - retrieval.mjs: single-shot recall(query) → top-K, score = R@K
 *   - agent.mjs:     LLM is the retriever. It calls memory_recall with
 *                    its own queries, up to MAX_TURNS times. Final score
 *                    = R@K over the union of session_ids it surfaced.
 *
 * This is the configuration that matches the published "grep beats
 * embedding" results (PwC arXiv:2605.15184, Amazon AAAI 2026). Single-shot
 * grep competes with single-shot embedding and loses; agentic grep with
 * query rewriting wins.
 *
 * Run: LIMIT=20 MAX_TURNS=5 node eval/longmemeval-s-agent.mjs
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const DATA_PATH = join(ROOT, 'data', 'longmemeval_s_cleaned.json');

const API_KEY = process.env.OPENAI_API_KEY || process.env.LLM_KEY;
const API_BASE = (process.env.OPENAI_BASE_URL || process.env.LLM_BASE || '').replace(/,+$/, '');
const API_MODEL = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'step-3.7-flash';
const LIMIT = parseInt(process.env.LIMIT || '20', 10);
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '5', 10);
const TOP_K = parseInt(process.env.TOP_K || '5', 10);
// Concurrency: how many questions to run in parallel. Step Plan endpoint
// allows 5 concurrent requests per account. We use CONCURRENCY=4 to leave
// headroom for the OS + occasional re-tries. Each question is independent
// (its own namespace), so parallel runs are safe.
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
// Per-process API call gap. Step Plan endpoint has no RPM limit (only concurrency).
// Set to 100ms just to avoid burning CPU on tight loops; the real throttle is
// the 5-concurrency cap.
const API_GAP_MS = parseInt(process.env.API_GAP_MS || '100', 10);
// Optional filter: TYPES=single-session-user,single-session-preference
const TYPES = process.env.TYPES ? process.env.TYPES.split(',') : null;

if (!API_KEY || !API_BASE) {
  console.error('Need OPENAI_API_KEY + OPENAI_BASE_URL');
  process.exit(1);
}

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
console.log(`LongMemEval-S Agent: ${data.length} total questions`);
console.log(`Config: LIMIT=${LIMIT} MAX_TURNS=${MAX_TURNS} TOP_K=${TOP_K}`);
console.log(`Model: ${API_MODEL}\n`);

let pool = data.filter(d => !d.question_id.endsWith('_abs'));
if (TYPES) {
  pool = pool.filter(d => TYPES.includes(d.question_type));
  console.log(`Filtered to types ${TYPES}: ${pool.length} questions`);
}
// Override: explicit list of question_ids. Useful for regression testing
// specific failure cases without re-running the full sample.
// Usage: FIXED_IDS=0862e8bf,36580ce8,60d45044 node ...
const FIXED_IDS = process.env.FIXED_IDS ? process.env.FIXED_IDS.split(',') : null;
let sampled;
if (FIXED_IDS) {
  sampled = pool.filter(d => FIXED_IDS.includes(d.question_id));
  // Preserve the order the user passed in
  sampled.sort((a, b) => FIXED_IDS.indexOf(a.question_id) - FIXED_IDS.indexOf(b.question_id));
  console.log(`Fixed IDs ${FIXED_IDS}: matched ${sampled.length} questions`);
} else {
  sampled = pool.sort(() => Math.random() - 0.5).slice(0, LIMIT);
}
console.log(`Sampled ${sampled.length} evaluable questions\n`);

// ─── LLM call (StepFun rate limit: RPM=10, gap ≥7s) ─────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function callLLM(messages, tools = undefined) {
  const now = Date.now();
  const gap = API_GAP_MS - (now - lastCall);
  if (gap > 0) await sleep(gap);
  lastCall = Date.now();
  const DEBUG = process.env.DEBUG === '1';

  const body = {
    messages,
    model: API_MODEL,
    temperature: 0.2,
    reasoning_effort: 'high',
  };
  if (tools) body.tools = tools;

  const payload = JSON.stringify(body);

  const scriptPath = join(tmpdir(), `lme_agent_${process.pid}_${Date.now()}.py`);
  const script = `
import urllib.request, json, os
for k in ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY']:
    os.environ.pop(k, None)
data = json.loads(${JSON.stringify(payload)})
req = urllib.request.Request('${API_BASE}/chat/completions',
  data=json.dumps(data).encode(),
  headers={'Content-Type':'application/json','Authorization':'Bearer ${API_KEY}'})
r = urllib.request.urlopen(req, timeout=180)
obj = json.loads(r.read().decode())
print(json.dumps(obj))
`;
  writeFileSync(scriptPath, script, 'utf8');
  try {
    const out = execSync(`python "${scriptPath}"`, { encoding: 'utf8', timeout: 200000 });
    const m = out.trim().match(/\{[\s\S]*\}\s*$/);
    if (!m) throw new Error('no JSON from API');
    const obj = JSON.parse(m[0]);
    const msg = obj.choices[0].message;
    if (DEBUG) {
      console.log(`\n  [LLM reply] tool_calls=${(msg.tool_calls||[]).length} content_len=${(msg.content||'').length}`);
      if (msg.content) console.log(`    content: ${msg.content.slice(0, 200)}`);
    }
    return msg;
  } catch (e) {
    console.log(`  [llm error] ${e.message.slice(0, 150)}`);
    return null;
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

// ─── Run one question through the agent loop ────────────────────────────────

const RECALL_TOOL = {
  type: 'function',
  function: {
    name: 'memory_recall',
    description: 'Semantic search via scored multi-pass grep. Returns ranked hits with summaries (first ~200 chars). Use this as your primary discovery tool. The summary starts with "LME <session_id>".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        typeFilter: { type: 'string', enum: ['conversation', 'knowledge'] },
        limit: { type: 'integer', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
  },
};

const GREP_TOOL = {
  type: 'function',
  function: {
    name: 'memory_grep',
    description: 'Raw regex grep over the memory HTML. Returns line-level matches with their LME session_ids. Use when memory_recall misses because your query uses a specific token (name, date, IP, error code, exact phrase). Use memory_read on a hit to verify.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern. Examples: "Sarah", "Spring 2023", "Boston", " hiking".' },
        limit: { type: 'integer', description: 'Max matches (default 15).' },
      },
      required: ['pattern'],
    },
  },
};

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'memory_read',
    description: 'Read the FULL content of one memory by LME session_id. Use to verify a candidate actually contains the answer before promoting it to your final list. The conversation field has verbatim chat transcripts.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The LME session_id, e.g. "abc12345_1".' },
      },
      required: ['sessionId'],
    },
  },
};

const AGENT_TOOLS = [RECALL_TOOL, GREP_TOOL, READ_TOOL];

// ─── Local ripgrep helper (mirrors mcp-server.mjs grepMemoryFile) ───────────
function grepHtml(pattern, htmlPath, articles, limit = 15) {
  if (!existsSync(htmlPath)) return [];
  let raw;
  try {
    raw = execFileSync('rg', [
      '-n', '--no-heading', '-i',
      '--max-count', String(limit * 3),
      '-e', pattern,
      htmlPath,
    ], { encoding: 'utf8', timeout: 5000, maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.status === 1) return [];
    if (e.status === 2) return [];
    throw e;
  }

  // Map line → article (by line range)
  const lines = readFileSync(htmlPath, 'utf8').split('\n');
  const ranges = new Map();
  let curId = null, curStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/<article\s+[^>]*id="([^"]+)"/);
    if (open) { curId = open[1]; curStart = i + 1; }
    if (curId && lines[i].includes('</article>')) { ranges.set(curId, { start: curStart, end: i + 1 }); curId = null; }
  }
  // Also map LME session_id from summary text
  const idToSession = new Map();
  for (const [id, node] of articles) {
    const m = node.summary?.match(/LME (\S+)/);
    if (m) idToSession.set(id, m[1]);
  }

  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\d+):(.*)$/);
    if (!m) continue;
    const lineNum = parseInt(m[1]);
    const text = m[2];
    // Skip noise lines
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('<article ') || trimmed.startsWith('</article') ||
        trimmed.startsWith('<!-- ') || trimmed.startsWith('<!') ||
        trimmed.startsWith('<html') || trimmed.startsWith('<head') ||
        trimmed.startsWith('<meta ') || trimmed.startsWith('<title>') ||
        trimmed.startsWith('<style') || trimmed.startsWith('</style') ||
        trimmed.startsWith('<body') || trimmed.startsWith('</body') ||
        trimmed.startsWith('</html') || trimmed.startsWith('<h1>') ||
        trimmed.startsWith('<h2>') || trimmed.startsWith('<ul class="triggers"') ||
        trimmed.startsWith('<nav class="edges"') || trimmed.startsWith('<p class="detail"')) continue;
    // Find which article owns this line
    let ownerArticle = null;
    for (const [aid, r] of ranges) {
      if (lineNum >= r.start && lineNum <= r.end) { ownerArticle = aid; break; }
    }
    if (!ownerArticle) continue;
    const session = idToSession.get(ownerArticle);
    if (!session) continue;
    if (seen.has(session + ':' + lineNum)) continue;
    seen.add(session + ':' + lineNum);
    out.push({ sessionId: session, line: lineNum, text: trimmed.slice(0, 250) });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Type-aware system prompts ──────────────────────────────────────────────
// Different LongMemEval question types have different failure modes. Tailoring
// the strategy section per type gives the agent a head start without changing
// any other code. Inspired by Chronos (arXiv:2605.15184) dynamic prompting.
const TYPE_TIPS = {
  'single-session-user': `TIP: The answer is in ONE session where the USER said it directly. Search for the topic noun (e.g. "marathon", "allergy", "company"). The user may have mentioned it casually — broaden with synonyms if exact match misses.`,
  'single-session-assistant': `TIP: The answer is in ONE session where the ASSISTANT (AI) said it. The user asked something, AI responded with the answer. Search the user's question keywords, then read the AI reply.`,
  'single-session-preference': `TIP: The answer is a preference/like/dislike the user expressed. Search for the topic noun AND preference verbs: "love", "like", "favorite", "enjoy", "hate", "prefer", "want", "wish".`,
  'multi-session': `TIP: The answer requires info from MULTIPLE sessions (often 2-3). Each session has part of the story. Don't stop after one verified hit — collect 3+ sessions that each contain a piece. Common pattern: "what's the difference between X and Y" → one session per topic.`,
  'temporal-reasoning': `TIP: The answer requires TIMELINE reasoning — order of events, latest/earliest, "what changed". Use memory_grep with date tokens ("2023", "January", "last month", "yesterday", "Spring"). When verifying, pay attention to timestamps. The CORRECT session may not be the most recent — re-read the question to know which time period it asks about.`,
  'knowledge-update': `TIP: The user's preference/answer CHANGED OVER TIME. The question asks for the CURRENT (latest) value. Find ALL sessions mentioning the topic, then verify which has the LATEST timestamp. Don't pick the first match — pick the most recent.`,
};

function buildSystemPrompt(questionType) {
  const tip = TYPE_TIPS[questionType] || '';
  return `You are a retrieval agent searching chat-history memory for the answer to a user question.

You have THREE tools. Use them in this workflow:

1. **memory_recall(query, typeFilter, limit)** — primary discovery. Multi-pass grep with scoring. Returns ranked hits with summaries. Each summary starts with "LME <session_id>".

2. **memory_grep(pattern, limit)** — raw regex grep. Use when recall misses or you want to find an exact token (name, date, place). Returns matching lines + their session_ids.

3. **memory_read(sessionId)** — read the FULL content of one memory. Use to VERIFY a candidate. Reading a session that contains the answer is the strongest signal you can give.

STRATEGY (HARD RULES):
- Rule 1: First 3 turns MUST include AT LEAST 2 distinct memory_recall queries. Do NOT spend the first 5 turns only reading.
- Rule 2: Never read more than 3 sessions before issuing another recall/grep with a DIFFERENT query. If recall top-5 don't contain an obvious answer, RECALL AGAIN with synonyms/paraphrases — don't blindly read all 5.
- Rule 3: Diversify. If "marathon" gave no answer, try "race", "running", "5K", "training". If a date didn't work, try the place. If the noun didn't work, try the verb.
- Rule 4: Stop early. Once you've VERIFIED a session that clearly contains the answer, output the final JSON immediately. Don't keep searching for "more".
- Rule 5: Budget is up to ${MAX_TURNS} tool calls. Spend ≥4 of them on recall/grep, ≤${Math.min(6, MAX_TURNS - 2)} on read.

${tip}

OUTPUT (final turn only): Reply with ONLY a JSON array of session_id strings.
Format: ["session-id-1", "session-id-2"]
List the ones you've verified first, then unverified candidates.`;
}

async function runAgent(question, engine, questionType = null) {
  // sessionId → { turn, verified, score }
  // verified=true means agent called memory_read on it.
  // Higher score = more confidence: verified > grep-hit > recall-only.
  const collected = new Map();
  // Trace for post-hoc diagnosis. Each entry: { turn, tool, args, hitSids[], replyLen }
  const trace = [];
  const record = (sid, turn, opts = {}) => {
    const existing = collected.get(sid);
    if (existing) {
      if (opts.verified) existing.verified = true;
      if (opts.grepHit) existing.grepHit = true;
      existing.score = (existing.verified ? 100 : 0) + (existing.grepHit ? 10 : 0) + existing.recallCount;
      existing.recallCount = (existing.recallCount || 0) + (opts.recall ? 1 : 0);
    } else {
      const rec = { turn, verified: !!opts.verified, grepHit: !!opts.grepHit, recallCount: opts.recall ? 1 : 0 };
      rec.score = (rec.verified ? 100 : 0) + (rec.grepHit ? 10 : 0) + rec.recallCount;
      collected.set(sid, rec);
    }
  };

  const systemPrompt = buildSystemPrompt(questionType);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `QUESTION: ${question}\n\nStart searching. Call memory_recall NOW.` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await callLLM(messages, AGENT_TOOLS);
    if (!reply) break;

    const toolCalls = reply.tool_calls || [];
    if (toolCalls.length > 0) {
      messages.push(reply);
      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        let toolResult;

        if (tc.function.name === 'memory_recall') {
          const results = await engine.land(args.query || '', 0, args.typeFilter || null);
          const top = results.slice(0, args.limit || 5);
          const lines = top.map((r, i) => {
            const m = r.summary?.match(/LME (\S+)/);
            const sid = m ? m[1] : r.id;
            return `${i + 1}. [LME ${sid}] score=${r.match}\n   ${(r.summary || '').slice(0, 200)}`;
          }).join('\n');
          toolResult = top.length ? `Recall results for "${args.query}":\n${lines}\n\nCall memory_read on a candidate to verify, or memory_grep for specific tokens.` : `No recall matches for "${args.query}". Try memory_grep with specific tokens.`;
          const hitSids = [];
          for (const r of top) {
            const m = r.summary?.match(/LME (\S+)/);
            if (m) { record(m[1], turn, { recall: true }); hitSids.push(m[1]); }
          }
          trace.push({ turn, tool: 'recall', query: args.query, hitSids, topScore: top[0]?.match });
        } else if (tc.function.name === 'memory_grep') {
          const matches = grepHtml(args.pattern || '', engine.htmlPath, engine._articles, args.limit || 15);
          if (matches.length === 0) {
            toolResult = `No lines matched /${args.pattern}/.`;
          } else {
            const lines = matches.map((m, i) => `${i + 1}. [LME ${m.sessionId}] line ${m.line}:\n   ${m.text}`).join('\n');
            toolResult = `${matches.length} grep match(es) for /${args.pattern}/:\n${lines}`;
            for (const m of matches) record(m.sessionId, turn, { grepHit: true });
          }
          trace.push({ turn, tool: 'grep', pattern: args.pattern, hitSids: matches.map(m => m.sessionId) });
        } else if (tc.function.name === 'memory_read') {
          // Map LME session_id → article by summary match
          let targetArticle = null;
          for (const [id, node] of engine._articles) {
            const m = node.summary?.match(/LME (\S+)/);
            if (m && m[1] === args.sessionId) { targetArticle = id; break; }
          }
          if (!targetArticle) {
            toolResult = `Session ${args.sessionId} not found.`;
          } else {
            const node = await engine.focus(targetArticle);
            const conv = node.conversation || '(no conversation text)';
            // Truncate very long conversations to keep context manageable
            const trimmed = conv.length > 1500 ? conv.slice(0, 1500) + '...[truncated]' : conv;
            toolResult = `LME ${args.sessionId} full content:\n${trimmed}`;
            record(args.sessionId, turn, { verified: true });
          }
          trace.push({ turn, tool: 'read', sessionId: args.sessionId, found: !!targetArticle });
        } else {
          toolResult = `Unknown tool ${tc.function.name}`;
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
      }
      continue;
    }

    // No tool call → check if final answer
    const content = reply.content || '';
    const finalMatch = content.match(/\[\s*"([^"]+)"(?:\s*,\s*"([^"]+)")*\s*\]/);
    if (finalMatch) {
      const ids = [...content.matchAll(/"([^"]+)"/g)]
        .map(m => m[1].replace(/^LME\s+/, '').trim());
      // Final list order = agent's stated priority. Add to collected (low priority if not already there).
      for (let i = 0; i < ids.length; i++) {
        const sid = ids[i];
        if (!collected.has(sid)) {
          // Unverified late-add; rank by position in agent's answer
          collected.set(sid, { turn, verified: false, grepHit: false, recallCount: 0, score: 50 - i });
        }
      }
      break;
    }

    // Nudge
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: `Continue. Use memory_recall/grep to find more, OR output your final JSON array. ${collected.size} candidates so far (${[...collected.values()].filter(c => c.verified).length} verified).`,
    });
  }

  // Rank: verified > grepHit > recallCount > agent-list order
  // Return ordered list + trace for diagnosis.
  const rankedIds = [...collected.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([sid]) => sid);
  const collectedMeta = Object.fromEntries(
    [...collected.entries()].map(([sid, c]) => [sid, { verified: c.verified, grepHit: c.grepHit, recallCount: c.recallCount, score: c.score }])
  );
  return { ids: rankedIds, trace, collectedMeta };
}

// ─── Main loop ──────────────────────────────────────────────────────────────
const TYPE_NAMES = {
  'single-session-user': 'ss-user',
  'single-session-assistant': 'ss-asst',
  'single-session-preference': 'ss-pref',
  'multi-session': 'multi',
  'temporal-reasoning': 'temporal',
  'knowledge-update': 'update',
};

// Checkpoint: per-question record appended to .failures/_progress.jsonl.
// On restart, we skip questions already in the file and restore cumulative
// stats so the final report aggregates across all sessions. Set RESUME=0 to
// force a clean run (deletes the checkpoint).
const CHECKPOINT_PATH = join(ROOT, '.failures', '_progress.jsonl');
const RESUME = (process.env.RESUME || '1') !== '0';
if (!RESUME && existsSync(CHECKPOINT_PATH)) {
  unlinkSync(CHECKPOINT_PATH);
  console.log(`RESUME=0 → cleared checkpoint`);
}
if (!existsSync(dirname(CHECKPOINT_PATH))) {
  mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true });
}

let hitAt5 = 0, hitAt10 = 0, total = 0;
const perType = {};
const perTurns = {};  // turn count distribution
const doneQids = new Set();  // question_ids already in checkpoint

if (RESUME && existsSync(CHECKPOINT_PATH)) {
  const lines = readFileSync(CHECKPOINT_PATH, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      doneQids.add(r.qid);
      total++;
      if (r.h5) hitAt5++;
      if (r.h10) hitAt10++;
      const t = r.type;
      if (!perType[t]) perType[t] = { hit5: 0, hit10: 0, total: 0 };
      perType[t].total++;
      if (r.h5) perType[t].hit5++;
      if (r.h10) perType[t].hit10++;
      const bucket = r.collectedCount || 0;
      perTurns[bucket] = (perTurns[bucket] || 0) + 1;
    } catch {}
  }
  if (doneQids.size > 0) {
    console.log(`Resumed from checkpoint: ${doneQids.size} questions already done (R@5=${(hitAt5/total*100).toFixed(0)}% R@10=${(hitAt10/total*100).toFixed(0)}%)`);
  }
}

// Append-only handle. We open once per run to avoid file-lock races with
// concurrent processes; this script is single-threaded so a sync write per
// question is fine.
const checkpointStream = await import('fs').then(m => m.createWriteStream(CHECKPOINT_PATH, { flags: 'a' }));

const start = Date.now();

async function processQuestion(item, qi) {
  const question = item.question;
  const answerIds = item.answer_session_ids || [];
  const typeShort = TYPE_NAMES[item.question_type] || item.question_type;

  // Fresh namespace per question (worker-id tagged to avoid collision)
  const ns = join(ROOT, `.lme-agent-${process.pid}-${qi}-${Math.random().toString(36).slice(2, 8)}`);
  if (existsSync(ns)) rmSync(ns, { recursive: true });

  const engine = new MemoryEngine({ basePath: ns });
  await engine.init();
  engine.config.dedupThreshold = 1.01;

  // Ingest sessions
  const sessionIds = item.haystack_session_ids;
  const sessions = item.haystack_sessions;
  for (let si = 0; si < sessions.length; si++) {
    const turns = sessions[si];
    if (!Array.isArray(turns)) continue;
    const origId = sessionIds[si];
    const date = item.haystack_dates ? item.haystack_dates[si] : '';
    const body = turns
      .map(t => `${t.role === 'user' ? 'User' : 'AI'}: ${t.content}`)
      .join('\n');
    if (!body.trim()) continue;
    await engine.add({
      type: 'conversation',
      summary: `LME ${origId}`,
      conversation: body,
      timestamp: date,
      author: 'lme',
    });
  }
  await engine._flush();

  // Run agent
  const { ids: agentSessionIds, trace, collectedMeta } = await runAgent(question, engine, item.question_type);

  const top5 = agentSessionIds.slice(0, 5);
  const top10 = agentSessionIds.slice(0, 10);
  const h5 = top5.some(id => answerIds.includes(id));
  const h10 = top10.some(id => answerIds.includes(id));

  // Dump trace on miss for post-hoc diagnosis
  if (!h10) {
    const failDir = join(ROOT, '.failures', typeShort);
    if (!existsSync(failDir)) mkdirSync(failDir, { recursive: true });
    const failPath = join(failDir, `${item.question_id || 'q' + qi}.json`);
    const missedAnswers = [];
    for (const aid of answerIds) {
      const sIdx = sessionIds.indexOf(aid);
      if (sIdx < 0) continue;
      const turns = sessions[sIdx];
      if (!Array.isArray(turns)) continue;
      missedAnswers.push({
        sessionId: aid,
        text: turns.map(t => `${t.role === 'user' ? 'User' : 'AI'}: ${t.content}`).join('\n').slice(0, 2000),
      });
    }
    const dump = {
      questionId: item.question_id,
      questionType: item.question_type,
      question,
      expectedAnswer: item.answer,
      answerIds,
      top5Collected: top5,
      top10Collected: top10,
      allCollectedWithMeta: collectedMeta,
      trace,
      missedAnswerTexts: missedAnswers,
    };
    try { writeFileSync(failPath, JSON.stringify(dump, null, 2), 'utf8'); } catch {}
  }

  // Cleanup namespace
  rmSync(ns, { recursive: true });

  return { typeShort, h5, h10, collectedCount: agentSessionIds.length, qid: item.question_id };
}

// Build the work queue: skip already-done (checkpoint), keep the rest in order
const workQueue = sampled
  .filter(item => !doneQids.has(item.question_id))
  .map((item, i) => ({ item, qi: i }));
console.log(`Work queue: ${workQueue.length} questions to run (${doneQids.size} resumed/skipped), concurrency=${CONCURRENCY}\n`);

// Worker pool: each worker pulls from the queue, processes, and updates global state
let completedThisRun = 0;
async function worker(workerId) {
  while (workQueue.length > 0) {
    const job = workQueue.shift();
    if (!job) break;
    try {
      const result = await processQuestion(job.item, job.qi);
      const { typeShort, h5, h10, collectedCount, qid } = result;

      // Update global counters atomically (JS single-threaded; this is safe)
      if (!perType[typeShort]) perType[typeShort] = { hit5: 0, hit10: 0, total: 0 };
      perType[typeShort].total++;
      if (h5) { perType[typeShort].hit5++; hitAt5++; }
      if (h10) { perType[typeShort].hit10++; hitAt10++; }
      total++;
      const bucket = collectedCount;
      perTurns[bucket] = (perTurns[bucket] || 0) + 1;

      checkpointStream.write(JSON.stringify({ qid, type: typeShort, h5, h10, collectedCount }) + '\n');

      completedThisRun++;
      const icon = h5 ? '+' : (h10 ? '*' : '-');
      process.stdout.write(icon);
      if (completedThisRun % 5 === 0) {
        const h5pct = (hitAt5 / total * 100).toFixed(0);
        const h10pct = (hitAt10 / total * 100).toFixed(0);
        const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
        console.log(`  [${completedThisRun}/${workQueue.length + completedThisRun}] R@5=${h5pct}% R@10=${h10pct}% elapsed=${elapsedMin}min`);
      }
    } catch (e) {
      console.log(`\n[worker ${workerId} error on ${job.item.question_id}] ${e.message.slice(0, 200)}`);
    }
  }
}

// Spawn CONCURRENCY workers and wait for all to finish
const workers = [];
for (let w = 0; w < CONCURRENCY; w++) {
  workers.push(worker(w));
}
await Promise.all(workers);

// ─── Report ────────────────────────────────────────────────────────────────
console.log('\n\n=== LongMemEval-S Agent-as-Retriever Results ===\n');
console.log(`Config:    MAX_TURNS=${MAX_TURNS} TOP_K=${TOP_K} MODEL=${API_MODEL}`);
console.log(`Total:     ${total} questions${doneQids.size > 0 ? `  (${doneQids.size} resumed, ${total - doneQids.size} fresh this run)` : ''}`);
console.log(`R@5:       ${hitAt5} (${(hitAt5 / total * 100).toFixed(1)}%)`);
console.log(`R@10:      ${hitAt10} (${(hitAt10 / total * 100).toFixed(1)}%)`);
console.log(`\nPer-type:`);
const order = ['ss-user', 'ss-asst', 'ss-pref', 'multi', 'temporal', 'update'];
for (const t of order) {
  if (!perType[t]) continue;
  const s = perType[t];
  console.log(`  ${t.padEnd(10)} R@5=${(s.hit5 / s.total * 100).toFixed(0).padStart(3)}%  R@10=${(s.hit10 / s.total * 100).toFixed(0).padStart(3)}%  (n=${s.total})`);
}
console.log(`\nSessions collected per question:`);
for (const [n, count] of Object.entries(perTurns).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${n.padStart(3)} sessions: ${count} questions`);
}
console.log(`\nElapsed: ${((Date.now() - start) / 60000).toFixed(1)} min`);
console.log(`\nBaseline comparison:`);
console.log(`  Single-shot grep:  R@5 = 24%  R@10 = 49%  (this project, retrieval.mjs)`);
console.log(`  Agent-as-retriev:  R@5 = ${(hitAt5 / total * 100).toFixed(1)}%  R@10 = ${(hitAt10 / total * 100).toFixed(1)}%  (this run)`);
console.log(`  MemPalace (raw):   R@5 = 96.6%`);
console.log(`  GBrain:            R@5 = 97.6%`);
