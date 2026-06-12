/**
 * Benchmark: Grep-based retrieval vs dataset.
 * Target: 85%+ hit rate (BM25 baseline: 83%, full system: 95%).
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { knowledgeBase, testCases } from './dataset.js';

const TEST_DIR = join(import.meta.url.replace('file:///', '').replace('file://', ''), '..', '.bench-grep');
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

console.log('=== Benchmark: Grep-Based Retrieval ===\n');

const engine = new MemoryEngine({ basePath: TEST_DIR });
await engine.init();

// Seed knowledge
for (const item of knowledgeBase) {
  await engine.add({ ...item, author: 'eval' });
}

console.log(`Knowledge base: ${engine.stats().nodes} nodes\n`);

// Run all test cases
let hits = 0;
let misses = 0;
let correctContent = 0;
let totalWithExpect = 0;
const categoryStats = {};

for (const tc of testCases) {
  const results = await engine.land(tc.query, 0);

  if (!categoryStats[tc.category]) categoryStats[tc.category] = { hits: 0, total: 0, misses: [] };

  if (tc.expectEmpty) {
    if (results.length === 0) {
      hits++;
      categoryStats[tc.category].hits++;
    } else {
      misses++;
      categoryStats[tc.category].misses.push(`"${tc.query}" → got ${results.length} results`);
    }
    categoryStats[tc.category].total++;
  } else if (tc.expectContains) {
    totalWithExpect++;
    const found = results.find(r =>
      (r.summary && r.summary.includes(tc.expectContains)) ||
      (r.detail && r.detail.includes(tc.expectContains))
    );
    if (found) {
      hits++;
      correctContent++;
      categoryStats[tc.category].hits++;
    } else {
      misses++;
      categoryStats[tc.category].misses.push(`"${tc.query}" (miss: ${tc.expectContains}, got ${results.length} results)`);
    }
    categoryStats[tc.category].total++;
  } else {
    if (results.length > 0) {
      hits++;
      categoryStats[tc.category].hits++;
    } else {
      misses++;
      categoryStats[tc.category].misses.push(`"${tc.query}" → got 0 results`);
    }
    categoryStats[tc.category].total++;
  }
}

// Report
console.log(`Overall: ${hits}/${testCases.length} (${(hits / testCases.length * 100).toFixed(0)}%)`);
console.log(`Content match: ${correctContent}/${totalWithExpect} (${(correctContent / totalWithExpect * 100).toFixed(0)}%)\n`);

console.log('Per-category:');
for (const [cat, s] of Object.entries(categoryStats)) {
  const rate = (s.hits / s.total * 100).toFixed(0);
  const icon = rate === '100' ? '+' : parseInt(rate) >= 80 ? '~' : '-';
  console.log(`  [${icon}] ${cat.padEnd(12)} ${s.hits}/${s.total} (${rate}%)`);
  for (const m of s.misses.slice(0, 3)) {
    console.log(`      MISS: ${m}`);
  }
}

// Show the generated HTML file size
import { statSync } from 'fs';
const htmlPath = join(TEST_DIR, 'memory.html');
if (existsSync(htmlPath)) {
  const size = statSync(htmlPath).size;
  console.log(`\nHTML file size: ${(size / 1024).toFixed(1)} KB`);
}

rmSync(TEST_DIR, { recursive: true });
console.log('\nDone.');
