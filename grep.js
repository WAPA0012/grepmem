/**
 * Grep-based retrieval layer for HTML memory store.
 * Uses ripgrep (rg) for multi-strategy search with weighted scoring.
 */
import { execSync, execFileSync } from 'child_process';
import { readFileSync } from 'fs';

// ─── Synonym map ─────────────────────────────────────────────────────────────
const SYNONYMS = {
  '缓存': ['Redis', 'redis'],
  '连不上': ['SSH', '连接', '超时', '端口'],
  '报错': ['error', '异常', '失败'],
  '挂了': ['崩溃', 'crash', 'down', '失败'],
  '卡': ['慢', '性能', '优化'],
  '打包': ['webpack', 'build', 'tree-shaking', 'vite'],
  'token': ['JWT', 'jwt'],
  '密码': ['password', 'bcrypt', '加密'],
  '数据库': ['MySQL', 'PostgreSQL', 'MongoDB', 'SQL'],
  '前端': ['React', 'Vue', 'CSS', 'DOM'],
  '部署': ['deploy', 'PM2', 'Docker', '发布'],
  '容器': ['Docker', 'docker'],
  '内存': ['OOM', 'heap', '泄漏'],
  '安全': ['XSS', 'SQL注入', 'CSRF', 'CORS'],
  '跨域': ['CORS'],
  '慢': ['性能', '优化', '索引'],
  '泄漏': ['内存', 'websocket', 'OOM'],
  '炸了': ['崩溃', 'crash', 'error', '报错'],
  '配置': ['config', '环境变量', '.env'],
  '合成': ['rebase', 'squash', 'merge'],
  '刷': ['速率限制', '限流', 'rate limit'],
  '合': ['merge', 'rebase', '冲突'],
  '接口': ['API', '速率限制', '限流'],
};

// ─── Query term extraction ───────────────────────────────────────────────────
export function extractQueryTerms(query) {
  const terms = [];

  // Whole query for exact match
  terms.push({ pattern: query, weight: 3.0, type: 'exact' });

  // English words/identifiers
  const enWords = query.match(/[a-zA-Z][a-zA-Z0-9_.\-]+/g) || [];
  for (const w of enWords) {
    terms.push({ pattern: w, weight: 2.0, type: 'en_word' });
    terms.push({ pattern: w, weight: 1.5, type: 'en_ci', ci: true });
  }

  // Chinese bigrams
  const cnChars = query.replace(/[^一-鿿]/g, '');
  if (cnChars.length >= 2) {
    for (let i = 0; i < cnChars.length - 1; i++) {
      terms.push({ pattern: cnChars[i] + cnChars[i + 1], weight: 1.5, type: 'bigram' });
    }
  }
  // Chinese trigrams for longer phrases
  if (cnChars.length >= 3) {
    for (let i = 0; i < cnChars.length - 2; i++) {
      terms.push({ pattern: cnChars[i] + cnChars[i + 1] + cnChars[i + 2], weight: 2.0, type: 'trigram' });
    }
  }

  // IP patterns
  const ips = query.match(/\d+\.\d+\.\d+\.\d+/g) || [];
  for (const ip of ips) terms.push({ pattern: ip, weight: 3.0, type: 'ip' });

  // Number patterns (ports, versions)
  const nums = query.match(/\d{2,}/g) || [];
  for (const n of nums) terms.push({ pattern: n, weight: 1.5, type: 'number' });

  // Synonym expansion
  for (const [key, expansions] of Object.entries(SYNONYMS)) {
    if (query.includes(key)) {
      for (const exp of expansions) {
        terms.push({ pattern: exp, weight: 1.5, type: 'synonym' });
      }
    }
  }

  // Learned synonyms (from fail-improve loop)
  if (globalThis.__SYNONYM_LEARNER) {
    for (const term of [...enWords, ...extractChineseTerms(query)]) {
      const learned = globalThis.__SYNONYM_LEARNER.getLearned(term);
      for (const exp of learned) {
        terms.push({ pattern: exp, weight: 1.8, type: 'learned' });
      }
    }
  }

  return terms;
}

function extractChineseTerms(query) {
  const terms = new Set();
  const cnChars = query.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cnChars.length - 1; i++) {
    terms.add(cnChars[i] + cnChars[i + 1]);
  }
  return [...terms];
}

// ─── Grep execution ──────────────────────────────────────────────────────────
export function grepSearch(pattern, filePath, options = {}) {
  const args = ['-n', '--no-heading'];
  if (options.ci) args.push('-i');

  // Escape regex metacharacters so the query is treated as literal text.
  // This is what the engine wants: query terms are user-typed keywords, not
  // regexes. Without escaping, a query like "redis.*" would silently match
  // far more than the user intended.
  const safePattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // If the original pattern ends with a backslash, the escape above turns
  // it into \\, which is valid. But if a query somehow ends with an odd
  // number of backslashes after escaping (extremely rare), rg will reject
  // it as an incomplete escape. In that case, drop the trailing backslash.
  let finalPattern = safePattern;
  if (/(?:^|[^\\])\\$/.test(finalPattern) || /\\\\+$/.test(finalPattern)) {
    // Strip trailing backslashes that would form an incomplete escape.
    finalPattern = finalPattern.replace(/\\+$/, '');
  }

  // Skip pathological patterns (very long queries would OOM the regex
  // engine). 4KB is a generous cap; nothing useful lives past it.
  if (finalPattern.length > 4096) {
    finalPattern = finalPattern.slice(0, 4096);
  }

  // Pass argv directly to execFileSync — bypasses shell quoting entirely,
  // so paths and patterns with quotes/spaces/Unicode all flow through
  // verbatim.
  try {
    const result = execFileSync('rg', [
      ...args,
      finalPattern,
      filePath,
    ], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseGrepLines(result);
  } catch (e) {
    // rg exit 1 = no matches
    if (e.status === 1) return [];
    // rg exit 2 = regex parse error or other usage error. Treat as no match
    // rather than crashing the engine — the caller passed something rg
    // couldn't compile, but the engine shouldn't take down the process.
    if (e.status === 2) return [];
    throw e;
    throw e;
  }
}

function parseGrepLines(output) {
  const lines = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(\d+):(.*)$/);
    if (m) lines.push({ lineNum: parseInt(m[1]), text: m[2] });
  }
  return lines;
}

// ─── Multi-pass search + scoring ─────────────────────────────────────────────
export function searchAndScore(query, htmlPath, articles) {
  const terms = extractQueryTerms(query);
  if (terms.length === 0) return [];

  // Build line-ranges for each article (for field-level scoring)
  const articleLines = buildArticleLineMap(articles, htmlPath);

  // Run grep for each term, collect hits per article
  const scores = new Map(); // articleId -> { score, matchedTerms }

  for (const term of terms) {
    const hits = grepSearch(term.pattern, htmlPath, { ci: term.ci });
    for (const hit of hits) {
      const articleId = findArticleForLine(hit.lineNum, articleLines);
      if (!articleId) continue;

      if (!scores.has(articleId)) scores.set(articleId, { score: 0, matchedTerms: new Set() });

      const s = scores.get(articleId);
      const fieldWeight = getFieldWeight(hit.lineNum, articleLines.get(articleId));
      const termScore = term.weight * fieldWeight;
      s.score += termScore;
      s.matchedTerms.add(term.pattern);
    }
  }

  // Also search within in-memory article text for terms that rg might miss
  for (const [id, node] of articles) {
    if (node.supersededBy) continue;
    const text = `${node.summary} ${node.detail || ''} ${node.conversation || ''} ${(node.triggers || []).join(' ')} ${(node.tags || []).join(' ')}`.toLowerCase();
    let memScore = 0;
    for (const term of terms) {
      if (text.includes(term.pattern.toLowerCase())) {
        if (!scores.has(id)) scores.set(id, { score: 0, matchedTerms: new Set() });
        memScore += term.weight;
        scores.get(id).matchedTerms.add(term.pattern);
      }
    }
    if (memScore > 0 && scores.has(id)) {
      scores.get(id).score += memScore * 0.5; // lower weight for in-memory match (already scored by grep)
    } else if (memScore > 0) {
      scores.set(id, { score: memScore, matchedTerms: new Set(terms.filter(t => text.includes(t.pattern.toLowerCase())).map(t => t.pattern)) });
    }
  }

  // Compute final scores with salience
  const results = [];
  for (const [id, s] of scores) {
    const node = articles.get(id);
    if (!node || node.supersededBy) continue;
    if (s.matchedTerms.size < 1) continue;

    const sal = effectiveSalience(node);
    const maxPossibleScore = terms.reduce((sum, t) => sum + t.weight * 3.0, 0); // rough normalization
    const matchScore = Math.min(s.score / Math.max(maxPossibleScore * 0.3, 1), 1.0);

    results.push({
      id,
      type: node.type || 'knowledge',
      summary: node.summary,
      detail: node.detail,
      conversation: node.conversation,
      timestamp: node.timestamp,
      match: parseFloat(matchScore.toFixed(3)),
      salience: parseFloat(sal.toFixed(3)),
      _rawScore: s.score,
      _matchedTerms: s.matchedTerms.size,
    });
  }

  // Sort by match * salience descending
  results.sort((a, b) => (b.match * b.salience) - (a.match * a.salience));
  return results;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildArticleLineMap(articles, htmlPath) {
  // Read file and map article IDs to line ranges
  let html;
  try {
    html = readFileSync(htmlPath, 'utf8');
  } catch { return new Map(); }

  const lines = html.split('\n');
  const map = new Map();
  let currentId = null;
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const articleMatch = lines[i].match(/<article\s+[^>]*id="([^"]+)"/);
    if (articleMatch) {
      currentId = articleMatch[1];
      startLine = i + 1; // rg is 1-indexed
    }
    if (currentId && lines[i].includes('</article>')) {
      map.set(currentId, { start: startLine, end: i + 1 });
      currentId = null;
    }
  }
  return map;
}

function findArticleForLine(lineNum, articleLines) {
  for (const [id, range] of articleLines) {
    if (lineNum >= range.start && lineNum <= range.end) return id;
  }
  return null;
}

function getFieldWeight(lineNum, range) {
  if (!range) return 1.0;
  // This is approximate — we check the line content via the term match
  // Higher weight for trigger/tag lines, lower for generic text
  // Since we don't have the line content here, return a default
  return 1.0;
}

function effectiveSalience(node) {
  const base = node.baseSalience ?? 0.5;
  const boost = Math.min((node.accessCount ?? 0) * 0.03, 0.3);
  const days = node.lastAccess
    ? (Date.now() - new Date(node.lastAccess).getTime()) / 86400000
    : 0;
  return Math.max(0.1, Math.min(1.0, base + boost - days * 0.005));
}

// ─── Tag extraction (for write-time) ─────────────────────────────────────────
export function extractTags(summary, detail = '') {
  const text = `${summary} ${detail}`;
  const tags = new Set();

  // English words/identifiers
  const enWords = text.match(/[a-zA-Z][a-zA-Z0-9_.\-]{2,}/g) || [];
  for (const w of enWords) tags.add(w.toLowerCase());

  // Chinese bigrams
  const cnChars = text.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cnChars.length - 1; i++) {
    tags.add(cnChars[i] + cnChars[i + 1]);
  }

  // IP:port patterns
  const ips = text.match(/\d+\.\d+\.\d+\.\d+(:\d+)?/g) || [];
  for (const ip of ips) tags.add(ip);

  // Filter common stopwords
  const stopwords = new Set(['the', 'and', 'for', 'not', 'but', 'are', 'was', 'has', 'this', 'that', 'with', 'from', 'can', 'all', 'use', 'need']);
  for (const sw of stopwords) tags.delete(sw);

  return [...tags].slice(0, 20);
}
