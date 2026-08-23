/**
 * Fail-Improve Loop: auto-learn synonyms from query/result co-occurrence.
 *
 * Tracks:
 *   - Queries that returned low direct-grep matches but got results via in-memory search
 *   - Co-occurrence of query terms with matched articles' tags/triggers
 * When a query term co-occurs with a tag/trigger N times, it becomes a learned synonym.
 *
 * Storage: synonyms.json (one file per namespace, alongside memory.html)
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const LEARN_THRESHOLD = 2;          // need this many co-occurrences to promote to "learned"
const LEARN_FILE = 'synonyms.json';

export class SynonymLearner {
  constructor({ basePath }) {
    this.path = join(basePath, LEARN_FILE);
    // Map<query_term, Map<target_term, count>>
    this._cooccur = new Map();
    // Learned synonyms: Map<query_term, Set<target_terms>>
    this._learned = new Map();
    this._dirty = false;
    this._load();
  }

  _load() {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [k, v] of Object.entries(data.cooccur || {})) {
        this._cooccur.set(k, new Map(Object.entries(v)));
      }
      for (const [k, v] of Object.entries(data.learned || {})) {
        this._learned.set(k, new Set(v));
      }
    } catch { /* corrupt file, start fresh */ }
  }

  flush() {
    if (!this._dirty) return;
    const data = {
      cooccur: Object.fromEntries(
        [...this._cooccur.entries()].map(([k, v]) => [k, Object.fromEntries(v)])
      ),
      learned: Object.fromEntries(
        [...this._learned.entries()].map(([k, v]) => [k, [...v]])
      ),
    };
    writeFileSync(this.path, JSON.stringify(data, null, 2), 'utf8');
    this._dirty = false;
  }

  /**
   * Record a query → matchedArticles event.
   * Only record (query_term, article_target) pairs where:
   *   - query_term is meaningful (≥2 chars Chinese or ≥3 chars English)
   *   - query_term is NOT a substring of the article text (real semantic gap)
   *   - target is the article's distinctive tags/triggers (not all words)
   */
  recordQuery({ queryTerms, matchedArticles }) {
    if (!queryTerms || !matchedArticles || matchedArticles.length === 0) return;

    // Only accept meaningful query terms:
    //   - English identifiers ≥3 chars (e.g. "k8s", "Redis", "nginx")
    //   - Chinese terms ≥2 chars that look like real words (not bigram slices)
    const STOPWORDS = new Set(['怎么', '什么', '如何', '为什么', '哪个', '哪儿', '咋', '为何',
      '么调', '务怎', '么暴', '部访', '点选', '择器', '群内', '签怎', '么用', '调度策略',
      'the', 'and', 'for', 'not', 'how', 'what', 'why', 'use', 'using', 'with']);

    // Real Chinese words are typically 2 chars but match query intent, not stopword slices
    const CHINESE_WORD_RE = /^[一-鿿]{2,4}$/;

    for (const term of queryTerms) {
      // Filter: must be English ≥3 chars OR a Chinese word
      const isEnglish = /^[a-zA-Z][a-zA-Z0-9_-]{2,}$/.test(term);
      const isChineseWord = CHINESE_WORD_RE.test(term);
      if (!isEnglish && !isChineseWord) continue;
      if (STOPWORDS.has(term)) continue;
      if (STOPWORDS.has(term.toLowerCase())) continue;

      if (!this._cooccur.has(term)) this._cooccur.set(term, new Map());
      const targets = this._cooccur.get(term);

      for (const article of matchedArticles.slice(0, 3)) {
        // Skip if term already appears in article text (no semantic gap)
        const articleText = `${article.summary || ''} ${article.detail || ''} ${(article.triggers || []).join(' ')} ${(article.tags || []).join(' ')}`.toLowerCase();
        if (articleText.toLowerCase().includes(term.toLowerCase())) continue;

        // Only distinctive tags/triggers (skip noise like 'spec.type', 'show-labels')
        const candidateTargets = new Set();
        for (const tag of (article.tags || [])) {
          if (tag.length >= 3 && !tag.includes('.')) candidateTargets.add(tag);
        }
        for (const trigger of (article.triggers || [])) {
          if (trigger.length >= 3) candidateTargets.add(trigger);
        }

        for (const target of candidateTargets) {
          targets.set(target, (targets.get(target) || 0) + 1);

          if (targets.get(target) >= LEARN_THRESHOLD) {
            if (!this._learned.has(term)) this._learned.set(term, new Set());
            if (!this._learned.get(term).has(target)) {
              this._learned.get(term).add(target);
              this._dirty = true;
            }
          }
        }
      }
    }

    if (Math.random() < 0.1) this.flush();
  }

  /**
   * Get synonyms for a query term.
   * Returns promoted learned entries (count >= LEARN_THRESHOLD). Hot path:
   * the underlying _learned Map is updated live by recordQuery, so a synonym
   * promoted in this very call is visible to the next query without restart.
   */
  getLearned(term) {
    const promoted = [...(this._learned.get(term) || [])];
    // Also surface near-promoted candidates (count == LEARN_THRESHOLD - 1)
    // so the agent benefits before the threshold fully crosses. This is the
    // bridge between "we saw this once" and "we know this."
    const targets = this._cooccur.get(term);
    if (targets) {
      for (const [target, count] of targets) {
        if (count >= LEARN_THRESHOLD - 1 && !promoted.includes(target)) {
          promoted.push(target);
        }
      }
    }
    return promoted;
  }

  /**
   * Get all learned synonyms as a plain object (for debugging/inspection).
   */
  getAllLearned() {
    return Object.fromEntries(
      [...this._learned.entries()].map(([k, v]) => [k, [...v]])
    );
  }

  /**
   * Get raw co-occurrence stats (for inspection).
   */
  getStats() {
    return {
      queriesTracked: this._cooccur.size,
      learnedPairs: [...this._learned.values()].reduce((s, v) => s + v.size, 0),
      topCandidates: this._topCandidates(5),
    };
  }

  _topCandidates(n = 5) {
    const candidates = [];
    for (const [term, targets] of this._cooccur) {
      for (const [target, count] of targets) {
        if (count >= 2 && count < LEARN_THRESHOLD && !this._learned.has(term)) {
          candidates.push({ term, target, count });
        }
      }
    }
    return candidates.sort((a, b) => b.count - a.count).slice(0, n);
  }
}
