/**
 * Verify: Dual-layer storage (knowledge + conversation).
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(import.meta.url.replace('file:///', '').replace('file://', ''), '..', '.dual-test');
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

console.log('=== Verify: Knowledge + Conversation Storage ===\n');

const engine = new MemoryEngine({ basePath: TEST_DIR });
await engine.init();

// Add a knowledge article
await engine.add({
  type: 'knowledge',
  summary: 'Redis密码r3d1s_v2_2025!，端口6379，在192.168.1.101',
  detail: '集群3节点。哨兵101/102/103。连接池100',
  triggers: ['Redis密码', 'Redis连接配置'],
  author: 'ops-bot',
});

// Add a conversation article
await engine.add({
  type: 'conversation',
  summary: 'Redis升级讨论',
  conversation: `用户：生产Redis密码要不要改？
AI：建议改，旧密码用了2年了
用户：什么时候改？
AI：本周三凌晨2点维护窗口改`,
  author: 'claude',
  timestamp: '2026-06-10T14:30:00Z',
});

console.log(`Stored: ${engine.stats().nodes} articles\n`);

// Test 1: search for knowledge only
console.log('--- Search "Redis密码" (knowledge only) ---');
let results = await engine.land('Redis密码', 0, 'knowledge');
for (const r of results) {
  console.log(`  [${r.type}] ${r.summary.slice(0, 50)}... match=${r.match}`);
}

// Test 2: search for conversation only
console.log('\n--- Search "Redis升级" (conversation only) ---');
results = await engine.land('Redis升级', 0, 'conversation');
for (const r of results) {
  console.log(`  [${r.type}] ${r.summary}`);
  if (r.conversation) console.log(`       body: ${r.conversation.slice(0, 60)}...`);
}

// Test 3: search across both (no filter)
console.log('\n--- Search "Redis" (all types) ---');
results = await engine.land('Redis', 0);
for (const r of results) {
  console.log(`  [${r.type}] ${r.summary.slice(0, 50)}... match=${r.match}`);
}

// Test 4: LongMemEval-style — find what was discussed about Redis
console.log('\n--- LongMemEval-style: "什么时候讨论过Redis密码" ---');
results = await engine.land('讨论 Redis 密码', 0);
for (const r of results) {
  console.log(`  [${r.type}] ${r.summary}`);
  if (r.type === 'conversation') {
    console.log(`       Found in conversation! timestamp=${r.timestamp}`);
  }
}

rmSync(TEST_DIR, { recursive: true });
console.log('\nDone.');
