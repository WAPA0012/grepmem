/**
 * LoCoMo retrieval-only benchmark.
 *
 * Strategy: for each question, ingest its haystack sessions, run recall(),
 * and use the existing framework's LLM-judge to score Hit@K. Skip answer
 * generation (the part that costs the most tokens).
 *
 * Designed for rate-limited APIs: concurrency=1, 1 LLM call per question.
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const LOCOCO_PATH = join(ROOT, 'bench', 'data', 'benchmarks', 'locomo', 'locomo10.json');

const API_KEY = process.env.OPENAI_API_KEY || process.env.LLM_KEY;
const API_BASE = (process.env.OPENAI_BASE_URL || process.env.LLM_BASE || '').replace(/,+$/, '');
const API_MODEL = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'step-3.7-flash';
const LIMIT = parseInt(process.env.LIMIT || '100', 10);
const CATEGORIES = (process.env.CATEGORIES || '1,2,3,4,5').split(',').map(Number);

if (!API_KEY || !API_BASE) {
  console.error('Need OPENAI_API_KEY + OPENAI_BASE_URL');
  process.exit(1);
}

const data = JSON.parse(readFileSync(LOCOCO_PATH, 'utf8'));
console.log(`LoCoMo: ${data.length} conversations, sampling up to ${LIMIT} questions in categories ${CATEGORIES}\n`);

// Collect questions, expanding per-conversation.
const allQ = [];
for (const conv of data) {
  for (const qa of conv.qa) {
    if (!CATEGORIES.includes(qa.category)) continue;
    allQ.push({ conv, qa });
    if (allQ.length >= LIMIT * 3) break;  // over-collect, sample later
  }
}
// Shuffle + cap
const sampled = allQ.sort(() => Math.random() - 0.5).slice(0, LIMIT);
console.log(`Sampled ${sampled.length} questions\n`);

const CATEGORY_NAMES = {
  1: 'single-hop',
  2: 'multi-hop',
  3: 'temporal',
  4: 'world-knowledge',
  5: 'adversarial',
};

let hitAt5 = 0, hitAt10 = 0, total = 0;
const perCategory = {};  // cat → { hit5, hit10, total }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function judgeHit(question, answer, topResults) {
  const now = Date.now();
  const gap = 7000 - (now - lastCall);  // StepFun RPM=10 → 6s+ safety
  if (gap > 0) await sleep(gap);
  lastCall = Date.now();

  const prompt = `You are evaluating search results.

QUESTION: ${question}
EXPECTED ANSWER: ${answer}

SEARCH RESULTS (top ${topResults.length}):
${topResults.map((r, i) => `--- Result ${i + 1} (id=${r.id}) ---\n${r.conversation || r.detail || r.summary}`).join('\n\n')}

For each result, decide: does this result contain information that helps answer the question?
Return JSON: [{"i": 1, "hit": true}, {"i": 2, "hit": false}, ...]
"hit" is true if the result contains the answer OR directly relevant evidence.`;

  const payload = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a precise retrieval evaluator. Output JSON only.' },
      { role: 'user', content: prompt },
    ],
    model: API_MODEL,
    temperature: 0.1,
  });

  const scriptPath = join(tmpdir(), `locomo_judge_${process.pid}_${Date.now()}.py`);
  const script = `
import urllib.request, json, os
for k in ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY']:
    os.environ.pop(k, None)
data = json.loads(${JSON.stringify(payload)})
req = urllib.request.Request('${API_BASE}/chat/completions',
  data=json.dumps(data).encode(),
  headers={'Content-Type':'application/json','Authorization':'Bearer ${API_KEY}'})
r = urllib.request.urlopen(req, timeout=60)
obj = json.loads(r.read().decode())
print(obj['choices'][0]['message']['content'])
`;
  const { writeFileSync, unlinkSync } = await import('fs');
  writeFileSync(scriptPath, script, 'utf8');
  try {
    const out = execSync(`python "${scriptPath}"`, { encoding: 'utf8', timeout: 90000 });
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return topResults.map((_, i) => ({ i: i + 1, hit: false }));
    return JSON.parse(m[0]);
  } catch (e) {
    console.log(`  [judge error] ${e.message.slice(0, 100)}`);
    return topResults.map((_, i) => ({ i: i + 1, hit: false }));
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────
const start = Date.now();

for (let qi = 0; qi < sampled.length; qi++) {
  const { conv, qa } = sampled[qi];
  const sessionId = conv.sample_id;
  const question = qa.question;
  const expected = qa.answer;
  const cat = qa.category;
  const catName = CATEGORY_NAMES[cat] || `cat-${cat}`;

  // Fresh namespace per question (each Q has its own haystack)
  const ns = join(ROOT, `.locomo-${process.pid}-${qi}`);
  if (existsSync(ns)) rmSync(ns, { recursive: true });

  const engine = new MemoryEngine({ basePath: ns });
  await engine.init();
  engine.config.dedupThreshold = 1.01;  // disable for raw session storage

  // Ingest all sessions as conversations
  const convData = conv.conversation;
  const sessionKeys = Object.keys(convData).filter(k => k.startsWith('session_') && !k.includes('date_time'));
  for (const sk of sessionKeys) {
    const turns = convData[sk];
    if (!Array.isArray(turns)) continue;
    const dateKey = sk + '_date_time';
    const ts = convData[dateKey] || '';
    const body = turns.map(t => `${t.speaker}: ${t.text}`).join('\n');
    if (body.trim()) {
      await engine.add({
        type: 'conversation',
        summary: `${sessionId} ${sk}`,
        conversation: body,
        timestamp: ts,
        author: 'locomo',
      });
    }
  }

  // Search
  const results = await engine.land(question, 0, 'conversation');
  const top5 = results.slice(0, 5);
  const top10 = results.slice(0, 10);

  // LLM judge: which top-10 results are hits
  const judged = await judgeHit(question, expected, top10);
  const hit5 = judged.slice(0, 5).some(j => j.hit);
  const hit10 = judged.some(j => j.hit);

  if (!perCategory[catName]) perCategory[catName] = { hit5: 0, hit10: 0, total: 0 };
  perCategory[catName].total++;
  if (hit5) { perCategory[catName].hit5++; hitAt5++; }
  if (hit10) { perCategory[catName].hit10++; hitAt10++; }
  total++;

  const icon = hit10 ? '+' : '-';
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  process.stdout.write(`${icon}`);
  if ((qi + 1) % 10 === 0) {
    const h5 = (hitAt5 / total * 100).toFixed(0);
    const h10 = (hitAt10 / total * 100).toFixed(0);
    console.log(`  [${qi + 1}/${sampled.length}] Hit@5=${h5}% Hit@10=${h10}% elapsed=${elapsed}s`);
  }

  rmSync(ns, { recursive: true });
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log('\n\n=== LoCoMo Retrieval Results ===\n');
console.log(`Total:    ${total} questions`);
console.log(`Hit@5:    ${hitAt5} (${(hitAt5 / total * 100).toFixed(1)}%)`);
console.log(`Hit@10:   ${hitAt10} (${(hitAt10 / total * 100).toFixed(1)}%)`);
console.log(`\nPer-category:`);
for (const [cat, s] of Object.entries(perCategory)) {
  console.log(`  ${cat.padEnd(18)} Hit@5=${(s.hit5 / s.total * 100).toFixed(0)}%  Hit@10=${(s.hit10 / s.total * 100).toFixed(0)}%  (n=${s.total})`);
}
console.log(`\nModel: ${API_MODEL}`);
console.log(`Elapsed: ${((Date.now() - start) / 1000 / 60).toFixed(1)} min`);
