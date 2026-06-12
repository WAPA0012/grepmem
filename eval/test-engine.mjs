/**
 * Engine unit tests (node:test, zero deps).
 *
 * Run: node --test eval/test-engine.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

function freshEngine(label) {
  const dir = join(ROOT, `.test-${label}-${process.pid}-${Date.now()}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  return { dir, engine: null };
}

function cleanup(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

async function withEngine(label, fn) {
  const { dir } = freshEngine(label);
  try {
    const engine = new MemoryEngine({ basePath: dir });
    await engine.init();
    await fn(engine, dir);
  } finally {
    cleanup(dir);
  }
}

// ─── init ──────────────────────────────────────────────────────────────────

test('init creates the namespace dir and an empty HTML file', async () => {
  await withEngine('init', async (engine, dir) => {
    assert.ok(existsSync(join(dir, 'memory.html')));
    assert.equal(engine.stats().nodes, 0);
    assert.equal(engine.stats().edges, 0);
  });
});

test('init reloads existing memories from disk', async () => {
  const { dir } = freshEngine('reload');
  try {
    let e1 = new MemoryEngine({ basePath: dir });
    await e1.init();
    await e1.add({ summary: 'Persistent fact', detail: 'should survive restart' });
    await e1._flush();  // force persistence — add() now defers via _maybeFlush

    let e2 = new MemoryEngine({ basePath: dir });
    await e2.init();
    assert.equal(e2.stats().nodes, 1);
    const results = await e2.land('Persistent', 0);
    assert.ok(results.length >= 1, 'memory reloads from HTML');
  } finally { cleanup(dir); }
});

// ─── add ───────────────────────────────────────────────────────────────────

test('add returns id and stores the article', async () => {
  await withEngine('add', async (engine) => {
    const r = await engine.add({ summary: 'Redis password is abc', detail: 'cluster mode' });
    assert.ok(r.id, 'returns id');
    assert.equal(r.duplicate, false);
    assert.equal(engine.stats().nodes, 1);
  });
});

test('add auto-generates triggers when none provided', async () => {
  await withEngine('auto-triggers', async (engine) => {
    const r = await engine.add({ summary: 'Redis 6379 config' });
    const node = await engine.focus(r.id);
    assert.ok(node.triggers.length > 0, 'triggers auto-generated');
  });
});

test('add returns duplicate=true for identical summary', async () => {
  await withEngine('dedup', async (engine) => {
    await engine.add({ summary: 'Redis password abc123 port 6379', detail: 'cluster' });
    // Same summary → same SHA-256 prefix → ID collision triggers duplicate path.
    const dup = await engine.add({ summary: 'Redis password abc123 port 6379', detail: 'different detail' });
    assert.equal(dup.duplicate, true);
  });
});

test('add for conversation type stores conversation field', async () => {
  await withEngine('conversation', async (engine) => {
    const r = await engine.add({
      type: 'conversation',
      summary: 'standup meeting',
      conversation: 'User: what did you do?\nAI: fixed a bug',
    });
    const node = await engine.focus(r.id);
    assert.equal(node.type, 'conversation');
    assert.ok(node.conversation.includes('fixed a bug'));
    assert.equal(node.detail, '');
  });
});

// ─── land ──────────────────────────────────────────────────────────────────

test('land returns empty for unrelated query', async () => {
  await withEngine('land-empty', async (engine) => {
    await engine.add({ summary: 'Redis password abc', triggers: ['Redis config'] });
    const results = await engine.land('weather forecast', 0);
    assert.equal(results.length, 0);
  });
});

test('land matches on summary keywords', async () => {
  await withEngine('land-match', async (engine) => {
    await engine.add({ summary: 'Redis 6379 connection', triggers: ['Redis'] });
    const results = await engine.land('Redis', 0);
    assert.ok(results.length >= 1);
    assert.ok(results[0].match > 0);
  });
});

test('land typeFilter restricts results', async () => {
  await withEngine('land-filter', async (engine) => {
    await engine.add({ type: 'knowledge', summary: 'Redis password abc', triggers: ['Redis'] });
    await engine.add({ type: 'conversation', summary: 'Redis chat history', conversation: 'discussed Redis' });
    const k = await engine.land('Redis', 0, 'knowledge');
    const c = await engine.land('Redis', 0, 'conversation');
    assert.equal(k.length, 1);
    assert.equal(k[0].type, 'knowledge');
    assert.equal(c.length, 1);
    assert.equal(c[0].type, 'conversation');
  });
});

test('land increments accessCount on hits', async () => {
  await withEngine('access', async (engine) => {
    const r = await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    await engine.land('Redis', 0);
    await engine.land('Redis', 0);
    const node = await engine.focus(r.id);
    assert.ok(node.accessCount >= 2);
  });
});

// ─── focus ─────────────────────────────────────────────────────────────────

test('focus returns null for unknown id', async () => {
  await withEngine('focus-null', async (engine) => {
    const n = await engine.focus('nonexistent');
    assert.equal(n, null);
  });
});

test('focus returns full node including edges', async () => {
  await withEngine('focus-full', async (engine) => {
    const a = await engine.add({ summary: 'Node A', triggers: ['A'] });
    const b = await engine.add({ summary: 'Node B related to A', triggers: ['A'] });
    const node = await engine.focus(a.id);
    assert.equal(node.id, a.id);
    assert.equal(node.summary, 'Node A');
    assert.ok(Array.isArray(node.edges));
  });
});

// ─── remove ────────────────────────────────────────────────────────────────

test('remove deletes a node', async () => {
  await withEngine('remove', async (engine) => {
    const r = await engine.add({ summary: 'To be deleted', triggers: ['x'] });
    const result = await engine.remove(r.id);
    assert.equal(result.removed, true);
    assert.equal(engine.stats().nodes, 0);
    const focus = await engine.focus(r.id);
    assert.equal(focus, null);
  });
});

test('remove returns removed=false for unknown id', async () => {
  await withEngine('remove-unknown', async (engine) => {
    const r = await engine.remove('nonexistent');
    assert.equal(r.removed, false);
  });
});

test('remove cleans up edges pointing to the removed node', async () => {
  await withEngine('remove-edges', async (engine) => {
    const a = await engine.add({ summary: 'Redis 6379 config cluster', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Redis cluster topology', triggers: ['Redis'] });
    await engine.link(a.id, b.id, 0.8);
    await engine.remove(b.id);
    const node = await engine.focus(a.id);
    assert.equal(node.edges.length, 0, 'edges to removed node are gone');
  });
});

// ─── update ────────────────────────────────────────────────────────────────

test('update modifies fields', async () => {
  await withEngine('update', async (engine) => {
    const r = await engine.add({ summary: 'Old summary', triggers: ['old'] });
    await engine.update(r.id, { summary: 'New summary' });
    const node = await engine.focus(r.id);
    assert.equal(node.summary, 'New summary');
  });
});

test('update returns updated=false for unknown id', async () => {
  await withEngine('update-unknown', async (engine) => {
    const r = await engine.update('nonexistent', { summary: 'X' });
    assert.equal(r.updated, false);
  });
});

test('update can append a trigger', async () => {
  await withEngine('update-trigger', async (engine) => {
    const r = await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    await engine.update(r.id, { triggerAdd: 'cache config' });
    const node = await engine.focus(r.id);
    assert.ok(node.triggers.includes('cache config'));
  });
});

// ─── link / spread ─────────────────────────────────────────────────────────

test('link creates a directed edge', async () => {
  await withEngine('link', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis 6379', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Beta Redis cluster', triggers: ['Redis'] });
    await engine.link(a.id, b.id, 0.9);
    const node = await engine.focus(a.id);
    const edge = node.edges.find(e => e.target === b.id);
    assert.ok(edge, 'forward edge exists');
    assert.equal(edge.strength, 0.9);
  });
});

test('link does not duplicate edges', async () => {
  await withEngine('link-dedup', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Beta Redis cluster', triggers: ['Redis'] });
    await engine.link(a.id, b.id, 0.5);
    await engine.link(a.id, b.id, 0.9);
    const node = await engine.focus(a.id);
    const matches = node.edges.filter(e => e.target === b.id);
    assert.equal(matches.length, 1, 'only one edge per (source,target)');
    assert.equal(matches[0].strength, 0.9);
  });
});

test('spread walks edges with energy decay', async () => {
  await withEngine('spread', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Beta Redis cluster', triggers: ['Redis'] });
    const c = await engine.add({ summary: 'Gamma Redis sentinel', triggers: ['Redis'] });
    await engine.link(a.id, b.id, 0.8);
    await engine.link(b.id, c.id, 0.8);
    const results = await engine.spread(a.id, 2, 1.0);
    assert.ok(results.find(r => r.id === b.id), 'reaches direct neighbor');
    assert.ok(results.find(r => r.id === c.id), 'reaches 2-hop neighbor');
  });
});

// ─── supersede ─────────────────────────────────────────────────────────────

test('supersede marks old node and relinks edges', async () => {
  await withEngine('supersede', async (engine) => {
    const old = await engine.add({ summary: 'Old Redis password v1', triggers: ['Redis'] });
    const fresh = await engine.add({ summary: 'New Redis password v2 2025', triggers: ['Redis'] });
    const r = await engine.supersede(old.id, fresh.id);
    assert.equal(r.superseded, true);
    const node = await engine.focus(old.id);
    assert.equal(node.supersededBy, fresh.id);
  });
});

test('superseded nodes are filtered out by land', async () => {
  await withEngine('supersede-filter', async (engine) => {
    const old = await engine.add({ summary: 'Old Redis password v1 12345', triggers: ['Redis password'] });
    const fresh = await engine.add({ summary: 'New Redis password v2 67890', triggers: ['Redis password'] });
    await engine.supersede(old.id, fresh.id);
    const results = await engine.land('Redis password', 0);
    const ids = results.map(r => r.id);
    assert.ok(!ids.includes(old.id), 'old is filtered');
    assert.ok(ids.includes(fresh.id), 'fresh is returned');
  });
});

// ─── addBatch ──────────────────────────────────────────────────────────────

test('addBatch inserts multiple items at once', async () => {
  await withEngine('batch', async (engine) => {
    const results = await engine.addBatch([
      { summary: 'Redis 6379', triggers: ['Redis'] },
      { summary: 'Nginx 80 reverse proxy', triggers: ['Nginx'] },
      { summary: 'PostgreSQL 5432 main DB', triggers: ['PostgreSQL'] },
    ]);
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.id), 'every item got an id');
    assert.equal(engine.stats().nodes, 3);
  });
});

// ─── auditTriggers ─────────────────────────────────────────────────────────

test('auditTriggers returns a per-trigger report', async () => {
  await withEngine('audit', async (engine) => {
    await engine.add({ summary: 'Redis 6379 config', triggers: ['Redis password', 'Cache setup'] });
    const report = engine.auditTriggers();
    assert.ok(report.length >= 2);
    assert.ok(report.every(r => r.status === 'ok' || r.status === 'ineffective'));
  });
});

// ─── beforeAction ──────────────────────────────────────────────────────────

test('beforeAction returns related memories or null', async () => {
  await withEngine('before-action', async (engine) => {
    await engine.add({ summary: 'Redis 6379 password', triggers: ['Redis'] });
    const hit = await engine.beforeAction('Redis');
    const miss = await engine.beforeAction('xyz unrelated');
    assert.ok(hit === null || Array.isArray(hit.related));
    assert.equal(miss, null);
  });
});

// ─── stats ─────────────────────────────────────────────────────────────────

test('stats reports node and edge counts', async () => {
  await withEngine('stats', async (engine) => {
    // Use distinct topics to avoid auto-dedup merging them.
    const a = await engine.add({ summary: 'Redis 6379 cluster config', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Nginx 80 reverse proxy setup', triggers: ['Nginx'] });
    await engine.link(a.id, b.id);
    const s = engine.stats();
    assert.equal(s.nodes, 2);
    assert.ok(s.edges >= 1);
  });
});

test('stats excludes superseded nodes from count', async () => {
  await withEngine('stats-superseded', async (engine) => {
    const a = await engine.add({ summary: 'Old Redis password v1 12345', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'New Redis password v2 67890', triggers: ['Redis'] });
    await engine.supersede(a.id, b.id);
    const s = engine.stats();
    assert.equal(s.nodes, 1, 'superseded node not counted');
  });
});

// ─── effectiveSalience ─────────────────────────────────────────────────────

test('effectiveSalience is clamped to [0.1, 1.0]', async () => {
  await withEngine('salience-clamp', async (engine) => {
    // Force extreme values via direct node mutation.
    const r = await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const node = engine._articles.get(r.id);
    node.baseSalience = 10;  // way too high
    const high = engine._effectiveSalience(node);
    assert.equal(high, 1.0);
    node.baseSalience = -5;  // way too low
    node.accessCount = 0;
    const low = engine._effectiveSalience(node);
    assert.ok(low >= 0.1);
  });
});

test('effectiveSalience increases with accessCount', async () => {
  await withEngine('salience-access', async (engine) => {
    const r = await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const node = engine._articles.get(r.id);
    const before = engine._effectiveSalience(node);
    node.accessCount = 10;
    node.lastAccess = new Date().toISOString().slice(0, 10);
    const after = engine._effectiveSalience(node);
    assert.ok(after > before, 'access boosts salience');
  });
});
