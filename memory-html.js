/**
 * MemoryEngineV2 — HTML-native memory with grep-based retrieval.
 *
 * Storage: single memory.html file per namespace.
 * Retrieval: ripgrep multi-strategy search.
 * No embedding model, no vector index.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { serializeHtml, parseHtml, articleToHtml } from './html-template.js';
import { searchAndScore, extractTags, extractQueryTerms } from './grep.js';
import { SynonymLearner } from './learner.js';

// Wire learner into grep module via global
globalThis.__SYNONYM_LEARNER = null;

const DEFAULT_CONFIG = {
  decayRate: 0.005,
  triggerHitWindow: 90,
  dedupThreshold: 0.85,
  autoLinkThreshold: 0.5,
  lockTimeoutMs: 5000,
  matchThreshold: 0.20,
};

export class MemoryEngine {
  constructor({ basePath }) {
    this.basePath = basePath;
    this.htmlPath = join(basePath, 'memory.html');
    this.bakPath = join(basePath, 'memory.html.bak');
    this.config = { ...DEFAULT_CONFIG };
    this._articles = new Map();
    this._dirty = false;
    this._accessBuffer = []; // batched access updates
    this._lastFlush = Date.now();
  }

  async init() {
    if (!existsSync(this.basePath)) mkdirSync(this.basePath, { recursive: true });

    if (existsSync(this.htmlPath)) {
      const html = readFileSync(this.htmlPath, 'utf8');
      this._articles = parseHtml(html);
    } else {
      // Seed an empty HTML file so consumers (and tests) can rely on it
      // existing immediately after init, even before any write.
      writeFileSync(this.htmlPath, serializeHtml(this._articles), 'utf8');
    }

    // Init fail-improve learner
    this._learner = new SynonymLearner({ basePath: this.basePath });
    globalThis.__SYNONYM_LEARNER = this._learner;

    return this;
  }

  // ─── Read operations ─────────────────────────────────────────────────────

  async land(query, spreadDepth = 1, typeFilter = null) {
    const results = searchAndScore(query, this.htmlPath, this._articles);

    // Filter by threshold
    let filtered = results.filter(r => r.match >= this.config.matchThreshold);

    // Filter by type if specified
    if (typeFilter) {
      filtered = filtered.filter(r => {
        const node = this._articles.get(r.id);
        return node && (node.type || 'knowledge') === typeFilter;
      });
    }

    // Record for fail-improve loop — only meaningful terms
    if (this._learner && filtered.length > 0) {
      // English identifiers ≥3 chars
      const enTerms = (query.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || []);
      // Whole-query Chinese substrings 2-4 chars (only if user typed it as a chunk)
      const cnWhole = (query.match(/[一-鿿]{2,4}/g) || []);
      const queryTerms = [...new Set([...enTerms, ...cnWhole])];
      const matchedArticles = filtered.slice(0, 3).map(r => this._articles.get(r.id)).filter(Boolean);
      this._learner.recordQuery({ queryTerms, matchedArticles });
    }

    // Update access stats
    for (const r of filtered.slice(0, 5)) {
      const node = this._articles.get(r.id);
      if (node) {
        node.accessCount = (node.accessCount || 0) + 1;
        node.lastAccess = new Date().toISOString().slice(0, 10);
      }
    }
    this._dirty = true;
    this._maybeFlush();

    // Spread
    if (spreadDepth > 0 && filtered.length > 0) {
      const spreadResults = this._spread(filtered[0].id, spreadDepth, 0.3);
      for (const sr of spreadResults) {
        if (!filtered.find(f => f.id === sr.id)) {
          filtered.push({ ...sr, match: sr.energy || 0.3 });
        }
      }
    }

    return filtered;
  }

  async focus(nodeId) {
    const node = this._articles.get(nodeId);
    if (!node) return null;

    node.accessCount = (node.accessCount || 0) + 1;
    node.lastAccess = new Date().toISOString().slice(0, 10);
    this._dirty = true;

    return {
      id: nodeId,
      type: node.type || 'knowledge',
      summary: node.summary,
      detail: node.detail,
      conversation: node.conversation || null,
      triggers: node.triggers,
      triggerStats: node.triggers.map(() => ({ hits: 0, lastHit: null })),
      baseSalience: node.baseSalience,
      effectiveSalience: this._effectiveSalience(node),
      accessCount: node.accessCount,
      lastAccess: node.lastAccess,
      author: node.author,
      timestamp: node.timestamp || '',
      created: node.created || '',
      supersededBy: node.supersededBy || null,
      edges: node.edges || [],
    };
  }

  async spread(nodeId, depth = 2, energy = 1.0) {
    return this._spread(nodeId, depth, energy);
  }

  _spread(nodeId, depth, energy) {
    const visited = new Set([nodeId]);
    const results = [];
    const queue = [{ id: nodeId, energy }];

    while (queue.length > 0 && depth > 0) {
      const next = [];
      for (const { id, e } of queue) {
        const node = this._articles.get(id);
        if (!node?.edges) continue;
        for (const edge of node.edges) {
          if (visited.has(edge.target)) continue;
          const target = this._articles.get(edge.target);
          if (!target || target.supersededBy) continue;
          visited.add(edge.target);
          const newEnergy = e * (edge.strength || 0.5);
          if (newEnergy < 0.1) continue;
          results.push({
            id: edge.target,
            summary: target.summary,
            energy: parseFloat(newEnergy.toFixed(3)),
          });
          next.push({ id: edge.target, energy: newEnergy });
        }
      }
      queue.length = 0;
      queue.push(...next);
      depth--;
    }
    return results;
  }

  async beforeAction(query) {
    const results = await this.land(query, 0);
    if (results.length === 0) return null;
    return {
      related: results.slice(0, 3).map(r => ({
        id: r.id,
        summary: r.summary,
        match: r.match,
        salience: r.salience,
      })),
    };
  }

  // ─── Write operations ────────────────────────────────────────────────────

  async add({ summary, detail = '', triggers, author = '', type = 'knowledge', conversation = '', timestamp = '' }) {
    // Auto-generate triggers only when the caller didn't pass any. A caller
    // explicitly passing triggers: [] is signalling "no triggers" — we honor it.
    if (triggers === undefined || triggers === null) {
      const text = type === 'conversation' ? `${summary} ${conversation}` : `${summary} ${detail}`;
      triggers = this._autoTriggers(summary, text);
    }

    // Extract tags from the searchable text
    const tagSource = type === 'conversation' ? `${summary} ${conversation}` : `${summary} ${detail}`;
    const tags = extractTags(summary, tagSource);

    // Dedup check FIRST — if a node with the same SHA-256 prefix already
    // exists (i.e. same summary text), short-circuit before allocating a
    // -N suffix id. _generateId would otherwise mask the collision.
    const baseHash = createHash('sha256').update(summary).digest('hex').slice(0, 12);
    const existingByHash = this._articles.get(baseHash);
    if (existingByHash && !existingByHash.supersededBy) {
      return { id: baseHash, duplicate: true, proposedLinks: [] };
    }
    // Also catch near-duplicates via tag overlap.
    const dupByTags = this._checkDup(baseHash, summary, tags);
    if (dupByTags) return { id: dupByTags, duplicate: true, proposedLinks: [] };

    // Generate a unique ID (adds -N suffix only if hash collision happened
    // via a different summary, which is astronomically unlikely).
    const id = this._generateId(summary);

    // Auto-link
    const proposedLinks = this._autoLink(id, tags);

    // Create node
    const node = {
      type,
      summary,
      detail: type === 'knowledge' ? detail : '',
      conversation: type === 'conversation' ? conversation : null,
      triggers,
      tags,
      author,
      baseSalience: 0.5,
      accessCount: 0,
      lastAccess: new Date().toISOString().slice(0, 10),
      created: new Date().toISOString().slice(0, 10),
      timestamp: timestamp || (type === 'conversation' ? new Date().toISOString() : ''),
      supersededBy: null,
      edges: proposedLinks.map(t => ({ target: t, strength: 0.5, label: this._articles.get(t)?.summary?.slice(0, 30) || t })),
    };

    this._articles.set(id, node);
    this._dirty = true;
    // Defer the disk write. A full rewrite on every add() is wasteful when
    // callers batch writes (benchmarks ingest 50+ sessions), and on Windows
    // the rename-then-write sequence races with concurrent readers (ripgrep
    // in eval scripts), throwing EPERM. _maybeFlush only fires when the
    // access buffer crosses 10 entries or 60s elapsed. Callers that need
    // immediate durability can await engine._flush() explicitly.
    this._maybeFlush();

    return { id, duplicate: false, proposedLinks };
  }

  async addBatch(items) {
    const results = [];
    for (const item of items) {
      const r = await this.add(item);
      results.push(r);
    }
    return results;
  }

  async update(nodeId, fields) {
    const node = this._articles.get(nodeId);
    if (!node) return { id: nodeId, updated: false };

    if (fields.summary) node.summary = fields.summary;
    if (fields.detail !== undefined) node.detail = fields.detail;
    if (fields.author !== undefined) node.author = fields.author;

    if (fields.triggerAdd) {
      node.triggers = [...(node.triggers || []), fields.triggerAdd];
    }
    if (fields.triggerRemove !== undefined && Number.isInteger(fields.triggerRemove)) {
      node.triggers.splice(fields.triggerRemove, 1);
    }
    if (fields.triggerEdit) {
      const { index, text } = fields.triggerEdit;
      if (node.triggers[index]) node.triggers[index] = text;
    }

    // Re-extract tags
    node.tags = extractTags(node.summary, node.detail);

    this._dirty = true;
    await this._flush();
    return { id: nodeId, updated: true };
  }

  async remove(nodeId) {
    if (!this._articles.has(nodeId)) return { id: nodeId, removed: false };

    // Remove edges pointing to this node
    for (const [, node] of this._articles) {
      node.edges = (node.edges || []).filter(e => e.target !== nodeId);
    }

    this._articles.delete(nodeId);
    this._dirty = true;
    await this._flush();
    return { id: nodeId, removed: true };
  }

  async supersede(oldId, newId) {
    const oldNode = this._articles.get(oldId);
    const newNode = this._articles.get(newId);
    if (!oldNode || !newNode) return { oldId, newId, superseded: false };

    oldNode.supersededBy = newId;

    // Re-link edges
    for (const [, node] of this._articles) {
      for (const edge of (node.edges || [])) {
        if (edge.target === oldId) edge.target = newId;
      }
    }

    this._dirty = true;
    await this._flush();
    return { oldId, newId, superseded: true };
  }

  async link(source, target, strength = 0.5, reverseStrength) {
    const srcNode = this._articles.get(source);
    const tgtNode = this._articles.get(target);
    if (!srcNode || !tgtNode) return { source, target, strength: 0 };

    // Remove existing edge
    srcNode.edges = (srcNode.edges || []).filter(e => e.target !== target);

    // Add forward edge
    srcNode.edges.push({
      target,
      strength,
      label: tgtNode.summary?.slice(0, 30) || target,
    });

    this._dirty = true;
    await this._flush();
    return { source, target, strength };
  }

  auditTriggers(nodeId) {
    const results = [];
    const nodes = nodeId ? { [nodeId]: this._articles.get(nodeId) } : Object.fromEntries(this._articles);

    for (const [id, node] of Object.entries(nodes)) {
      if (!node?.triggers) continue;
      for (let i = 0; i < node.triggers.length; i++) {
        const hits = node.triggerStats?.[i]?.hits ?? 0;
        let status = 'ok';
        if (hits === 0) status = 'ineffective';
        results.push({ nodeId: id, triggerIndex: i, trigger: node.triggers[i], hits, lastHit: null, status });
      }
    }
    return results;
  }

  stats() {
    const nodes = [...this._articles.values()].filter(n => !n.supersededBy).length;
    let edges = 0;
    for (const node of this._articles.values()) edges += (node.edges || []).length;
    return { nodes, edges, config: this.config };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  _generateId(summary) {
    const hash = createHash('sha256').update(summary).digest('hex').slice(0, 12);
    let id = hash;
    let suffix = 2;
    while (this._articles.has(id)) {
      id = `${hash}-${suffix++}`;
    }
    return id;
  }

  _checkDup(id, summary, tags) {
    const newTagSet = new Set(tags.map(t => t.toLowerCase()));
    for (const [existingId, node] of this._articles) {
      if (node.supersededBy) continue;
      const existingTagSet = new Set((node.tags || []).map(t => t.toLowerCase()));
      const intersection = [...newTagSet].filter(t => existingTagSet.has(t)).length;
      const union = new Set([...newTagSet, ...existingTagSet]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard >= this.config.dedupThreshold) return existingId;
    }
    return null;
  }

  _autoLink(newId, tags) {
    const links = [];
    const newTagSet = new Set(tags.map(t => t.toLowerCase()));

    for (const [id, node] of this._articles) {
      if (id === newId || node.supersededBy) continue;
      const existingTagSet = new Set((node.tags || []).map(t => t.toLowerCase()));
      const intersection = [...newTagSet].filter(t => existingTagSet.has(t)).length;
      const union = new Set([...newTagSet, ...existingTagSet]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard >= this.config.autoLinkThreshold) {
        links.push(id);
        // Add reverse edge
        if (!node.edges) node.edges = [];
        node.edges.push({ target: newId, strength: 0.5, label: '' });
      }
    }
    return links;
  }

  _autoTriggers(summary, detail = '') {
    const text = `${summary} ${detail}`;
    const triggers = new Set();

    // First 30 chars of summary
    triggers.add(summary.slice(0, 30));

    // Chinese phrases (2-4 chars)
    const cnChars = text.replace(/[^一-鿿]/g, '');
    for (let i = 0; i < cnChars.length - 1; i++) {
      triggers.add(cnChars[i] + cnChars[i + 1]);
    }
    for (let i = 0; i < cnChars.length - 2; i++) {
      triggers.add(cnChars[i] + cnChars[i + 1] + cnChars[i + 2]);
    }

    // English technical terms
    const enTerms = text.match(/[a-zA-Z][a-zA-Z0-9_.\-]{2,}/g) || [];
    for (const t of enTerms) triggers.add(t);

    // IP patterns
    const ips = text.match(/\d+\.\d+\.\d+\.\d+(:\d+)?/g) || [];
    for (const ip of ips) triggers.add(ip);

    return [...triggers].slice(0, 5);
  }

  _effectiveSalience(node) {
    const base = node.baseSalience ?? 0.5;
    const boost = Math.min((node.accessCount ?? 0) * 0.03, 0.3);
    const days = node.lastAccess
      ? (Date.now() - new Date(node.lastAccess).getTime()) / 86400000
      : 0;
    return Math.max(0.1, Math.min(1.0, base + boost - days * this.config.decayRate));
  }

  _maybeFlush() {
    const now = Date.now();
    if (this._dirty && (this._accessBuffer.length >= 10 || now - this._lastFlush > 60000)) {
      this._flush();
    }
  }

  async _flush() {
    if (!this._dirty) return;

    // Backup
    if (existsSync(this.htmlPath)) {
      renameSync(this.htmlPath, this.bakPath);
    }

    // Serialize
    const html = serializeHtml(this._articles);
    writeFileSync(this.htmlPath, html, 'utf8');
    this._dirty = false;
    this._lastFlush = Date.now();
    this._accessBuffer = [];

    // Flush learner
    if (this._learner) this._learner.flush();
  }
}
