/**
 * HTML template for memory storage.
 * Memory = <article> element. Full store = single HTML file.
 */

const HTML_HEAD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Grepmem</title>
<meta name="generator" content="grepmem/2.0">
<style>
body { font-family: system-ui, sans-serif; max-width: 80ch; margin: 2rem auto; padding: 0 1rem; background: #fafafa; }
article { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.2rem; margin: 1rem 0; background: #fff; }
article[data-type="conversation"] { border-left: 3px solid #1a7f37; background: #f6fff6; }
article[data-type="knowledge"] { border-left: 3px solid #0969da; }
h2 { margin: 0 0 0.5rem; font-size: 1.1rem; color: #333; }
.detail { white-space: pre-wrap; color: #444; margin: 0.5rem 0; }
.conversation-body { white-space: pre-wrap; color: #444; margin: 0.5rem 0; }
.triggers { list-style: none; padding: 0; margin: 0.3rem 0; }
.triggers li { display: inline-block; background: #e8f0fe; color: #1a73e8; padding: 2px 8px; border-radius: 4px; margin: 2px; font-size: 0.85rem; }
.edges { margin: 0.5rem 0 0; font-size: 0.9rem; }
.edges a { color: #666; text-decoration: none; margin-right: 0.5rem; }
.meta { font-size: 0.8rem; color: #999; margin-top: 0.5rem; }
article[data-superseded-by] { opacity: 0.35; text-decoration: line-through; }
.type-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.75rem; margin-left: 0.5rem; vertical-align: middle; }
.type-knowledge { background: #0969da; color: #fff; }
.type-conversation { background: #1a7f37; color: #fff; }
</style>
</head>
<body>
<h1>Grepmem</h1>
`;

const HTML_FOOT = `</body>
</html>
`;

export function articleToHtml(id, node) {
  const type = node.type || 'knowledge';
  const attrs = [
    `id="${id}"`,
    `data-type="${type}"`,
    node.tags?.length ? `data-tags="${esc(node.tags.join(','))}"` : '',
    node.author ? `data-author="${esc(node.author)}"` : '',
    `data-salience="${node.baseSalience ?? 0.5}"`,
    `data-access-count="${node.accessCount ?? 0}"`,
    `data-last-access="${node.lastAccess ?? new Date().toISOString().slice(0, 10)}"`,
    node.created ? `data-created="${node.created}"` : '',
    node.timestamp ? `data-timestamp="${node.timestamp}"` : '',
    node.supersededBy ? `data-superseded-by="${esc(node.supersededBy)}"` : '',
  ].filter(Boolean).join(' ');

  const typeBadge = type === 'conversation'
    ? '<span class="type-badge type-conversation">conversation</span>'
    : '<span class="type-badge type-knowledge">knowledge</span>';

  let html = `<article ${attrs}>\n`;
  html += `  <h2>${esc(node.summary)} ${typeBadge}</h2>\n`;
  // Conversation type stores full body in conversation-body class
  if (type === 'conversation' && node.conversation) {
    html += `  <div class="conversation-body">${esc(node.conversation)}</div>\n`;
  } else if (node.detail) {
    html += `  <p class="detail">${esc(node.detail)}</p>\n`;
  }
  if (node.triggers?.length) {
    html += `  <ul class="triggers">\n`;
    for (const t of node.triggers) html += `    <li>${esc(t)}</li>\n`;
    html += `  </ul>\n`;
  }
  if (node.edges?.length) {
    html += `  <nav class="edges">`;
    for (const e of node.edges) {
      const strength = e.strength !== undefined ? ` data-strength="${e.strength}"` : '';
      html += `<a href="#${e.target}"${strength}>${esc(e.label || e.target)}</a> `;
    }
    html += `</nav>\n`;
  }
  html += `  <footer class="meta">`;
  html += `ID: ${id}`;
  if (node.author) html += ` | Author: ${esc(node.author)}`;
  if (node.timestamp) html += ` | Time: ${node.timestamp}`;
  html += `</footer>\n`;
  html += `</article>`;
  return html;
}

export function serializeHtml(articles) {
  let html = HTML_HEAD;

  // Index block
  html += `<!-- INDEX\n`;
  html += `id|salience|accessCount|lastAccess|author\n`;
  for (const [id, node] of articles) {
    const sal = effectiveSalience(node).toFixed(2);
    html += `${id}|${sal}|${node.accessCount ?? 0}|${node.lastAccess || ''}|${node.author || ''}\n`;
  }
  html += `-->\n\n`;

  // Articles
  for (const [id, node] of articles) {
    html += articleToHtml(id, node) + '\n\n';
  }

  html += HTML_FOOT;
  return html;
}

export function parseHtml(html) {
  const articles = new Map();

  // Extract article blocks
  const articleRegex = /<article\s+([\s\S]*?)>([\s\S]*?)<\/article>/g;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];

    const id = attrVal(attrs, 'id');
    if (!id) continue;

    const type = attrVal(attrs, 'data-type') || 'knowledge';
    const summary = extractTag(body, 'h2');
    // Strip the type badge span from summary if present
    const cleanSummary = summary.replace(/<span class="type-badge[^"]*"[^>]*>[^<]*<\/span>/, '').trim();

    const node = {
      type,
      summary: cleanSummary,
      detail: extractClass(body, 'detail'),
      conversation: type === 'conversation' ? extractDivClass(body, 'conversation-body') : null,
      triggers: extractList(body),
      tags: (attrVal(attrs, 'data-tags') || '').split(',').filter(Boolean),
      author: attrVal(attrs, 'data-author') || '',
      baseSalience: parseFloat(attrVal(attrs, 'data-salience')) || 0.5,
      accessCount: parseInt(attrVal(attrs, 'data-access-count')) || 0,
      lastAccess: attrVal(attrs, 'data-last-access') || '',
      created: attrVal(attrs, 'data-created') || '',
      timestamp: attrVal(attrs, 'data-timestamp') || '',
      supersededBy: attrVal(attrs, 'data-superseded-by') || null,
      edges: extractEdges(body),
    };

    articles.set(id, node);
  }

  return articles;
}

function effectiveSalience(node) {
  const base = node.baseSalience ?? 0.5;
  const boost = Math.min((node.accessCount ?? 0) * 0.03, 0.3);
  const days = node.lastAccess
    ? (Date.now() - new Date(node.lastAccess).getTime()) / 86400000
    : 0;
  const decay = days * 0.005;
  return Math.max(0.1, Math.min(1.0, base + boost - decay));
}

function attrVal(attrs, name) {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = attrs.match(re);
  return m ? m[1] : null;
}

function extractTag(body, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = body.match(re);
  return m ? unesc(m[1].trim()) : '';
}

function extractClass(body, cls) {
  const re = new RegExp(`<p class="${cls}">([\\s\\S]*?)<\\/p>`, 'i');
  const m = body.match(re);
  return m ? unesc(m[1].trim()) : '';
}

function extractDivClass(body, cls) {
  const re = new RegExp(`<div class="${cls}">([\\s\\S]*?)<\\/div>`, 'i');
  const m = body.match(re);
  return m ? unesc(m[1].trim()) : '';
}

function extractList(body) {
  const re = /<ul class="triggers">([\s\S]*?)<\/ul>/i;
  const m = body.match(re);
  if (!m) return [];
  const items = [];
  const liRe = /<li>(.*?)<\/li>/g;
  let li;
  while ((li = liRe.exec(m[1])) !== null) items.push(unesc(li[1].trim()));
  return items;
}

function extractEdges(body) {
  const re = /<nav class="edges">([\s\S]*?)<\/nav>/i;
  const m = body.match(re);
  if (!m) return [];
  const edges = [];
  const aRe = /href="#([^"]+)"([^>]*)>(.*?)<\/a>/g;
  let a;
  while ((a = aRe.exec(m[1])) !== null) {
    const target = a[1];
    const attrs = a[2] || '';
    const label = unesc(a[3]);
    const strengthMatch = attrs.match(/data-strength="([^"]*)"/);
    const strength = strengthMatch ? parseFloat(strengthMatch[1]) : undefined;
    const edge = { target, label };
    if (strength !== undefined) edge.strength = strength;
    edges.push(edge);
  }
  return edges;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
