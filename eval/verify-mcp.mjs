/**
 * End-to-end test: spawn mcp-server.mjs as a subprocess and call each tool.
 */
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const TEST_NS = join(ROOT, '.mcp-test');

if (existsSync(TEST_NS)) rmSync(TEST_NS, { recursive: true });

const serverPath = join(ROOT, 'mcp-server.mjs');
const transport = new StdioClientTransport({
  command: 'node',
  args: [serverPath],
  env: { ...process.env, MEMORY_PATH: TEST_NS },
});

const client = new Client({ name: 'test', version: '0.0.0' });
await client.connect(transport);
console.log('Connected to MCP server\n');

// 1. List tools
const toolsList = await client.listTools();
console.log(`Tools exposed (${toolsList.tools.length}): ${toolsList.tools.map(t => t.name).join(', ')}\n`);

// 2. Store a knowledge memory
console.log('--- memory_store (knowledge) ---');
let r = await client.callTool({
  name: 'memory_store',
  arguments: {
    summary: 'Production Redis password r3d1s_v2_2025, port 6379, host 192.168.1.101',
    detail: '3-node cluster. Sentinels on 101/102/103. Pool size 100.',
    triggers: ['Redis password', 'Redis connection config'],
    type: 'knowledge',
    author: 'test',
  },
});
console.log(r.content[0].text + '\n');

// 3. Store a conversation memory
console.log('--- memory_store (conversation) ---');
r = await client.callTool({
  name: 'memory_store',
  arguments: {
    summary: 'Redis upgrade discussion',
    conversation: 'User: Should we rotate the production Redis password?\nAI: Recommended — current one is 2 years old.',
    type: 'conversation',
    author: 'test',
  },
});
console.log(r.content[0].text + '\n');

// 4. Recall knowledge
console.log('--- memory_recall (knowledge only) ---');
r = await client.callTool({
  name: 'memory_recall',
  arguments: { query: 'how to connect to Redis', typeFilter: 'knowledge' },
});
console.log(r.content[0].text + '\n');

// 5. Recall conversation
console.log('--- memory_recall (conversation only) ---');
r = await client.callTool({
  name: 'memory_recall',
  arguments: { query: 'Redis upgrade', typeFilter: 'conversation' },
});
console.log(r.content[0].text + '\n');

// 6. List all
console.log('--- memory_list (all) ---');
r = await client.callTool({ name: 'memory_list', arguments: {} });
console.log(r.content[0].text + '\n');

// 7. Read the first knowledge memory by ID
console.log('--- memory_read ---');
const listR = await client.callTool({
  name: 'memory_recall',
  arguments: { query: 'Redis password' },
});
// Parse out the first id
const idMatch = listR.content[0].text.match(/id=([a-f0-9]+)/);
if (idMatch) {
  r = await client.callTool({ name: 'memory_read', arguments: { id: idMatch[1] } });
  console.log(r.content[0].text + '\n');
}

// 8. Low-level grep — agent-as-retriever pattern
console.log('--- memory_grep (raw line matches with context) ---');
r = await client.callTool({
  name: 'memory_grep',
  arguments: { pattern: 'Redis', contextLines: 1, limit: 5 },
});
console.log(r.content[0].text + '\n');

// 9. Grep restricted to knowledge type
console.log('--- memory_grep (knowledge only) ---');
r = await client.callTool({
  name: 'memory_grep',
  arguments: { pattern: '6379', typeFilter: 'knowledge' },
});
console.log(r.content[0].text + '\n');

// 10. Grep with no matches
console.log('--- memory_grep (no matches) ---');
r = await client.callTool({
  name: 'memory_grep',
  arguments: { pattern: 'zzznomatchzzz' },
});
console.log(r.content[0].text + '\n');

// 11. AST-lite symbol search
console.log('--- memory_store (code memory) ---');
r = await client.callTool({
  name: 'memory_store',
  arguments: {
    summary: 'Payment service implementation',
    detail: 'function processPayment(amount, currency) { ... }\nclass PaymentService { refundPayment(txId) { ... } }\nconst MAX_AMOUNT = 10000;',
    type: 'knowledge',
    author: 'test',
  },
});
console.log(r.content[0].text + '\n');

console.log('--- memory_find_symbol (function) ---');
r = await client.callTool({
  name: 'memory_find_symbol',
  arguments: { name: 'processPayment', kind: 'function' },
});
console.log(r.content[0].text + '\n');

console.log('--- memory_find_symbol (any kind, payment) ---');
r = await client.callTool({
  name: 'memory_find_symbol',
  arguments: { name: 'Payment', kind: 'any' },
});
console.log(r.content[0].text + '\n');

console.log('--- memory_find_symbol (const) ---');
r = await client.callTool({
  name: 'memory_find_symbol',
  arguments: { name: 'MAX_AMOUNT', kind: 'const' },
});
console.log(r.content[0].text + '\n');

await client.close();
rmSync(TEST_NS, { recursive: true });
console.log('Done.');
