#!/usr/bin/env node
/**
 * MCP Server for Grepmem.
 *
 * Exposes memory tools to any MCP-aware host (Claude Code, Cursor, Cline):
 *   - memory_recall    Natural-language search across all memories
 *   - memory_read      Fetch the full content of one memory by ID
 *   - memory_list      Browse memories by type or tag
 *   - memory_store     Persist a new memory (knowledge or conversation)
 *
 * Implements the agent-as-retriever pattern: the agent decides when to query,
 * what to query, and how to refine. The engine never injects context.
 *
 * Usage:
 *   node mcp-server.mjs                              # uses ./namespaces/default
 *   MEMORY_PATH=./my-project node mcp-server.mjs     # custom namespace
 *
 * Wire into Claude Code:
 *   claude mcp add grepmem -- node /path/to/mcp-server.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { MemoryEngine } from './memory-html.js';

const require = createRequire(import.meta.url);
const { execSync, execFileSync } = require('node:child_process');
const { existsSync, readFileSync, statSync } = require('node:fs');

const NAMESPACE_PATH = process.env.MEMORY_PATH || './namespaces/default';

const engine = new MemoryEngine({ basePath: NAMESPACE_PATH });
await engine.init();

const stats = engine.stats();
process.stderr.write(
  `[grepmem] MCP server started. namespace=${NAMESPACE_PATH} nodes=${stats.nodes} edges=${stats.edges}\n`
);

const server = new McpServer({
  name: 'grepmem',
  version: '2.0.0',
});

// ─── Tool: memory_recall ────────────────────────────────────────────────────
server.tool(
  'memory_recall',
  'Search long-term memory. Returns top matches with id, summary, score, and tags. ' +
    'Use when you need project-specific knowledge (configs, decisions, past discussions) ' +
    'that you would not know without context. Pass typeFilter="conversation" to search ' +
    'only raw chat history, or "knowledge" to search only compiled facts.',
  {
    query: z.string().describe('Natural-language search query.'),
    typeFilter: z.enum(['knowledge', 'conversation']).optional()
      .describe('Restrict to one article type. Omit to search both.'),
    limit: z.number().optional().describe('Max results (default 5).'),
  },
  async ({ query, typeFilter, limit }) => {
    const results = await engine.land(query, 0, typeFilter || null);
    const capped = results.slice(0, limit || 5);
    if (capped.length === 0) {
      return text(`No memories matched "${query}". Try a different phrasing or use memory_list to browse.`);
    }
    const lines = capped.map((r, i) => {
      const tags = (engine._articles.get(r.id)?.tags || []).slice(0, 5).join(', ');
      return `${i + 1}. [${r.type || 'knowledge'}] id=${r.id}  score=${r.match}  tags=[${tags}]\n   ${r.summary}`;
    });
    return text(
      `Found ${results.length} match(es) for "${query}":\n\n${lines.join('\n\n')}\n\n` +
      `Call memory_read with an id above to see the full content.`
    );
  }
);

// ─── Tool: memory_read ──────────────────────────────────────────────────────
server.tool(
  'memory_read',
  'Read the full content of one memory by ID. Use after memory_recall to load ' +
    'the complete detail of a specific hit.',
  { id: z.string().describe('Memory ID from memory_recall or memory_list.') },
  async ({ id }) => {
    const node = await engine.focus(id);
    if (!node) return text(`Memory ${id} not found.`);
    const lines = [
      `ID:       ${node.id}`,
      `Type:     ${node.type || 'knowledge'}`,
      `Summary:  ${node.summary}`,
    ];
    if (node.detail) lines.push(`Detail:   ${node.detail}`);
    if (node.conversation) lines.push(`Conversation:\n${node.conversation}`);
    if (node.triggers?.length) lines.push(`Triggers: ${node.triggers.join(', ')}`);
    if (node.author) lines.push(`Author:   ${node.author}`);
    if (node.timestamp) lines.push(`Time:     ${node.timestamp}`);
    if (node.edges?.length) {
      lines.push(`Related:  ${node.edges.map(e => `${e.target} (${e.label || ''})`).join(', ')}`);
    }
    return text(lines.join('\n'));
  }
);

// ─── Tool: memory_list ──────────────────────────────────────────────────────
server.tool(
  'memory_list',
  'List memories, optionally filtered by type or tag. Use for browsing when you ' +
    'do not have a specific query (e.g. "what memories do you have?").',
  {
    type: z.enum(['knowledge', 'conversation']).optional().describe('Restrict to one article type.'),
    tag: z.string().optional().describe('Only memories whose data-tags contain this tag.'),
    limit: z.number().optional().describe('Max results (default 20).'),
  },
  async ({ type, tag, limit }) => {
    const cap = limit || 20;
    const out = [];
    for (const [id, node] of engine._articles) {
      if (node.supersededBy) continue;
      if (type && (node.type || 'knowledge') !== type) continue;
      if (tag && !(node.tags || []).includes(tag)) continue;
      out.push({ id, type: node.type || 'knowledge', summary: node.summary, tags: (node.tags || []).slice(0, 5) });
      if (out.length >= cap) break;
    }
    if (out.length === 0) {
      return text(`No memories match the filter. Try memory_list with no args to see all, or memory_store to add one.`);
    }
    return text(
      `${out.length} memor${out.length === 1 ? 'y' : 'ies'}:\n\n` +
      out.map((m, i) => `${i + 1}. [${m.type}] id=${m.id}  tags=[${m.tags.join(', ')}]\n   ${m.summary}`).join('\n\n')
    );
  }
);

// ─── Tool: memory_store ─────────────────────────────────────────────────────
server.tool(
  'memory_store',
  'Store a new memory. Use type="knowledge" for compiled facts (configs, decisions, ' +
    'lessons learned) or type="conversation" for raw chat history. Triggers describe ' +
    'future scenarios where this memory should resurface; if omitted they are auto-generated.',
  {
    summary: z.string().describe('One-line summary. This is what shows up in memory_recall results.'),
    detail: z.string().optional().describe('Full content for knowledge type.'),
    conversation: z.string().optional().describe('Full conversation text for conversation type.'),
    triggers: z.array(z.string()).optional().describe('Future scenarios that should resurface this memory.'),
    type: z.enum(['knowledge', 'conversation']).optional().describe('Article type (default: knowledge).'),
    author: z.string().optional().describe('Who/what wrote this (e.g. "claude-code", "user").'),
  },
  async (args) => {
    const result = await engine.add({
      summary: args.summary,
      detail: args.detail || '',
      conversation: args.conversation || '',
      triggers: args.triggers || [],
      type: args.type || 'knowledge',
      author: args.author || 'mcp',
    });
    // add() defers disk writes (_maybeFlush). MCP callers expect memory_recall /
    // memory_grep to see what was just stored on the next call, so force a flush.
    // Without this, ripgrep reads stale HTML until the deferred-flush timer fires.
    await engine._flush();
    if (result.duplicate) {
      return text(`Already exists (duplicate of id=${result.id}). Not modified.`);
    }
    return text(
      `Stored as id=${result.id}.` +
      (result.proposedLinks.length ? ` Linked to: ${result.proposedLinks.join(', ')}.` : '')
    );
  }
);

function text(content) {
  return { content: [{ type: 'text', text: content }] };
}

// ─── Tool: memory_grep ──────────────────────────────────────────────────────
// Low-level grep over the memory file. The agent owns the retrieval loop:
// it picks the pattern, looks at matches, decides whether to refine or to
// read a specific hit. This is the agent-as-retriever pattern in pure form,
// mirroring Claude Code's Grep tool.
server.tool(
  'memory_grep',
  'Raw regex grep over all memories. Returns line-level matches with their article ' +
    'IDs. Use when memory_recall misses something or you want to drive the search ' +
    'yourself with a precise pattern (e.g. an IP, an error code, a function name). ' +
    'After grep, use memory_read on any hit ID to see the full content.',
  {
    pattern: z.string().describe('Regex pattern (PCRE-ish, case-insensitive).'),
    typeFilter: z.enum(['knowledge', 'conversation']).optional()
      .describe('Restrict to one article type. Omit to search both.'),
    contextLines: z.number().optional()
      .describe('Lines of context around each match (default 0, max 3).'),
    limit: z.number().optional().describe('Max matches (default 20).'),
  },
  async ({ pattern, typeFilter, contextLines, limit }) => {
    const cap = limit || 20;
    const ctxLines = Math.min(contextLines || 0, 3);
    const matches = grepMemoryFile({ pattern, typeFilter, contextLines: ctxLines, limit: cap, articles: engine._articles });
    if (matches.length === 0) {
      return text(`No lines matched /${pattern}/.`);
    }
    const lines = matches.map((m, i) => {
      const ctxBefore = m.contextBefore ? m.contextBefore.map(l => `    ${l}`).join('\n') + '\n' : '';
      const ctxAfter = m.contextAfter ? '\n' + m.contextAfter.map(l => `    ${l}`).join('\n') : '';
      return `${i + 1}. id=${m.id} line ${m.line}:\n${ctxBefore}  > ${m.text}${ctxAfter}`;
    });
    return text(
      `${matches.length} match(es) for /${pattern}/:\n\n${lines.join('\n\n')}\n\n` +
      `Use memory_read with an id to load the full article.`
    );
  }
);

/**
 * Run ripgrep over the memory HTML file, return matches scoped to one article
 * each. Mirrors the engine's internal grep but exposes raw line-level output
 * to the agent instead of pre-scored results.
 *
 * Two safety/perf details:
 *  - rg args are passed as an argv array, not a shell-joined string. This is
 *    safe on Windows paths with spaces, parentheses, or non-ASCII.
 *  - The HTML file is read once per call (cached by mtime on the engine side
 *    is overkill here; ripgrep already streams). Line-ranges are derived from
 *    the read result rather than re-parsing the file.
 *  - Noisy lines (the <article> opening tag, the INDEX comment block) are
 *    filtered out. They contain data-tags that the agent didn't ask for and
 *    just clutter grep output.
 */
function grepMemoryFile({ pattern, typeFilter, contextLines, limit, articles }) {
  // Filter articles by type up front to shrink the search space.
  const candidateIds = new Set();
  for (const [id, node] of articles) {
    if (node.supersededBy) continue;
    if (typeFilter && (node.type || 'knowledge') !== typeFilter) continue;
    candidateIds.add(id);
  }
  if (candidateIds.size === 0) return [];

  const htmlPath = engine.htmlPath;
  if (!existsSync(htmlPath)) return [];

  let raw;
  try {
    // Pass argv directly to execFileSync so paths/patterns with special chars
    // are forwarded to rg untouched. We let rg handle the regex compilation
    // (-e pattern); the path goes verbatim.
    raw = execFileSync('rg', [
      '-n', '--no-heading', '-i',
      '--max-count', String(limit * 5),
      '-e', pattern,
      htmlPath,
    ], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status === 1) return [];  // rg returns 1 on no matches
    throw e;
  }

  const { lines: htmlLines, ranges: articleRanges } = getCachedHtml(htmlPath);

  const results = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\d+):(.*)$/);
    if (!m) continue;
    const lineNum = parseInt(m[1]);
    const text = m[2];
    // Skip noisy lines: the article opening tag (data-tags line) and the
    // INDEX comment block. The agent asked for content, not metadata.
    if (isNoiseLine(text)) continue;
    const id = findArticleForLine(lineNum, articleRanges);
    if (!id || !candidateIds.has(id)) continue;
    if (seen.has(`${id}:${lineNum}`)) continue;
    seen.add(`${id}:${lineNum}`);

    const range = articleRanges.get(id);
    const ctxBefore = [];
    const ctxAfter = [];
    for (let i = 1; i <= contextLines; i++) {
      const before = htmlLines[lineNum - i - 1];
      if (before !== undefined && lineNum - i >= range.start && !isNoiseLine(before)) {
        ctxBefore.unshift(before);
      }
      const after = htmlLines[lineNum + i - 1];
      if (after !== undefined && lineNum + i <= range.end && !isNoiseLine(after)) {
        ctxAfter.push(after);
      }
    }

    results.push({ id, line: lineNum, text, contextBefore: ctxBefore, contextAfter: ctxAfter });
    if (results.length >= limit) break;
  }
  return results;
}

// Lines we strip from grep output and from context windows.
// - <article ...> open tag (carries data-tags noise the agent didn't ask for)
// - <!-- INDEX ... --> and its rows (just an internal id lookup table)
// - </article> close tag
// - HTML head/style/title boilerplate
const NOISE_PREFIXES = [
  '<article ',
  '</article>',
  '<!-- INDEX',
  '<!-- ',
  '<!DOCTYPE',
  '<html',
  '<head>',
  '<meta ',
  '<title>',
  '<style>',
  '</style>',
  '</head>',
  '<body>',
  '</body>',
  '</html>',
  '<h1>',
];
function isNoiseLine(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // INDEX data rows look like "  abc123|0.53|3|2026-06-11|agent-1"
  if (/^\s*[a-f0-9-]+\|[\d.]+\|\d+\|/.test(trimmed)) return true;
  for (const p of NOISE_PREFIXES) {
    if (trimmed.startsWith(p)) return true;
  }
  return false;
}

// ─── mtime-keyed HTML cache ────────────────────────────────────────────────
// Avoid re-reading + re-parsing the file on every grep. Keyed by mtimeMs so
// any external write (engine.flush, manual edit) invalidates automatically.
const _htmlCache = new Map();  // path → { mtime, lines, ranges }
function getCachedHtml(htmlPath) {
  const stat = statSync(htmlPath);
  const cached = _htmlCache.get(htmlPath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached;
  }
  const lines = readFileSync(htmlPath, 'utf8').split('\n');
  const ranges = buildArticleLineRanges(lines);
  const entry = { mtime: stat.mtimeMs, lines, ranges };
  _htmlCache.set(htmlPath, entry);
  return entry;
}

function buildArticleLineRanges(htmlLines) {
  const ranges = new Map();
  let currentId = null;
  let start = 0;
  for (let i = 0; i < htmlLines.length; i++) {
    const open = htmlLines[i].match(/<article\s+[^>]*id="([^"]+)"/);
    if (open) {
      currentId = open[1];
      start = i + 1;  // rg is 1-indexed
    }
    if (currentId && htmlLines[i].includes('</article>')) {
      ranges.set(currentId, { start, end: i + 1 });
      currentId = null;
    }
  }
  return ranges;
}

function findArticleForLine(lineNum, ranges) {
  for (const [id, range] of ranges) {
    if (lineNum >= range.start && lineNum <= range.end) return id;
  }
  return null;
}

// ─── Tool: memory_find_symbol ───────────────────────────────────────────────
// Lightweight structural search for code-bearing memories. Recognizes common
// definition shapes (function, class, method, constant) without pulling in a
// full tree-sitter grammar stack. Falls back to plain grep when the language
// or shape is unknown.
//
// Use when memory_grep would miss a definition because the agent only knows
// the name (e.g. "refundPayment") but not the surrounding text.
server.tool(
  'memory_find_symbol',
  'Find a symbol definition across memories. Looks for function/class/method/const ' +
    'definitions matching the name. Lighter than full AST parsing but covers common ' +
    'shapes in JS/TS/Python/Go/Rust/Java. Use when memory_grep misses because the ' +
    'agent knows a function name but not its surrounding context.',
  {
    name: z.string().describe('Symbol name to find (e.g. "processPayment", "UserService").'),
    kind: z.enum(['function', 'class', 'method', 'const', 'any']).optional()
      .describe('Restrict to one definition kind (default: any).'),
    lang: z.string().optional().describe('Hint language for tighter patterns (e.g. "python", "go").'),
  },
  async ({ name, kind, lang }) => {
    const patterns = buildSymbolPatterns(name, kind || 'any', lang || '');
    if (patterns.length === 0) {
      return text(`No patterns available for kind="${kind}" lang="${lang}".`);
    }
    const merged = patterns.map(p => `(?:${p})`).join('|');
    const matches = grepMemoryFile({
      pattern: merged,
      typeFilter: null,
      contextLines: 0,
      limit: 15,
      articles: engine._articles,
    });
    if (matches.length === 0) {
      return text(`No symbol "${name}" (kind=${kind || 'any'}) found.`);
    }
    const lines = matches.map((m, i) => `${i + 1}. id=${m.id} line ${m.line}:\n   ${stripTags(m.text).trim()}`);
    return text(
      `${matches.length} symbol match(es) for "${name}" (kind=${kind || 'any'}):\n\n${lines.join('\n\n')}\n\n` +
      `Use memory_read with an id to see the full context.`
    );
  }
);

/**
 * Build regex patterns for common definition shapes across languages.
 * Each pattern is anchored on the symbol name and tolerant of surrounding
 * whitespace / generic syntax. We deliberately avoid language-specific
 * tokenization to keep this dependency-free.
 */
function buildSymbolPatterns(name, kind, lang) {
  const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [];
  const want = (k) => kind === 'any' || kind === k;

  if (want('function')) {
    // JS/TS: function name( | const name = ( | const name = function | name: function
    patterns.push(`function\\s+${escName}\\s*\\(`);
    patterns.push(`(?:const|let|var)\\s+${escName}\\s*=\\s*(?:\\([^)]*\\)|function|async)`);
    patterns.push(`${escName}\\s*:\\s*(?:async\\s*)?function`);
    patterns.push(`${escName}\\s*\\([^)]*\\)\\s*\\{`);  // loose C-style
    // Python: def name(
    patterns.push(`def\\s+${escName}\\s*\\(`);
    // Go: func name(
    patterns.push(`func\\s+(?:\\([^)]*\\)\\s+)?${escName}\\s*\\(`);
    // Rust: fn name(
    patterns.push(`fn\\s+${escName}\\s*\\(`);
    // Java/Kotlin: visibility + name( + {
    patterns.push(`(?:public|private|protected|static)\\s+\\w+\\s+${escName}\\s*\\(`);
  }
  if (want('class')) {
    patterns.push(`class\\s+${escName}\\b`);
    patterns.push(`struct\\s+${escName}\\b`);
    patterns.push(`interface\\s+${escName}\\b`);
    patterns.push(`enum\\s+${escName}\\b`);
  }
  if (want('method')) {
    // Inside-class method definitions.
    patterns.push(`(?:pub\\s+)?fn\\s+${escName}\\s*\\(`);
    patterns.push(`def\\s+${escName}\\s*\\(`);
    patterns.push(`${escName}\\s*\\([^)]*\\)\\s*\\{`);  // JS/Java methods
  }
  if (want('const')) {
    patterns.push(`(?:const|let|var|static|final|export\\s+const)\\s+${escName}\\b`);
    patterns.push(`(?:^[\\s]*)${escName}\\s*=`);  // python module-level
  }
  return patterns;
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '');
}

// ─── Boot ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
// Process stays alive serving stdio until the host disconnects.
