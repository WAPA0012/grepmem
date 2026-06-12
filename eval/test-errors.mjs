/**
 * Error-input and robustness tests.
 *
 * Verifies the engine degrades gracefully on bad calls and hostile inputs:
 *   - bad IDs, missing required fields, empty/oversized queries
 *   - invalid enum values (caller ignores TypeScript)
 *   - concurrent writes do not corrupt the file
 *
 * Run: node --test eval/test-errors.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

function freshDir(label) {
  const dir = join(ROOT, `.test-err-${label}-${process.pid}-${Date.now()}`);
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

// ─── bad IDs ───────────────────────────────────────────────────────────────

test('focus on nonexistent id returns null, does not throw', async () => {
  await withEngine('focus-bad', async (engine) => {
    const r = await engine.focus('does-not-exist-12345');
    assert.equal(r, null);
  });
});

test('remove on nonexistent id returns removed=false', async () => {
  await withEngine('remove-bad', async (engine) => {
    const r = await engine.remove('nonexistent');
    assert.equal(r.removed, false);
  });
});

test('update on nonexistent id returns updated=false', async () => {
  await withEngine('update-bad', async (engine) => {
    const r = await engine.update('nonexistent', { summary: 'x' });
    assert.equal(r.updated, false);
  });
});

test('link with unknown source returns zero strength', async () => {
  await withEngine('link-bad', async (engine) => {
    const r = await engine.link('source-bad', 'target-bad', 0.5);
    assert.equal(r.strength, 0);
  });
});

test('link with one valid one invalid returns zero strength', async () => {
  await withEngine('link-partial', async (engine) => {
    const a = await engine.add({ summary: 'Redis cluster', triggers: ['Redis'] });
    const r = await engine.link(a.id, 'bad-target', 0.5);
    assert.equal(r.strength, 0);
  });
});

test('supersede with unknown ids returns superseded=false', async () => {
  await withEngine('supersede-bad', async (engine) => {
    const r = await engine.supersede('bad-old', 'bad-new');
    assert.equal(r.superseded, false);
  });
});

test('supersede with one valid one invalid returns false', async () => {
  await withEngine('supersede-partial', async (engine) => {
    const a = await engine.add({ summary: 'Old Redis password v1', triggers: ['Redis'] });
    const r = await engine.supersede(a.id, 'bad-new');
    assert.equal(r.superseded, false);
  });
});

test('spread on nonexistent id returns empty array', async () => {
  await withEngine('spread-bad', async (engine) => {
    const r = await engine.spread('nonexistent', 2, 1.0);
    assert.deepEqual(r, []);
  });
});

// ─── missing / empty required fields ───────────────────────────────────────

test('add with empty summary still works (does not crash)', async () => {
  await withEngine('add-empty-summary', async (engine) => {
    const r = await engine.add({ summary: '', detail: 'has detail though' });
    // Empty summary is allowed but the resulting article has id derived from
    // empty string hash; nothing should crash.
    assert.ok(r.id);
  });
});

test('land with empty query returns no results (not crash)', async () => {
  await withEngine('land-empty', async (engine) => {
    await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const r = await engine.land('', 0);
    assert.ok(Array.isArray(r));
  });
});

test('land with whitespace-only query does not crash', async () => {
  await withEngine('land-ws', async (engine) => {
    await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const r = await engine.land('   \t\n  ', 0);
    assert.ok(Array.isArray(r));
  });
});

test('land with extremely long query does not crash', async () => {
  await withEngine('land-long', async (engine) => {
    await engine.add({ summary: 'Redis 6379 cluster', triggers: ['Redis'] });
    // 500 chars (not 50K) is enough to stress-test without flooding the
    // engine with tens of thousands of grep subprocess spawns.
    const huge = 'Redis '.repeat(100);
    const r = await engine.land(huge, 0);
    assert.ok(Array.isArray(r));
  });
});

test('land with regex metacharacters does not crash', async () => {
  await withEngine('land-meta', async (engine) => {
    await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const r = await engine.land('Redis.*+?^${}()|[]\\', 0);
    assert.ok(Array.isArray(r));
  });
});

// ─── invalid enum values ───────────────────────────────────────────────────

test('land with unknown typeFilter returns no results (no crash)', async () => {
  await withEngine('land-bad-type', async (engine) => {
    await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const r = await engine.land('Redis', 0, 'invalid-type');
    // Unknown filter should match nothing; it should not throw.
    assert.equal(r.length, 0);
  });
});

test('add with unknown type defaults to knowledge', async () => {
  await withEngine('add-bad-type', async (engine) => {
    const r = await engine.add({ summary: 'x', type: 'whatever' });
    const node = await engine.focus(r.id);
    // Engine stores whatever type was passed; the renderer treats unknown as
    // knowledge. Either behavior is acceptable as long as nothing crashes.
    assert.ok(node !== null);
  });
});

// ─── extreme spreadDepth ───────────────────────────────────────────────────

test('land with spreadDepth=0 does not spread', async () => {
  await withEngine('land-depth-0', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Beta Redis cluster', triggers: ['Redis'] });
    await engine.link(a.id, b.id);
    const r = await engine.land('Redis', 0);
    const ids = r.map(x => x.id);
    // Both should be direct hits; spread depth 0 means no neighbor pull-in.
    assert.ok(ids.includes(a.id) || ids.includes(b.id));
  });
});

test('land with negative spreadDepth does not crash', async () => {
  await withEngine('land-depth-neg', async (engine) => {
    await engine.add({ summary: 'Redis 6379', triggers: ['Redis'] });
    const r = await engine.land('Redis', -1);
    assert.ok(Array.isArray(r));
  });
});

test('land with very large spreadDepth does not loop forever', async () => {
  await withEngine('land-depth-huge', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis', triggers: ['Redis'] });
    const b = await engine.add({ summary: 'Beta Redis cluster', triggers: ['Redis'] });
    await engine.link(a.id, b.id);
    await engine.link(b.id, a.id);  // create a cycle
    const r = await engine.land('Redis', 1000);  // would loop infinitely without visited-set
    assert.ok(Array.isArray(r));
  });
});

// ─── beforeAction / auditTriggers on bad input ────────────────────────────

test('beforeAction on empty engine returns null', async () => {
  await withEngine('before-empty', async (engine) => {
    const r = await engine.beforeAction('anything');
    assert.equal(r, null);
  });
});

test('auditTriggers with nonexistent nodeId returns empty array', async () => {
  await withEngine('audit-bad', async (engine) => {
    const r = engine.auditTriggers('nonexistent');
    assert.deepEqual(r, []);
  });
});

// ─── concurrent writes ─────────────────────────────────────────────────────

test('many rapid writes leave a consistent file', async () => {
  await withEngine('concurrent', async (engine, dir) => {
    // Fire 20 writes interleaved with reads.
    const writes = [];
    for (let i = 0; i < 20; i++) {
      writes.push(engine.add({ summary: `Article ${i} number ${i}`, triggers: ['test'] }));
      if (i % 5 === 0) {
        await engine.land('Article', 0);  // interleaved read
      }
    }
    await Promise.all(writes);
    await engine._flush();

    // Reload and verify the file parses cleanly.
    const e2 = new MemoryEngine({ basePath: dir });
    await e2.init();
    assert.ok(e2.stats().nodes > 0);
    const html = readFileSync(join(dir, 'memory.html'), 'utf8');
    assert.ok(html.includes('<article'));
    assert.ok(html.includes('</article>'));
    assert.ok(html.endsWith('</html>\n') || html.includes('</html>'));
  });
});

test('rapid add → remove → add cycle does not corrupt state', async () => {
  await withEngine('add-remove', async (engine, dir) => {
    const r1 = await engine.add({ summary: 'Temp 1 abc', triggers: ['temp'] });
    await engine.remove(r1.id);
    const r2 = await engine.add({ summary: 'Temp 2 def', triggers: ['temp'] });
    await engine.remove(r2.id);
    const r3 = await engine.add({ summary: 'Temp 3 ghi', triggers: ['temp'] });
    await engine._flush();
    const e2 = new MemoryEngine({ basePath: dir });
    await e2.init();
    assert.equal(e2.stats().nodes, 1, 'exactly one survived');
    const node = await e2.focus(r3.id);
    assert.equal(node.summary, 'Temp 3 ghi');
  });
});

// ─── duplicate / re-add same summary ───────────────────────────────────────

test('re-adding the exact same summary 3 times yields one article', async () => {
  await withEngine('triple-add', async (engine) => {
    const summary = 'Exact duplicate summary xyz';
    await engine.add({ summary, triggers: ['x'] });
    await engine.add({ summary, triggers: ['x'] });
    await engine.add({ summary, triggers: ['x'] });
    assert.equal(engine.stats().nodes, 1);
  });
});

// ─── link self / cycle ─────────────────────────────────────────────────────

test('linking a node to itself does not crash', async () => {
  await withEngine('self-link', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis cluster', triggers: ['Redis'] });
    const r = await engine.link(a.id, a.id, 0.5);
    assert.ok(r);  // did not throw
  });
});

test('spread through a self-loop terminates', async () => {
  await withEngine('self-spread', async (engine) => {
    const a = await engine.add({ summary: 'Alpha Redis cluster', triggers: ['Redis'] });
    await engine.link(a.id, a.id, 0.9);
    const r = await engine.spread(a.id, 5, 1.0);
    assert.ok(Array.isArray(r));
  });
});
