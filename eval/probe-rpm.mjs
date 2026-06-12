/**
 * StepFun RPM probe.
 *
 * Strategy: fire requests at a fixed interval for 60s, count successes vs
 * 429s. Then bump the interval down and repeat. The highest interval that
 * yields zero 429s tells us the safe sustained RPM.
 *
 * Output: per-interval success/429 counts, plus a recommended gap to use
 * in the eval script.
 *
 * Run: LLM_KEY=xxx LLM_BASE=https://api.stepfun.com/v1 node eval/probe-rpm.mjs
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const API_KEY = process.env.LLM_KEY || process.env.OPENAI_API_KEY;
const API_BASE = (process.env.LLM_BASE || 'https://api.stepfun.com/v1').replace(/,+$/, '');
const API_MODEL = process.env.LLM_MODEL || 'step-3.7-flash';

if (!API_KEY) {
  console.error('Need LLM_KEY');
  process.exit(1);
}

// Each test: fire requests at the given gap (ms between starts) for DURATION ms.
// We do small "ping" calls — minimal tokens — so we measure RPM not TPM.
const TESTS = [
  { gap: 6000, label: '10 RPM (gap 6s)' },   // known-safe (V0)
  { gap: 2000, label: '30 RPM (gap 2s)' },
  { gap: 1000, label: '60 RPM (gap 1s)' },
  { gap: 500,  label: '120 RPM (gap 0.5s)' },
  { gap: 200,  label: '300 RPM (gap 0.2s)' },
];
const DURATION_MS = 65000;  // 65s, covers >1 RPM window

function callOnce(i) {
  const payload = JSON.stringify({
    messages: [
      { role: 'user', content: `ping ${i}` },  // minimal tokens
    ],
    model: API_MODEL,
    temperature: 0,
    max_tokens: 1,
  });
  const scriptPath = join(tmpdir(), `probe_${process.pid}_${Date.now()}_${i}.py`);
  const script = `
import urllib.request, json, os
for k in ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY']:
    os.environ.pop(k, None)
data = json.loads(${JSON.stringify(payload)})
req = urllib.request.Request('${API_BASE}/chat/completions',
  data=json.dumps(data).encode(),
  headers={'Content-Type':'application/json','Authorization':'Bearer ${API_KEY}'})
try:
    r = urllib.request.urlopen(req, timeout=30)
    obj = json.loads(r.read().decode())
    print('OK')
except urllib.error.HTTPError as e:
    body = e.read().decode()[:200]
    print('HTTP_' + str(e.code) + ':' + body)
except Exception as e:
    print('ERR:' + str(e)[:100])
`;
  writeFileSync(scriptPath, script, 'utf8');
  try {
    const out = execSync(`python "${scriptPath}"`, { encoding: 'utf8', timeout: 40000 });
    return out.trim();
  } catch (e) {
    return 'EXEC_ERR:' + (e.message || '').slice(0, 80);
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

async function runTest({ gap, label }) {
  console.log(`\n=== ${label} — firing for ${DURATION_MS/1000}s ===`);
  const start = Date.now();
  const results = [];
  let i = 0;
  while (Date.now() - start < DURATION_MS) {
    const t0 = Date.now();
    const r = callOnce(i);
    const dt = Date.now() - t0;
    results.push({ i, ms: dt, out: r });
    process.stdout.write(r.startsWith('OK') ? '.' : (r.startsWith('HTTP_429') ? '!' : 'x'));
    i++;
    // Sleep until next gap tick. If the call already took longer, skip sleep.
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, gap - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  const ok = results.filter(r => r.out === 'OK').length;
  const rateLimited = results.filter(r => r.out.startsWith('HTTP_429')).length;
  const other = results.filter(r => !r.out.startsWith('OK') && !r.out.startsWith('HTTP_429')).length;
  console.log(`\n  sent ${results.length}, OK=${ok}, 429=${rateLimited}, other_err=${other}`);
  // Show error samples
  if (other > 0) {
    const sample = results.find(r => !r.out.startsWith('OK') && !r.out.startsWith('HTTP_429'));
    console.log(`  sample error: ${sample.out.slice(0, 120)}`);
  }
  return { label, sent: results.length, ok, rateLimited, other, observedRpm: ok * (60000 / DURATION_MS) };
}

console.log(`StepFun RPM probe — model ${API_MODEL}`);
console.log(`Base: ${API_BASE}\n`);

const summary = [];
for (const t of TESTS) {
  const r = await runTest(t);
  summary.push(r);
  // Bail early if we already see 429 — no point pushing harder.
  if (r.rateLimited > 0) {
    console.log(`\nHit rate limit at ${t.label}; stopping tests beyond this.`);
    break;
  }
}

console.log('\n\n=== Summary ===');
console.log('Gap       | Sent | OK | 429 | Other | Observed sustained RPM');
console.log('----------|------|----|-----|-------|------------------------');
for (const r of summary) {
  console.log(`${r.label.padEnd(10)}| ${String(r.sent).padStart(4)} | ${String(r.ok).padStart(2)} | ${String(r.rateLimited).padStart(3)} | ${String(r.other).padStart(5)} | ${r.observedRpm.toFixed(0)}`);
}

// Recommend safe gap = smallest gap with 0 429s
const safe = summary.filter(s => s.rateLimited === 0 && s.other === 0);
if (safe.length > 0) {
  const best = safe[safe.length - 1];
  console.log(`\nRecommended: ${best.label} (sustained ${best.observedRpm.toFixed(0)} RPM, zero 429s)`);
} else {
  console.log(`\nAll tests hit rate limits or errors. Stay at 6s gap (V0).`);
}
