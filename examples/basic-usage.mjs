/**
 * Example 1: Basic in-process usage of the Grepmem engine.
 *
 * Use Grepmem as a library inside any Node.js app — no HTTP server needed.
 *
 * Run: node examples/basic-usage.mjs
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync } from 'fs';

// Each basePath is an isolated memory namespace.
// Use different paths for different projects / users / agents.
const engine = new MemoryEngine({ basePath: './.my-memory' });
await engine.init();

// ─── Store knowledge (compiled facts) ──────────────────────────────────────
await engine.add({
  type: 'knowledge',
  summary: 'Production Redis password r3d1s, port 6379, host 192.168.1.101',
  detail: '3-node cluster. Sentinels on 101/102/103. Pool size 100.',
  triggers: ['Redis password', 'Redis connection config'],
});

await engine.add({
  type: 'knowledge',
  summary: 'admin-panel deploys to 192.168.1.100:3000, SSH user "deployer"',
  detail: 'Behind VPN. PM2 process name "admin-panel".',
  triggers: ['admin-panel deployment', 'internal admin URL'],
});

// ─── Store conversation (raw chat history) ─────────────────────────────────
await engine.add({
  type: 'conversation',
  summary: 'Redis password rotation discussion',
  conversation: `User: Should we rotate the production Redis password?
AI: Recommended — current one is 2 years old.
User: When?
AI: This Wednesday 2am maintenance window.`,
});

await engine._flush();  // force-write to disk

// ─── Search across all memories ────────────────────────────────────────────
console.log('\n=== recall("Redis") ===');
const hits = await engine.land('Redis', 0);
for (const h of hits.slice(0, 5)) {
  console.log(`  [${h.type}] score=${h.match}  ${h.summary.slice(0, 80)}`);
}

// ─── Filter by type ────────────────────────────────────────────────────────
console.log('\n=== recall("Redis", typeFilter="conversation") ===');
const convOnly = await engine.land('Redis', 0, 'conversation');
for (const h of convOnly) {
  console.log(`  [${h.type}] ${h.summary.slice(0, 80)}`);
}

// ─── Read full content of one memory ───────────────────────────────────────
console.log('\n=== focus(top hit) ===');
const top = hits[0];
const full = await engine.focus(top.id);
console.log(`  summary: ${full.summary}`);
console.log(`  detail : ${full.detail || full.conversation?.slice(0, 100)}`);
console.log(`  tags   : ${full.triggers?.join(', ')}`);

// Cleanup (uncomment to remove the demo namespace)
// rmSync('./.my-memory', { recursive: true });

console.log('\nDone. Open ./.my-memory/memory.html in a browser to see storage.');
