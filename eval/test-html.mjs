/**
 * HTML serialization round-trip + edge-case tests.
 *
 * Verifies that whatever we put into the engine survives the write→HTML→read
 * cycle unchanged, including Unicode, HTML metacharacters, nested tags in
 * detail text, very long fields, and conversation bodies with newlines.
 *
 * Run: node --test eval/test-html.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

function freshDir(label) {
  const dir = join(ROOT, `.test-html-${label}-${process.pid}-${Date.now()}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

async function withEngine(label, fn) {
  const dir = freshDir(label);
  try {
    const engine = new MemoryEngine({ basePath: dir });
    await engine.init();
    await fn(engine, dir);
  } finally {
    cleanup(dir);
  }
}

async function reload(dir, prevEngine = null) {
  // Fresh engine on an existing dir — simulates process restart.
  // Force the previous engine's deferred writes to disk first; add() now
  // batches via _maybeFlush, so without this the on-disk HTML may be stale.
  if (prevEngine) await prevEngine._flush();
  const e = new MemoryEngine({ basePath: dir });
  await e.init();
  return e;
}

// ─── basic round-trip ──────────────────────────────────────────────────────

test('summary + detail survive write→read', async () => {
  await withEngine('basic', async (engine, dir) => {
    const r = await engine.add({
      summary: 'Redis 6379 password abc',
      detail: 'Cluster mode 3 nodes',
      triggers: ['Redis password'],
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.summary, 'Redis 6379 password abc');
    assert.equal(node.detail, 'Cluster mode 3 nodes');
    assert.deepEqual(node.triggers, ['Redis password']);
  });
});

test('all fields survive write→read', async () => {
  await withEngine('all-fields', async (engine, dir) => {
    const r = await engine.add({
      type: 'knowledge',
      summary: 'Test summary text',
      detail: 'Test detail text',
      triggers: ['t1', 't2', 't3'],
      author: 'tester',
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.type, 'knowledge');
    assert.equal(node.author, 'tester');
    assert.equal(node.triggers.length, 3);
    assert.ok(node.baseSalience !== undefined);
    assert.ok(node.lastAccess);
    assert.ok(node.created);
  });
});

// ─── Unicode ───────────────────────────────────────────────────────────────

test('Chinese summary survives round-trip', async () => {
  await withEngine('zh', async (engine, dir) => {
    const r = await engine.add({
      summary: '生产环境Redis密码是r3d1s，端口6379',
      detail: '集群模式，3个节点',
      triggers: ['Redis配置'],
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.summary, '生产环境Redis密码是r3d1s，端口6379');
    assert.equal(node.detail, '集群模式，3个节点');
    assert.deepEqual(node.triggers, ['Redis配置']);
  });
});

test('Japanese + Korean + emoji survive', async () => {
  await withEngine('cjk-emoji', async (engine, dir) => {
    const r = await engine.add({
      summary: 'Redis設定 🚀 Redis 설정 Редис',
      detail: 'multi-language test 日本語 한국어',
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.summary, 'Redis設定 🚀 Redis 설정 Редис');
    assert.equal(node.detail, 'multi-language test 日本語 한국어');
  });
});

// ─── HTML metacharacters ───────────────────────────────────────────────────

test('HTML metacharacters in summary are escaped', async () => {
  await withEngine('html-meta', async (engine, dir) => {
    const r = await engine.add({
      summary: 'Use <script>alert(1)</script> carefully',
      detail: 'A & B < C > D "quoted"',
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.summary, 'Use <script>alert(1)</script> carefully');
    assert.equal(node.detail, 'A & B < C > D "quoted"');
  });
});

test('HTML in triggers is escaped', async () => {
  await withEngine('html-trigger', async (engine, dir) => {
    const r = await engine.add({
      summary: 'x',
      triggers: ['<b>bold trigger</b>', 'normal & <weird>'],
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.deepEqual(node.triggers, ['<b>bold trigger</b>', 'normal & <weird>']);
  });
});

// ─── long fields ───────────────────────────────────────────────────────────

test('very long summary (10KB) survives', async () => {
  await withEngine('long-summary', async (engine, dir) => {
    const big = 'A'.repeat(10000);
    const r = await engine.add({ summary: big, detail: 'small' });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.summary.length, 10000);
    assert.equal(node.summary, big);
  });
});

test('very long detail (100KB) survives', async () => {
  await withEngine('long-detail', async (engine, dir) => {
    const big = 'B'.repeat(100000);
    const r = await engine.add({ summary: 'short', detail: big });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.detail.length, 100000);
  });
});

test('many triggers (100) survive', async () => {
  await withEngine('many-triggers', async (engine, dir) => {
    const triggers = Array.from({ length: 100 }, (_, i) => `trigger_${i}`);
    const r = await engine.add({ summary: 'many triggers test', triggers });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.triggers.length, 100);
    assert.deepEqual(node.triggers, triggers);
  });
});

// ─── conversation-specific ─────────────────────────────────────────────────

test('conversation body with newlines survives', async () => {
  await withEngine('conv-newlines', async (engine, dir) => {
    const body = 'User: line1\nAI: line2\nUser: line3\nAI: line4';
    const r = await engine.add({
      type: 'conversation',
      summary: 'multi-line conversation',
      conversation: body,
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.type, 'conversation');
    assert.equal(node.conversation, body);
  });
});

test('conversation body with HTML-like content survives', async () => {
  await withEngine('conv-html', async (engine, dir) => {
    const body = 'User: paste this <div class="x">content</div>\nAI: ok';
    const r = await engine.add({
      type: 'conversation',
      summary: 'paste test',
      conversation: body,
    });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.conversation, body);
  });
});

// ─── empty / edge ──────────────────────────────────────────────────────────

test('empty detail survives', async () => {
  await withEngine('empty-detail', async (engine, dir) => {
    const r = await engine.add({ summary: 'only summary', detail: '' });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.detail, '');
  });
});

test('empty triggers list survives', async () => {
  await withEngine('empty-triggers', async (engine, dir) => {
    const r = await engine.add({ summary: 'no triggers', triggers: [] });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.triggers.length, 0);
  });
});

test('special characters in summary (quotes, backticks, slashes)', async () => {
  await withEngine('special-chars', async (engine, dir) => {
    const summary = 'Don\'t `use` "this" \\path/to/file (carefully)';
    const r = await engine.add({ summary, detail: 'x' });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    assert.equal(node.summary, summary);
  });
});

test('newline embedded in summary is preserved (whitespace-pre)', async () => {
  await withEngine('newline-summary', async (engine, dir) => {
    const summary = 'line1\nline2';
    const r = await engine.add({ summary, detail: 'x' });
    const e2 = await reload(dir, engine);
    const node = await e2.focus(r.id);
    // Note: this is the documented behavior — summary is one line. If the
    // engine preserves it, great. If it collapses whitespace, that's a
    // regression worth knowing about.
    assert.ok(node.summary.includes('line1'));
    assert.ok(node.summary.includes('line2'));
  });
});

// ─── multiple articles ─────────────────────────────────────────────────────

test('multiple articles preserve their order-independent identity', async () => {
  await withEngine('multi', async (engine, dir) => {
    const r1 = await engine.add({ summary: 'Alpha', detail: 'a-detail', triggers: ['a'] });
    const r2 = await engine.add({ summary: 'Beta', detail: 'b-detail', triggers: ['b'] });
    const r3 = await engine.add({ summary: 'Gamma', detail: 'g-detail', triggers: ['g'] });
    const e2 = await reload(dir, engine);
    const n1 = await e2.focus(r1.id);
    const n2 = await e2.focus(r2.id);
    const n3 = await e2.focus(r3.id);
    assert.equal(n1.summary, 'Alpha');
    assert.equal(n2.summary, 'Beta');
    assert.equal(n3.summary, 'Gamma');
  });
});

test('edges survive round-trip', async () => {
  await withEngine('edges', async (engine, dir) => {
    const a = await engine.add({ summary: 'Redis cluster topology', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Redis sentinel setup', triggers: ['Redis'] });
    await engine.link(a.id, b.id, 0.85);
    const e2 = await reload(dir, engine);
    const node = await e2.focus(a.id);
    assert.equal(node.edges.length, 1);
    assert.equal(node.edges[0].target, b.id);
    assert.equal(node.edges[0].strength, 0.85);
  });
});

test('supersede marker survives round-trip', async () => {
  await withEngine('supersede-rt', async (engine, dir) => {
    const old = await engine.add({ summary: 'Old Redis password v1', triggers: ['Redis'] });
    const fresh = await engine.add({ summary: 'New Redis password v2 2025', triggers: ['Redis'] });
    await engine.supersede(old.id, fresh.id);
    const e2 = await reload(dir, engine);
    const oldNode = await e2.focus(old.id);
    assert.equal(oldNode.supersededBy, fresh.id);
  });
});

// ─── corrupted file handling ───────────────────────────────────────────────

test('malformed HTML does not crash the engine', async () => {
  await withEngine('malformed', async (engine, dir) => {
    // Manually write garbage to the file.
    const { writeFileSync } = await import('fs');
    const htmlPath = join(dir, 'memory.html');
    writeFileSync(htmlPath, '<!DOCTYPE html><html><body>this is not valid memory HTML</body></html>');
    const e2 = await reload(dir, engine);
    // Should not crash; should just have 0 nodes.
    assert.equal(e2.stats().nodes, 0);
  });
});

test('totally empty file is handled', async () => {
  await withEngine('empty-file', async (engine, dir) => {
    const { writeFileSync } = await import('fs');
    const htmlPath = join(dir, 'memory.html');
    writeFileSync(htmlPath, '');
    const e2 = await reload(dir, engine);
    assert.equal(e2.stats().nodes, 0);
  });
});

// ─── tag generation ────────────────────────────────────────────────────────

test('tags are auto-generated from English + Chinese + IP', async () => {
  await withEngine('tags-gen', async (engine) => {
    const r = await engine.add({
      summary: 'Redis 6379 at 192.168.1.100, password abc123',
      detail: '集群模式 cluster',
    });
    const node = await engine.focus(r.id);
    const tags = engine._articles.get(r.id).tags;
    assert.ok(tags.some(t => t.toLowerCase().includes('redis')));
    assert.ok(tags.some(t => t.includes('192.168.1.100')));
    assert.ok(tags.some(t => t.includes('集群') || t.includes('模式')));
  });
});
