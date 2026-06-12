/**
 * Example 2: Talk to the HTTP server from any language.
 *
 * Prerequisite: start the server first
 *   npm start
 * or
 *   node server.mjs
 *
 * Then run this client:
 *   node examples/http-client.mjs
 */

const BASE = process.env.MEMORY_URL || 'http://localhost:18234';

async function main() {
  // ─── Store a memory ──────────────────────────────────────────────────────
  const storeRes = await fetch(`${BASE}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: 'Postgres connection: postgresql://app:secret@db.internal:5432/prod',
      detail: 'Connection pool size 50. Read replica on db-read.internal.',
      triggers: ['Postgres connection', 'database DSN'],
      type: 'knowledge',
      author: 'demo',
    }),
  });
  const storeJson = await storeRes.json();
  console.log('Stored:', storeJson);

  // ─── Search ──────────────────────────────────────────────────────────────
  const recallRes = await fetch(`${BASE}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'how to connect to postgres', spreadDepth: 1 }),
  });
  const recallJson = await recallRes.json();
  console.log('\nRecall hits:');
  for (const h of recallJson.results.slice(0, 5)) {
    console.log(`  [${h.type}] score=${h.match}  ${h.summary.slice(0, 80)}`);
  }

  // ─── Read full content ───────────────────────────────────────────────────
  if (recallJson.results[0]) {
    const focusRes = await fetch(`${BASE}/focus/${recallJson.results[0].id}`);
    const focusJson = await focusRes.json();
    console.log('\nFull memory:');
    console.log(`  summary: ${focusJson.summary}`);
    console.log(`  detail : ${focusJson.detail}`);
  }

  // ─── Stats ───────────────────────────────────────────────────────────────
  const statsRes = await fetch(`${BASE}/stats`);
  const statsJson = await statsRes.json();
  console.log('\nStats:', statsJson);
}

main().catch(console.error);
