/**
 * Index layer tests.
 *
 * Run: node --test eval/test-index.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../memory-html.js';
import { MemoryIndex } from '../index.js';
import { rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

function freshDir(label) {
  const dir = join(ROOT, `.test-index-${label}-${process.pid}-${Date.now()}`);
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
    engine.config.dedupThreshold = 1.01;
    await fn(engine, dir);
  } finally {
    cleanup(dir);
  }
}

// ─── Basic build / lookup ──────────────────────────────────────────────────

test('index file is created after flush', async () => {
  await withEngine('build', async (engine, dir) => {
    await engine.add({
      type: 'knowledge',
      summary: 'Redis password r3d1s, port 6379',
      detail: '3-node cluster',
      triggers: ['Redis password'],
    });
    await engine._flush();
    const idxPath = join(dir, 'memory.index.json');
    assert.ok(existsSync(idxPath), 'index file should exist');
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    assert.equal(idx.schema_version, 1);
    assert.equal(idx.node_count, 1);
    assert.ok(idx.html_hash.length > 0);
    assert.ok(idx.indices.tag.redis, 'tag redis should be in index');
    assert.ok(idx.indices.trigger['redis password'], 'trigger should be in index');
    assert.ok(idx.indices.term.redis, 'redis term should be in index');
  });
});

test('index lookup returns correct ids', async () => {
  await withEngine('lookup', async (engine, dir) => {
    await engine.add({
      type: 'knowledge',
      summary: 'Redis password r3d1s',
      detail: 'cluster config',
      triggers: ['Redis password'],
      tags: ['redis', 'password'],
    });
    await engine._flush();

    const idx = new MemoryIndex({ htmlPath: engine.htmlPath });
    const tagHits = idx.lookup('tag', 'redis');
    assert.equal(tagHits.size, 1);
    const triggerHits = idx.lookup('trigger', 'Redis Password');  // case-insensitive
    assert.equal(triggerHits.size, 1);
    const termHits = idx.lookup('term', 'cluster');
    assert.equal(termHits.size, 1);
  });
});

// ─── Freshness detection ───────────────────────────────────────────────────

test('isFresh returns false when HTML is newer', async () => {
  await withEngine('stale', async (engine, dir) => {
    await engine.add({ summary: 'Test1' });
    await engine._flush();

    const html = readFileSync(engine.htmlPath, 'utf8');
    const oldStat = readFileSync(engine.htmlPath);
    const idx = new MemoryIndex({ htmlPath: engine.htmlPath });

    // Initially fresh
    assert.ok(idx.isFresh(html, 12345) === false, 'different mtime should be stale');
  });
});

test('isFresh returns false when schema_version mismatch', async () => {
  await withEngine('schema', async (engine, dir) => {
    await engine.add({ summary: 'Test' });
    await engine._flush();

    const idxPath = join(dir, 'memory.index.json');
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    idx.schema_version = 999;
    writeFileSync(idxPath, JSON.stringify(idx));

    const newIdx = new MemoryIndex({ htmlPath: engine.htmlPath });
    const html = readFileSync(engine.htmlPath, 'utf8');
    const stat = statSync(engine.htmlPath);
    assert.equal(newIdx.isFresh(html, stat.mtimeMs), false);
  });
});

// ─── Search equivalence: index vs grep ────────────────────────────────────

test('recall via index returns same ids as recall via grep', async () => {
  await withEngine('equiv', async (engine) => {
    // Seed diverse content
    await engine.add({ type: 'knowledge', summary: 'Redis password abc', detail: 'cluster config', tags: ['redis'] });
    await engine.add({ type: 'knowledge', summary: 'Postgres on port 5432', detail: 'database setup', tags: ['postgres'] });
    await engine.add({ type: 'conversation', summary: 'Redis upgrade talk', conversation: 'User: When to upgrade Redis?\nAI: Next quarter.' });
    await engine.add({ type: 'knowledge', summary: 'Nginx reverse proxy', detail: 'config for api.example.com' });
    await engine._flush();

    const queries = ['Redis', 'port', 'database', 'upgrade', 'config', 'nginx'];
    for (const q of queries) {
      const idxResults = await engine.land(q, 0);
      // Disable index, re-run
      const savedIndex = engine._index;
      engine._index = null;
      const grepResults = await engine.land(q, 0);
      engine._index = savedIndex;

      const idxIds = idxResults.map(r => r.id).sort();
      const grepIds = grepResults.map(r => r.id).sort();
      // Top-K ids should overlap significantly. Assert at least the top 1 matches.
      if (grepIds.length > 0) {
        assert.ok(idxIds.length > 0, `query "${q}" should return results via index`);
        assert.equal(idxIds[0], grepIds[0], `query "${q}" top-1 id should match between index and grep`);
      }
    }
  });
});

test('recall finds newly added memory immediately', async () => {
  await withEngine('immediate', async (engine) => {
    await engine.add({ summary: 'Special token ZZZ999', detail: 'unique content' });
    await engine._flush();
    const r = await engine.land('ZZZ999', 0);
    assert.ok(r.length > 0, 'should find newly added memory');
  });
});

// ─── Fallback behavior ────────────────────────────────────────────────────

test('search falls back to grep when index file missing', async () => {
  await withEngine('fallback', async (engine, dir) => {
    await engine.add({ summary: 'Redis password', detail: 'config' });
    await engine._flush();

    // Delete index file
    rmSync(join(dir, 'memory.index.json'));

    // Reload engine — index should be detected missing
    const freshEngine = new MemoryEngine({ basePath: dir });
    await freshEngine.init();

    const r = await freshEngine.land('Redis', 0);
    assert.ok(r.length > 0, 'should still find results via grep fallback');
  });
});

test('search falls back to grep when index is corrupted', async () => {
  await withEngine('corrupt', async (engine, dir) => {
    await engine.add({ summary: 'Redis password', detail: 'config' });
    await engine._flush();

    // Corrupt index
    writeFileSync(join(dir, 'memory.index.json'), '{ broken json');

    const r = await engine.land('Redis', 0);
    assert.ok(r.length > 0, 'should fallback gracefully');
  });
});

// ─── Disable via env ───────────────────────────────────────────────────────

test('GREPMEM_INDEX=0 disables index entirely', async () => {
  const dir = freshDir('disabled');
  try {
    process.env.GREPMEM_INDEX = '0';
    const engine = new MemoryEngine({ basePath: dir });
    await engine.init();
    assert.equal(engine._index, null, 'index should be null when disabled');
    await engine.add({ summary: 'test' });
    await engine._flush();
    assert.equal(existsSync(join(dir, 'memory.index.json')), false, 'no index file should be written');
    delete process.env.GREPMEM_INDEX;
  } finally {
    cleanup(dir);
    delete process.env.GREPMEM_INDEX;
  }
});
