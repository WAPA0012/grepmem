/**
 * LongMemEval-S retrieval benchmark (no LLM judge needed).
 *
 * Each question has explicit answer_session_ids — the ground truth is which
 * sessions contain the answer. We ingest haystack_sessions, run recall(),
 * and check if any of the top-K matches an answer_session_id.
 *
 * This is the same metric GBrain / MemPalace publish: R@5.
 *
 * Run: LIMIT=100 node eval/longmemeval-s-retrieval.mjs
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const DATA_PATH = join(ROOT, 'data', 'longmemeval_s_cleaned.json');

const LIMIT = parseInt(process.env.LIMIT || '100', 10);
const TYPES = process.env.TYPES ? process.env.TYPES.split(',') : null;

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
console.log(`LongMemEval-S: ${data.length} total questions`);

let sampled = data;
if (TYPES) {
  sampled = data.filter(d => TYPES.includes(d.question_type));
  console.log(`Filtered to types ${TYPES}: ${sampled.length} questions`);
}
sampled = sampled.sort(() => Math.random() - 0.5).slice(0, LIMIT);
console.log(`Sampling ${sampled.length} questions\n`);

const TYPE_NAMES = {
  'single-session-user': 'ss-user',
  'single-session-assistant': 'ss-asst',
  'single-session-preference': 'ss-pref',
  'multi-session': 'multi',
  'temporal-reasoning': 'temporal',
  'knowledge-update': 'update',
};

// Skip abstention questions (no real answer)
const evaluable = sampled.filter(d => !d.question_id.endsWith('_abs'));
console.log(`After dropping abstention: ${evaluable.length}\n`);

let hitAt5 = 0, hitAt10 = 0, total = 0;
const perType = {};
let totalSessions = 0;
let totalAnswerSessions = 0;

const start = Date.now();

for (let qi = 0; qi < evaluable.length; qi++) {
  const item = evaluable[qi];
  const question = item.question;
  const answerIds = item.answer_session_ids || [];
  const typeShort = TYPE_NAMES[item.question_type] || item.question_type;

  // Fresh namespace per question (each Q has its own haystack)
  const ns = join(ROOT, `.lme-${process.pid}-${qi}`);
  if (existsSync(ns)) rmSync(ns, { recursive: true });

  const engine = new MemoryEngine({ basePath: ns });
  await engine.init();
  engine.config.dedupThreshold = 1.01;  // disable dedup; raw session ingest

  // Ingest sessions. We use the original session_id (from haystack_session_ids)
  // encoded in the summary so we can recover it after search.
  const sessionIds = item.haystack_session_ids;
  const sessions = item.haystack_sessions;
  totalSessions += sessions.length;
  totalAnswerSessions += answerIds.length;

  for (let si = 0; si < sessions.length; si++) {
    const turns = sessions[si];
    if (!Array.isArray(turns)) continue;
    const origId = sessionIds[si];
    const date = item.haystack_dates ? item.haystack_dates[si] : '';
    // Mark answer sessions so we can identify them later (data-answer-session).
    const isAnswer = answerIds.includes(origId);
    const body = turns
      .map(t => `${t.role === 'user' ? 'User' : 'AI'}: ${t.content}`)
      .join('\n');
    if (!body.trim()) continue;
    await engine.add({
      type: 'conversation',
      summary: `LME ${origId}${isAnswer ? ' [ANSWER]' : ''}`,
      conversation: body,
      timestamp: date,
      author: 'lme',
    });
  }

  // Search
  const results = await engine.land(question, 0, 'conversation');

  // Recover original session_ids from summaries
  const top5Ids = results.slice(0, 5).map(r => {
    const m = r.summary?.match(/LME (\S+)/);
    return m ? m[1] : null;
  });
  const top10Ids = results.slice(0, 10).map(r => {
    const m = r.summary?.match(/LME (\S+)/);
    return m ? m[1] : null;
  });

  // Hit@K = any of top-K ids is in answerIds
  const h5 = top5Ids.some(id => id && answerIds.includes(id));
  const h10 = top10Ids.some(id => id && answerIds.includes(id));

  if (!perType[typeShort]) perType[typeShort] = { hit5: 0, hit10: 0, total: 0 };
  perType[typeShort].total++;
  if (h5) { perType[typeShort].hit5++; hitAt5++; }
  if (h10) { perType[typeShort].hit10++; hitAt10++; }
  total++;

  const icon = h10 ? '+' : '-';
  process.stdout.write(icon);
  if ((qi + 1) % 25 === 0) {
    const h5pct = (hitAt5 / total * 100).toFixed(0);
    const h10pct = (hitAt10 / total * 100).toFixed(0);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`  [${qi + 1}/${evaluable.length}] R@5=${h5pct}% R@10=${h10pct}% elapsed=${elapsed}s`);
  }

  rmSync(ns, { recursive: true });
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log('\n\n=== LongMemEval-S Retrieval Results ===\n');
console.log(`Total:     ${total} questions`);
console.log(`Avg haystack sessions per Q: ${(totalSessions / total).toFixed(1)}`);
console.log(`Avg answer sessions per Q: ${(totalAnswerSessions / total).toFixed(1)}`);
console.log(`R@5:       ${hitAt5} (${(hitAt5 / total * 100).toFixed(1)}%)`);
console.log(`R@10:      ${hitAt10} (${(hitAt10 / total * 100).toFixed(1)}%)`);
console.log(`\nPer-question-type:`);
const order = ['ss-user', 'ss-asst', 'ss-pref', 'multi', 'temporal', 'update'];
for (const t of order) {
  if (!perType[t]) continue;
  const s = perType[t];
  console.log(`  ${t.padEnd(10)} R@5=${(s.hit5 / s.total * 100).toFixed(0).padStart(3)}%  R@10=${(s.hit10 / s.total * 100).toFixed(0).padStart(3)}%  (n=${s.total})`);
}
console.log(`\nElapsed: ${((Date.now() - start) / 1000 / 60).toFixed(1)} min`);
console.log(`\nComparison:`);
console.log(`  MemPalace (raw):    R@5 = 96.6%`);
console.log(`  GBrain:             R@5 = 97.6%`);
console.log(`  Ours (grep):        R@5 = ${(hitAt5 / total * 100).toFixed(1)}%`);
