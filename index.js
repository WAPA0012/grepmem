/**
 * MemoryIndex — JSON cache layer on top of memory.html.
 *
 * Design rules (see DESIGN.md §4 for context):
 *   1. memory.html is the source of truth. The index is a derived cache.
 *   2. The index can be deleted at any time; the engine falls back to grep.
 *   3. Write path is atomic: _flush() updates HTML then index in one go.
 *   4. Index is detected stale by mtime + content hash; rebuild on demand.
 *
 * Schema versioned. Breaking changes bump schema_version and trigger rebuild.
 *
 * Index files live next to the HTML:
 *   namespaces/default/memory.html
 *   namespaces/default/memory.index.json
 */
import { existsSync, readFileSync, writeFileSync, statSync, renameSync } from 'fs';
import { createHash } from 'crypto';

const SCHEMA_VERSION = 1;
const INDEX_FILENAME = 'memory.index.json';

// Tokenizers must stay in sync with grep.js:extractQueryTerms.
// Lowercase everything — index is case-insensitive.
function tokenizeText(text) {
  if (!text) return [];
  const tokens = new Set();
  const lower = text.toLowerCase();

  // English words/identifiers (≥2 chars to match en_word + en_ci)
  const enWords = lower.match(/[a-z][a-z0-9_.\-]+/g) || [];
  for (const w of enWords) tokens.add(w);

  // Chinese bigrams
  const cnChars = text.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cnChars.length - 1; i++) {
    tokens.add(cnChars[i] + cnChars[i + 1]);
  }
  // Chinese trigrams (matches extractQueryTerms trigram weight)
  for (let i = 0; i < cnChars.length - 2; i++) {
    tokens.add(cnChars[i] + cnChars[i + 1] + cnChars[i + 2]);
  }

  // Bare numbers (ports, versions)
  const nums = lower.match(/\d{2,}/g) || [];
  for (const n of nums) tokens.add(n);

  return [...tokens];
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export class MemoryIndex {
  constructor({ htmlPath, indexPath }) {
    this.htmlPath = htmlPath;
    // Default index path: memory.html → memory.index.json (sibling file)
    this.indexPath = indexPath || htmlPath.replace(/\.html$/, '') + '.index.json';
    this._cache = null;       // parsed index, loaded lazily
    this._cacheHash = null;   // hash of file when cache was loaded
  }

  /**
   * Build a fresh index from an articles Map (id → node).
   * Returns the in-memory index object; does NOT write to disk.
   * Caller is expected to write atomically.
   */
  static buildFromArticles(articles, htmlContent, htmlMtimeMs) {
    const tagIdx = {};
    const triggerIdx = {};
    const summaryTermIdx = {};
    const termIdx = {};

    for (const [id, node] of articles) {
      // Tag index — exact match (preserve original case for tag-style search)
      for (const tag of (node.tags || [])) {
        const key = String(tag).toLowerCase();
        (tagIdx[key] ||= []).push(id);
      }

      // Trigger index — exact phrase from <ul class="triggers">
      for (const trig of (node.triggers || [])) {
        const key = String(trig).toLowerCase();
        (triggerIdx[key] ||= []).push(id);
        // Also tokenize triggers into the global term index (they're high-density surfaces)
        for (const tok of tokenizeText(trig)) {
          (termIdx[tok] ||= []).push(id);
        }
      }

      // Summary term index — high-weight surface
      for (const tok of tokenizeText(node.summary || '')) {
        (summaryTermIdx[tok] ||= []).push(id);
        // Summary tokens also go to global term index (with lower priority at query time)
        (termIdx[tok] ||= []).push(id);
      }

      // Detail / conversation term index — full-text surface
      const bodyText = node.type === 'conversation'
        ? (node.conversation || '')
        : (node.detail || '');
      for (const tok of tokenizeText(bodyText)) {
        (termIdx[tok] ||= []).push(id);
      }
    }

    return {
      schema_version: SCHEMA_VERSION,
      html_hash: sha256(htmlContent),
      html_mtime: htmlMtimeMs,
      built_at: Date.now(),
      node_count: articles.size,
      indices: {
        tag: tagIdx,
        trigger: triggerIdx,
        summary_term: summaryTermIdx,
        term: termIdx,
      },
    };
  }

  /**
   * Check if on-disk index matches current HTML (mtime + hash).
   * If not fresh, returns false; caller should rebuild.
   */
  isFresh(htmlContent, htmlMtimeMs) {
    if (!existsSync(this.indexPath)) return false;
    const idx = this._load();
    if (!idx || idx.schema_version !== SCHEMA_VERSION) return false;
    if (idx.html_mtime !== htmlMtimeMs) return false;
    // mtime matches; hash check is the final authority
    return idx.html_hash === sha256(htmlContent);
  }

  /**
   * Load index from disk (cached in memory after first read).
   */
  _load() {
    if (this._cache !== null) return this._cache;
    try {
      const raw = readFileSync(this.indexPath, 'utf8');
      this._cache = JSON.parse(raw);
      this._cacheHash = sha256(raw);
      return this._cache;
    } catch {
      this._cache = null;
      return null;
    }
  }

  /**
   * Write index atomically. Caller must have just written HTML — we trust
   * the articles Map matches what's on disk.
   */
  writeFromArticles(articles, htmlContent, htmlMtimeMs) {
    const idx = MemoryIndex.buildFromArticles(articles, htmlContent, htmlMtimeMs);
    this._writeAtomic(idx);
    this._cache = idx;
    return idx;
  }

  _writeAtomic(idx) {
    const tmp = this.indexPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(idx));
    renameSync(tmp, this.indexPath);
  }

  /**
   * Delete the on-disk index (used on corruption / downgrade).
   */
  invalidate() {
    this._cache = null;
    if (existsSync(this.indexPath)) {
      try { renameSync(this.indexPath, this.indexPath + '.broken'); } catch {}
    }
  }

  /**
   * Lookup a single term in a specific index. Returns Set<id> or empty.
   */
  lookup(field, term) {
    const idx = this._load();
    if (!idx) return new Set();
    const bucket = idx.indices[field];
    if (!bucket) return new Set();
    const key = String(term).toLowerCase();
    const hits = bucket[key];
    return hits ? new Set(hits) : new Set();
  }

  /**
   * Lookup multiple terms across multiple fields. Returns Map<id, score>
   * where score is the sum of (field weight × term weight) for each hit.
   *
   * Field weights MUST match grep.js scoring:
   *   trigger     → 3.0
   *   tag         → 2.0
   *   summary_term → 1.5  (treated as a stronger-than-fulltext hit)
   *   term        → 1.0
   *
   * Multi-occurrence (same term hits same id via multiple fields) is allowed
   * and contributes multiple score increments — this matches grep's behavior
   * where the same line can match via different paths.
   */
  lookupScored(terms) {
    const FIELD_WEIGHTS = {
      trigger: 3.0,
      tag: 2.0,
      summary_term: 1.5,
      term: 1.0,
    };
    const scores = new Map();  // id → score
    const matchedTerms = new Map();  // id → Set<term>

    for (const term of terms) {
      const pattern = String(term.pattern).toLowerCase();
      // Synonym expansion already happened in extractQueryTerms — those are separate terms
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        const hits = this.lookup(field, pattern);
        for (const id of hits) {
          scores.set(id, (scores.get(id) || 0) + term.weight * weight);
          if (!matchedTerms.has(id)) matchedTerms.set(id, new Set());
          matchedTerms.get(id).add(term.pattern);
        }
      }
    }

    return { scores, matchedTerms };
  }

  /**
   * Number of nodes tracked by this index. Useful for diagnostics.
   */
  size() {
    const idx = this._load();
    return idx ? idx.node_count : 0;
  }
}
