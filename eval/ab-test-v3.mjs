/**
 * A/B Test v3: On-demand tool-call memory vs bare agent.
 *
 * Philosophy: Memory lives on disk. Agent decides when to query.
 * This test simulates two agents:
 *   A: Bare agent — answers directly
 *   B: Tooled agent — has memory_recall tool, decides when to use it
 *
 * The tooled agent gets a multi-turn conversation:
 *   Turn 1: User asks question
 *   Turn 2: Agent may call memory_recall tool (or not)
 *   Turn 3: Tool returns results
 *   Turn 4: Agent answers with tool results
 */

import { MemoryEngine } from '../memory-html.js';
import { rmSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

// Node.js can't reach api.stepfun.com directly (proxy interference).
// Use Python subprocess via temp file to avoid shell quoting issues.
let scriptCounter = 0;
function callLLMViaPython(messages, tools = null) {
  const payload = JSON.stringify({ messages, tools, model: API_MODEL, temperature: 0.1, reasoning_effort: REASONING_EFFORT });
  const scriptPath = join(tmpdir(), `llm_call_${process.pid}_${++scriptCounter}.py`);
  const pythonCode = `
import urllib.request, json, os
for k in ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY']:
    os.environ.pop(k, None)
data = json.loads(${JSON.stringify(payload)})
req = urllib.request.Request('${API_BASE}/chat/completions',
  data=json.dumps(data).encode(),
  headers={'Content-Type':'application/json','Authorization':'Bearer ${API_KEY}'})
r = urllib.request.urlopen(req, timeout=60)
result = r.read().decode()
obj = json.loads(result)
msg = obj['choices'][0]['message']
print(json.dumps(msg))
`;
  writeFileSync(scriptPath, pythonCode, 'utf8');
  try {
    const result = execSync(`python "${scriptPath}"`, { timeout: 60000, encoding: 'utf8' });
    return JSON.parse(result.trim());
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

const TEST_DIR = join(import.meta.url.replace('file:///', '').replace('file://', ''), '..', '.ab-test3');
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

const API_KEY = process.env.LLM_KEY || process.env.OPENAI_API_KEY;
const API_BASE = (process.env.LLM_BASE || 'https://api.openai.com/v1').replace(/,+$/, '');
const API_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const REASONING_EFFORT = process.env.REASONING_EFFORT || 'high';
const ROUNDS = parseInt(process.env.ROUNDS || '2');

if (!API_KEY) {
  console.error('Set LLM_KEY + LLM_BASE. Example:');
  console.error('LLM_KEY=xxx LLM_BASE=https://api.stepfun.com/v1 LLM_MODEL=step-3.5-flash node eval/ab-test-v3.mjs');
  process.exit(1);
}

console.log('=== A/B Test v3: On-Demand Tool-Call Memory ===\n');
console.log(`API: ${API_MODEL} (reasoning: ${REASONING_EFFORT})`);
console.log(`Rounds: ${ROUNDS}\n`);

// ─── Private knowledge base ──────────────────────────────────────────────────

const privateKnowledge = [
  {
    summary: '公司项目admin-panel部署在内网192.168.1.100:3000，SSH用户名deployer',
    detail: '通过VPN连接后访问。数据库在同一台机器的5432端口，数据库名admin_prod。部署用PM2，进程名admin-panel',
    triggers: ['admin-panel部署信息', '内网后台地址', '公司管理后台在哪', 'SSH连接生产服务器', 'deployer用户'],
  },
  {
    summary: '项目用的Redis密码是r3d1s_pr0d_2024!，端口6379，在192.168.1.101',
    detail: 'Redis集群模式，3个节点。哨兵在101、102、103。连接池大小设为50',
    triggers: ['Redis密码', 'Redis连接配置', 'Redis集群地址', '生产Redis配置'],
  },
  {
    summary: '用户认证用的是JWT，密钥存在环境变量JWT_SECRET里，token过期时间2小时',
    detail: 'refresh token 7天。token存在cookie里，httpOnly=true, secure=true, sameSite=strict',
    triggers: ['JWT配置', 'token过期时间', 'JWT密钥在哪', '认证token设置'],
  },
  {
    summary: 'CI/CD用的GitLab Runner，runner标签是docker-shell，注册token在~/.gitlab-runner/config.toml',
    detail: '流水线有4个stage: lint→test→build→deploy。deploy只在main分支触发。构建产物在/artifacts目录',
    triggers: ['CI/CD配置', 'GitLab Runner', '流水线配置', 'runner注册token'],
  },
  {
    summary: '前端项目用pnpm，Node版本锁定18.19.0，用nvm管理',
    detail: '.nvmrc文件在项目根目录。不要升级Node版本，18.19.0是测试过的。pnpm版本8.x',
    triggers: ['前端项目Node版本', 'pnpm版本', 'nvm配置', 'Node版本要求'],
  },
  {
    summary: 'API网关在192.168.1.200:8080，用Kong，admin API在:8001',
    detail: '路由规则在Kong的services表。限流100req/min每服务。日志打到ELK: 192.168.1.250:9200',
    triggers: ['API网关地址', 'Kong配置', '微服务路由', '网关admin端口'],
  },
  {
    summary: '测试环境数据库用test_db，账号test_user，密码test_2024!@#，每天凌晨3点自动重置',
    detail: '重置脚本在scripts/reset-test-db.sh。测试用的mock数据在seed/目录',
    triggers: ['测试数据库配置', '测试环境数据库', 'test_db连接信息'],
  },
  {
    summary: '客户A（张总）要求所有API响应时间<200ms，SLA 99.9%，数据保留5年',
    detail: '合同编号CTR-2024-0088。监控告警发到钉钉群"运维告警A组"。每月出SLA报告',
    triggers: ['客户A SLA要求', '张总的合同要求', 'API性能要求', 'SLA标准'],
  },
  {
    summary: '线上OOM问题定位结果是图片处理服务没限制上传大小，2GB的图片直接加载到内存',
    detail: '已修复：加了sharp的limitInputPixels。但监控发现还有内存泄漏，怀疑是websocket连接没释放',
    triggers: ['线上OOM问题', '内存泄漏排查', '图片处理内存', 'websocket内存泄漏'],
  },
  {
    summary: '上次架构评审决定：新功能一律用TypeScript，老代码逐步迁移，不强制一次性改完',
    detail: '评审纪要在飞书文档"2024Q4架构评审"。参与人：老王、小李、张总。决议编号ARCH-2024-015',
    triggers: ['架构评审决定', 'TypeScript迁移策略', '技术选型决策'],
  },
];

const testQueries = [
  { query: 'admin-panel部署在哪台服务器', expectInfo: '192.168.1.100', desc: '内网地址' },
  { query: '生产环境Redis怎么连', expectInfo: 'r3d1s_pr0d_2024', desc: 'Redis密码' },
  { query: 'JWT的token过期时间是多少', expectInfo: '2小时', desc: 'JWT配置' },
  { query: 'GitLab Runner怎么配置的', expectInfo: 'docker-shell', desc: 'CI/CD' },
  { query: '项目用的什么Node版本', expectInfo: '18.19.0', desc: 'Node版本' },
  { query: 'API网关在哪', expectInfo: '192.168.1.200', desc: '网关' },
  { query: '测试环境数据库怎么连', expectInfo: 'test_user', desc: '测试DB' },
  { query: '张总对API性能有什么要求', expectInfo: '200ms', desc: '客户SLA' },
  { query: '上次OOM是什么原因', expectInfo: '图片', desc: '线上故障' },
  { query: 'TypeScript迁移策略是什么', expectInfo: '逐步迁移', desc: '架构决策' },
];

// ─── Build engine ────────────────────────────────────────────────────────────

console.log('Loading HTML+grep engine...\n');

const engine = new MemoryEngine({ basePath: TEST_DIR });
await engine.init();

for (const item of privateKnowledge) {
  await engine.add({ ...item, author: 'eval' });
}

console.log(`Knowledge base: ${engine.stats().nodes} nodes\n`);

// ─── LLM helpers ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function callLLM(messages, tools = null) {
  const now = Date.now();
  const gap = 10000 - (now - lastCall);
  if (gap > 0) await sleep(gap);
  lastCall = Date.now();

  for (let retry = 0; retry < 5; retry++) {
    try {
      return callLLMViaPython(messages, tools);
    } catch (e) {
      const is429 = e.message?.includes('429');
      if (retry < 4) {
        const wait = is429 ? 20000 * (retry + 1) : 10000 * (retry + 1);
        console.log(`\n  [${is429 ? 'rate limited' : 'error'}, retry ${retry + 1}/5 in ${wait/1000}s...]`);
        await sleep(wait);
      } else throw e;
    }
  }
}

const RECALL_TOOL = [{
  type: 'function',
  function: {
    name: 'memory_recall',
    description: 'Search long-term memory for project-specific knowledge, configs, past decisions. Use when you need info you wouldn\'t know without context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in natural language.' },
      },
      required: ['query'],
    },
  },
}];

// ─── Agent A: Bare ───────────────────────────────────────────────────────────

async function askBare(query) {
  const msg = await callLLM([
    { role: 'system', content: '你是一个全栈开发工程师。根据你的知识回答问题。如果不确定就说不知道，不要编造。' },
    { role: 'user', content: query },
  ]);
  return msg.content;
}

// ─── Agent B: Tooled (on-demand recall) ──────────────────────────────────────

async function askTooled(query) {
  const messages = [
    {
      role: 'system',
      content: '你是一个全栈开发工程师。你可以通过 memory_recall 工具查询项目知识库。\n'
        + '当你需要项目特定信息（服务器地址、密码、配置、客户要求等），调用该工具。\n'
        + '如果问题是你已经知道答案的通用知识，直接回答即可。',
    },
    { role: 'user', content: query },
  ];

  // Turn 1: Agent decides whether to call the tool
  const response1 = await callLLM(messages, RECALL_TOOL);

  // Check if agent chose to call the tool
  if (response1.tool_calls && response1.tool_calls.length > 0) {
    const toolCall = response1.tool_calls[0];
    const recallQuery = JSON.parse(toolCall.function.arguments).query;

    // Execute the recall against our memory engine
    const results = await engine.land(recallQuery);
    const toolResult = results.length > 0
      ? JSON.stringify({ results: results.slice(0, 3).map(r => ({ summary: r.summary, detail: r.detail, match: r.match })), count: results.length })
      : JSON.stringify({ results: [], count: 0, message: 'No matching memories.' });

    // Turn 2: Agent sees tool result and answers
    messages.push(response1);
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });

    const response2 = await callLLM(messages);
    return { answer: response2.content, recalled: true, recallQuery, recallCount: results.length };
  }

  // Agent answered directly without tool
  return { answer: response1.content, recalled: false, recallQuery: null, recallCount: 0 };
}

// ─── Scorer ──────────────────────────────────────────────────────────────────

async function scoreAnswer(query, answer, expectInfo) {
  const msg = await callLLM([
    {
      role: 'system',
      content: `判断回答是否包含期望的关键信息。
输出JSON: { "has_info": true/false, "score": 0-10, "reason": "一句话" }
- 有正确具体信息：8-10分
- 有部分信息：4-7分
- 说不知道/给通用建议但没有具体信息：0-3分
- 编造错误的具体信息：0分`,
    },
    { role: 'user', content: `问题: ${query}\n期望信息: ${expectInfo}\n\n回答:\n${answer}` },
  ]);

  try {
    const m = msg.content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch { /* */ }
  return { has_info: false, score: 0, reason: 'parse failed' };
}

// ─── Run test ────────────────────────────────────────────────────────────────

console.log(`Running test (${testQueries.length} queries x ${ROUNDS} rounds)...\n`);

const results = [];

for (const { query, expectInfo, desc } of testQueries) {
  let bareTotal = 0;
  let memTotal = 0;
  let bareHasInfo = 0;
  let memHasInfo = 0;
  let toolUsedCount = 0;
  let recallCountSum = 0;

  for (let round = 0; round < ROUNDS; round++) {
    process.stdout.write('.');

    // Bare agent
    const bareAnswer = await askBare(query);
    const bareScore = await scoreAnswer(query, bareAnswer, expectInfo);
    bareTotal += bareScore.score || 0;
    if (bareScore.has_info) bareHasInfo++;

    // Tooled agent (on-demand)
    const tooledResult = await askTooled(query);
    const memScore = await scoreAnswer(query, tooledResult.answer, expectInfo);
    memTotal += memScore.score || 0;
    if (memScore.has_info) memHasInfo++;
    if (tooledResult.recalled) {
      toolUsedCount++;
      recallCountSum += tooledResult.recallCount;
    }
  }

  const avgBare = (bareTotal / ROUNDS).toFixed(1);
  const avgMem = (memTotal / ROUNDS).toFixed(1);
  const winner = parseFloat(avgMem) > parseFloat(avgBare) ? 'TOOL' : parseFloat(avgBare) > parseFloat(avgMem) ? 'BARE' : 'TIE';
  const toolRate = (toolUsedCount / ROUNDS * 100).toFixed(0);
  const avgRecall = toolUsedCount > 0 ? (recallCountSum / toolUsedCount).toFixed(0) : '-';

  results.push({ query, desc, winner, avgBare, avgMem, toolRate, avgRecall, bareHasInfo, memHasInfo });

  const icon = winner === 'TOOL' ? '+' : winner === 'BARE' ? '-' : '=';
  console.log(`\n[${icon}] ${desc}: "${query}"`);
  console.log(`  bare: ${avgBare}/10 (${bareHasInfo}/${ROUNDS}有信息) | tool: ${avgMem}/10 (${memHasInfo}/${ROUNDS}有信息) | 工具使用率:${toolRate}% 平均召回:${avgRecall}条`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const toolWins = results.filter(r => r.winner === 'TOOL').length;
const bareWins = results.filter(r => r.winner === 'BARE').length;
const ties = results.filter(r => r.winner === 'TIE').length;
const avgBareAll = (results.reduce((s, r) => s + parseFloat(r.avgBare), 0) / results.length).toFixed(1);
const avgToolAll = (results.reduce((s, r) => s + parseFloat(r.avgMem), 0) / results.length).toFixed(1);

console.log('\n=== Summary ===\n');
console.log(`Tool wins:  ${toolWins}/${results.length}`);
console.log(`Bare wins:  ${bareWins}/${results.length}`);
console.log(`Ties:       ${ties}/${results.length}`);
console.log(`\nAvg score:  bare=${avgBareAll}/10  tool=${avgToolAll}/10  delta=+${(parseFloat(avgToolAll) - parseFloat(avgBareAll)).toFixed(1)}`);

console.log('\n=== Tool usage ===\n');
for (const r of results) {
  const icon = r.winner === 'TOOL' ? '+' : r.winner === 'BARE' ? '-' : '=';
  console.log(`[${icon}] ${r.desc.padEnd(12)} bare=${r.avgBare} tool=${r.avgMem}  使用率=${r.toolRate}% 召回=${r.avgRecall}条`);
}

rmSync(TEST_DIR, { recursive: true });
console.log('\nDone.');
