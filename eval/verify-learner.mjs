/**
 * Verify: Fail-Improve Loop.
 * Simulate repeated queries and check if the system learns new synonyms.
 */
import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(import.meta.url.replace('file:///', '').replace('file://', ''), '..', '.learner-test');
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

console.log('=== Verify: Fail-Improve Loop ===\n');

const engine = new MemoryEngine({ basePath: TEST_DIR });
await engine.init();

// Seed knowledge
await engine.add({
  summary: 'Kubernetes Pod调度用nodeSelector指定节点标签',
  detail: 'kubectl get nodes --show-labels 查看标签。Pod spec里写 nodeSelector: disktype: ssd',
  triggers: ['Kubernetes调度', 'Pod分配节点'],
  author: 'test',
});

await engine.add({
  summary: 'K8s Service用ClusterIP暴露内部服务',
  detail: '默认类型。spec.type: ClusterIP，分配一个集群内部可达的虚拟IP',
  triggers: ['K8s服务暴露', 'ClusterIP配置'],
  author: 'test',
});

console.log(`Seeded: ${engine.stats().nodes} nodes\n`);

// Simulate: user uses "k8s" abbreviation (not in triggers), repeated queries
const queries = [
  'k8s怎么调度Pod',
  'k8s服务怎么暴露',
  'k8s节点选择器',
  'k8s集群内部访问',
  'k8s标签怎么用',
];

console.log('--- Round 1: First queries, no learning yet ---\n');
for (const q of queries) {
  const results = await engine.land(q, 0);
  console.log(`  "${q}" → ${results.length} results, top match=${results[0]?.match || 0}`);
}

console.log('\n--- Round 2-4: Repeat queries to build co-occurrence ---\n');
for (let round = 2; round <= 4; round++) {
  for (const q of queries) {
    await engine.land(q, 0);
  }
  const stats = engine._learner.getStats();
  console.log(`  After round ${round}: tracked=${stats.queriesTracked} terms, learned=${stats.learnedPairs} pairs`);
}

console.log('\n--- Learned synonyms ---\n');
const learned = engine._learner.getAllLearned();
if (Object.keys(learned).length === 0) {
  console.log('  (none learned yet)');
} else {
  for (const [term, targets] of Object.entries(learned)) {
    console.log(`  "${term}" → [${targets.join(', ')}]`);
  }
}

console.log('\n--- Top candidates (close to being learned) ---\n');
const stats = engine._learner.getStats();
for (const c of stats.topCandidates) {
  console.log(`  "${c.term}" → "${c.target}" (count=${c.count}, needs ${3 - c.count} more)`);
}

console.log('\n--- Final test: does learned synonym improve recall? ---\n');
// Now query with the abbreviation that was learned
const finalQuery = 'k8s 调度策略';
const results = await engine.land(finalQuery, 0);
console.log(`  Query: "${finalQuery}"`);
console.log(`  Results: ${results.length}`);
if (results.length > 0) {
  console.log(`  Top: "${results[0].summary?.slice(0, 50)}..." match=${results[0].match}`);
}

engine._learner.flush();
rmSync(TEST_DIR, { recursive: true });
console.log('\nDone.');
