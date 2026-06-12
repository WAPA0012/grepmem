/**
 * Step Plan endpoint RPM probe.
 * Tests the /step_plan/v1 endpoint which StepFun says has only concurrency limits
 * (no RPM). We probe at increasingly aggressive gaps to find the true ceiling.
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const API_KEY = process.env.LLM_KEY || process.env.OPENAI_API_KEY;
const API_BASE = (process.env.LLM_BASE || 'https://api.stepfun.com/step_plan/v1').replace(/,+$/, '');
const API_MODEL = process.env.LLM_MODEL || 'step-3.7-flash';

if (!API_KEY) {
  console.error('Need LLM_KEY');
  process.exit(1);
}

// More aggressive — Step Plan supposedly has no RPM, only concurrency.
// Start at gap=500ms (120/min) and ramp down.
const TESTS = [
  { gap: 2000, label: '30/min (2s)' },
  { gap: 1000, label: '60/min (1s)' },
  { gap: 500,  label: '120/min (0.5s)' },
  { gap: 200,  label: '300/min (0.2s)' },
  { gap: 100,  label: '600/min (0.1s)' },
  { gap: 50,   label: '1200/min (0.05s)' },
];
const DURATION_MS = 35000;  // 35s — enough to detect a 60s-window RPM if it exists

function callOnce(i) {
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: `ping ${i}` }],
    model: API_MODEL,
    temperature: 0,
    max_tokens: 1,
    reasoning_effort: 'low',  // minimize think time on ping
  });
  const scriptPath = join(tmpdir(), `probe_sp_${process.pid}_${Date.now()}_${i}.py`);
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
    const wait = Math.max(0, gap - (Date.now() - t0));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  const ok = results.filter(r => r.out === 'OK').length;
  const rateLimited = results.filter(r => r.out.startsWith('HTTP_429')).length;
  const other = results.filter(r => !r.out.startsWith('OK') && !r.out.startsWith('HTTP_429')).length;
  console.log(`\n  sent ${results.length}, OK=${ok}, 429=${rateLimited}, other_err=${other}`);
  if (other > 0) {
    const sample = results.find(r => !r.out.startsWith('OK') && !r.out.startsWith('HTTP_429'));
    console.log(`  sample error: ${sample.out.slice(0, 200)}`);
  }
  // Track avg latency on OK calls — high latency might indicate concurrency throttle
  const okResults = results.filter(r => r.out === 'OK');
  const avgMs = okResults.length > 0 ? okResults.reduce((a, b) => a + b.ms, 0) / okResults.length : 0;
  return { label, sent: results.length, ok, rateLimited, other, observedRpm: ok * (60000 / DURATION_MS), avgMs: Math.round(avgMs) };
}

console.log(`Step Plan RPM probe — model ${API_MODEL}`);
console.log(`Base: ${API_BASE}\n`);

const summary = [];
for (const t of TESTS) {
  const r = await runTest(t);
  summary.push(r);
  if (r.rateLimited > 0) {
    console.log(`\nHit rate limit at ${t.label}; stopping.`);
    break;
  }
  // Also bail if latency blows up — concurrency throttle without 429
  if (r.avgMs > 10000) {
    console.log(`\nLatency blew up to ${r.avgMs}ms at ${t.label}; concurrency throttle likely.`);
    break;
  }
}

console.log('\n\n=== Summary ===');
console.log('Gap       | Sent | OK | 429 | Err | Observed RPM | Avg latency');
console.log('----------|------|----|-----|-----|--------------|------------');
for (const r of summary) {
  console.log(`${r.label.padEnd(10)}| ${String(r.sent).padStart(4)} | ${String(r.ok).padStart(2)} | ${String(r.rateLimited).padStart(3)} | ${String(r.other).padStart(3)} | ${String(r.observedRpm.toFixed(0)).padStart(12)} | ${r.avgMs}ms`);
}

const safe = summary.filter(s => s.rateLimited === 0 && s.other === 0 && s.avgMs < 5000);
if (safe.length > 0) {
  const best = safe[safe.length - 1];
  console.log(`\nRecommended gap for eval script: ${best.label} (sustained ${best.observedRpm.toFixed(0)} RPM, avg latency ${best.avgMs}ms)`);
} else {
  console.log(`\nNo safe high-throughput config found.`);
}
