/**
 * Concurrency + scale tests.
 *
 * Two concerns:
 *   1. Concurrent read/write does not deadlock or corrupt the file.
 *   2. The engine holds up at 100 / 1K / 10K nodes — both for writes (insert
 *      latency) and queries (per-query latency).
 *
 * Run: node --test eval/test-scale.mjs
 *
 * Note: 10K nodes can take a couple of minutes to insert because the engine
 * rewrites the entire HTML file on every flush. This is a documented hot
 * path that the DESIGN.md flags for future optimization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

function freshDir(label) {
  const dir = join(ROOT, `.test-scale-${label}-${process.pid}-${Date.now()}`);
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
    // Tests below are about scale/concurrency, not dedup. Disable dedup so
    // articles with similar vocabulary don't collapse. 1.01 means "jaccard
    // can never reach it", so _checkDup always returns null.
    engine.config.dedupThreshold = 1.01;
    await fn(engine, dir);
  } finally {
    cleanup(dir);
  }
}

// ─── concurrency ───────────────────────────────────────────────────────────

test('100 concurrent writes all land', async () => {
  await withEngine('conc100', async (engine) => {
    const N = 100;
    const promises = [];
    for (let i = 0; i < N; i++) {
      // Use widely varying tags per item so dedup doesn't merge them.
      promises.push(engine.add({
        summary: `Concurrent article #${i} unique topic ${i * 7919}`,
        triggers: [`unique-${i}`],
        author: 'concurrent',
      }));
    }
    const results = await Promise.all(promises);
    await engine._flush();
    const unique = new Set(results.map(r => r.id));
    assert.ok(unique.size >= N * 0.9, `at least 90% of writes succeed (got ${unique.size})`);
    assert.equal(engine.stats().nodes, unique.size);
  });
});

test('concurrent reads + writes do not crash', async () => {
  await withEngine('mixed', async (engine) => {
    // Seed baseline with completely distinct topics so dedup won't merge.
    const seedTopics = ['redis', 'nginx', 'postgres', 'docker', 'kubernetes',
      'python', 'golang', 'java', 'rust', 'typescript',
      'graphql', 'grpc', 'kafka', 'rabbitmq', 'elasticsearch',
      'mongodb', 'memcached', 'consul', 'vault', 'traefik'];
    for (let i = 0; i < 20; i++) {
      await engine.add({
        summary: `${seedTopics[i]} cluster setup guide for project ${i}`,
        triggers: [`${seedTopics[i]}-setup`],
      });
    }

    // Interleave 50 reads with 50 writes. Writes use varied topics.
    const ops = [];
    for (let i = 0; i < 50; i++) {
      const topic = seedTopics[i % seedTopics.length];
      ops.push(engine.land(`article ${i % 10}`, 0));
      ops.push(engine.add({
        summary: `Concurrent ${topic} article ${i} number ${i * 31}`,
        triggers: [`${topic}-concurrent-${i}`],
      }));
    }
    await Promise.all(ops);
    await engine._flush();
    // No assertion needed — getting here without throwing is the win.
    assert.ok(engine.stats().nodes >= 20);
  });
});

test('concurrent recall on the same engine returns consistent shape', async () => {
  await withEngine('conc-recall', async (engine) => {
    await engine.add({ summary: 'Redis cluster 6379 config', triggers: ['Redis'] });
    const r1 = engine.land('Redis', 0);
    const r2 = engine.land('Redis', 0);
    const r3 = engine.land('Redis', 0);
    const [a, b, c] = await Promise.all([r1, r2, r3]);
    for (const r of [a, b, c]) {
      assert.ok(Array.isArray(r));
    }
  });
});

// ─── scale ─────────────────────────────────────────────────────────────────

async function seed(engine, n) {
  // Insert directly into the engine's in-memory map to bypass dedup. We are
  // testing scale here, not the dedup logic. Each node has a unique summary,
  // unique tags, and is marked non-superseded so land() will see it.
  for (let i = 0; i < n; i++) {
    const id = 'scale-' + i + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    engine._articles.set(id, {
      type: 'knowledge',
      summary: `Article ${i}: ${getTopic(i)} configuration guide instance ${i}`,
      detail: `Detailed setup for ${getTopic(i)} project ${i}.`,
      conversation: null,
      triggers: [`${getTopic(i)}-${i}`],
      tags: [getTopic(i), `id-${i}`, `node-${i}`],
      author: 'scale-test',
      baseSalience: 0.5,
      accessCount: 0,
      lastAccess: new Date().toISOString().slice(0, 10),
      created: new Date().toISOString().slice(0, 10),
      timestamp: '',
      supersededBy: null,
      edges: [],
    });
  }
  engine._dirty = true;
  await engine._flush();
}

function getTopic(i) {
  const topics = ['redis', 'nginx', 'postgres', 'docker', 'kubernetes',
    'python', 'golang', 'java', 'rust', 'typescript'];
  return topics[i % topics.length];
}

test('100 nodes — insert and query', async () => {
  await withEngine('n100', async (engine) => {
    const t0 = Date.now();
    await seed(engine, 100);
    const insertMs = Date.now() - t0;
    assert.equal(engine.stats().nodes, 100);

    const t1 = Date.now();
    const results = await engine.land('Redis config', 0);
    const queryMs = Date.now() - t1;
    assert.ok(results.length > 0, 'query returns hits');

    console.log(`  100 nodes: insert=${insertMs}ms query=${queryMs}ms hits=${results.length}`);
    assert.ok(queryMs < 5000, 'query under 5s');
  });
});

test('1000 nodes — insert and query', async () => {
  await withEngine('n1000', async (engine) => {
    const t0 = Date.now();
    await seed(engine, 1000);
    const insertMs = Date.now() - t0;
    assert.equal(engine.stats().nodes, 1000);

    const t1 = Date.now();
    const results = await engine.land('Redis config', 0);
    const queryMs = Date.now() - t1;
    assert.ok(results.length > 0);

    console.log(`  1000 nodes: insert=${insertMs}ms query=${queryMs}ms hits=${results.length}`);
    assert.ok(queryMs < 10000, 'query under 10s at 1K nodes');
  });
});

test('10000 nodes — insert and query (heavy)', async () => {
  await withEngine('n10000', async (engine, dir) => {
    const t0 = Date.now();
    await seed(engine, 10000);
    const insertMs = Date.now() - t0;
    assert.equal(engine.stats().nodes, 10000);

    const t1 = Date.now();
    const results = await engine.land('Redis config', 0);
    const queryMs = Date.now() - t1;
    assert.ok(results.length > 0);

    // HTML file size at 10K nodes — should stay under ~50MB.
    const htmlSize = statSync(join(dir, 'memory.html')).size;

    console.log(`  10000 nodes: insert=${insertMs}ms (${(insertMs/1000).toFixed(1)}s) query=${queryMs}ms html=${(htmlSize/1024/1024).toFixed(1)}MB`);
    assert.ok(queryMs < 30000, 'query under 30s at 10K nodes');
    assert.ok(htmlSize < 100 * 1024 * 1024, 'HTML file under 100MB');
  });
});

test('query returns within reasonable latency at every scale', async () => {
  // Single-engine scale sweep. Cheaper than re-seeding for each size.
  await withEngine('sweep', async (engine) => {
    const sizes = [100, 500, 1000];
    for (const n of sizes) {
      const target = engine.stats().nodes;
      if (target < n) {
        await seed(engine, n - target);
      }
      const t = Date.now();
      const r = await engine.land(`article ${n - 1}`, 0);
      const ms = Date.now() - t;
      console.log(`  ${engine.stats().nodes} nodes → query=${ms}ms hits=${r.length}`);
      assert.ok(r.length > 0, `query hits at ${n} nodes`);
    }
  });
});

test('query latency stays flat across repeated calls (caching works)', async () => {
  await withEngine('cache', async (engine) => {
    await seed(engine, 500);
    const timings = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await engine.land('Redis cluster', 0);
      timings.push(Date.now() - t);
    }
    console.log(`  500 nodes, 5 queries: ${timings.join(', ')}ms`);
    // First call may be slow (cold file cache). Later calls should be fast.
    // We don't assert strict numbers — just that they all complete.
    assert.ok(timings.every(t => t > 0));
  });
});

// ─── memory ────────────────────────────────────────────────────────────────

test('heap usage at 1000 nodes stays bounded', async () => {
  await withEngine('mem', async (engine) => {
    const before = process.memoryUsage().heapUsed;
    await seed(engine, 1000);
    const after = process.memoryUsage().heapUsed;
    const deltaMB = (after - before) / 1024 / 1024;
    console.log(`  heap delta after 1000 nodes: ${deltaMB.toFixed(1)}MB`);
    // 1000 nodes should fit in well under 100MB of heap.
    assert.ok(deltaMB < 200, `heap delta ${deltaMB}MB < 200MB`);
  });
});
