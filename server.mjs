import http from 'http';
import { MemoryEngine } from './memory-html.js';

const PORT = parseInt(process.env.MEMORY_PORT || '18234');
const BASE_PATH = process.env.MEMORY_PATH || './namespaces/default';

async function main() {
  console.log(`Grepmem Server v2 (HTML+grep) starting...`);
  console.log(`  path:    ${BASE_PATH}`);

  const engine = new MemoryEngine({ basePath: BASE_PATH });
  await engine.init();

  const stats = engine.stats();
  console.log(`  nodes:   ${stats.nodes}`);
  console.log(`  edges:   ${stats.edges}\n`);

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    try {
      // GET /health
      if (path === '/health' && req.method === 'GET') {
        json(res, { status: 'ok', ...engine.stats() });
        return;
      }

      // POST /add — add a memory (triggers optional, auto-generated)
      if (path === '/add' && req.method === 'POST') {
        const body = await readBody(req);
        const { summary, detail, triggers, author } = body;
        if (!summary) {
          json(res, { error: 'summary required' }, 400);
          return;
        }
        const result = await engine.add({ summary, detail: detail || '', triggers: triggers || [], author });
        // Force flush so the next /recall or /focus sees the new memory. add()
        // defers disk writes via _maybeFlush for benchmark throughput, but HTTP
        // callers expect immediate visibility.
        await engine._flush();
        json(res, result);
        return;
      }

      // POST /addBatch — batch add
      if (path === '/addBatch' && req.method === 'POST') {
        const body = await readBody(req);
        const { items } = body;
        if (!Array.isArray(items)) {
          json(res, { error: 'items array required' }, 400);
          return;
        }
        const results = await engine.addBatch(items);
        await engine._flush();
        json(res, { results });
        return;
      }

      // POST /recall — grep search
      if (path === '/recall' && req.method === 'POST') {
        const body = await readBody(req);
        const { query, spreadDepth } = body;
        if (!query) {
          json(res, { error: 'query required' }, 400);
          return;
        }
        const results = await engine.land(query, spreadDepth || 1);
        json(res, { results });
        return;
      }

      // GET /focus/:id
      if (path.startsWith('/focus/') && req.method === 'GET') {
        const id = path.slice(7);
        const node = await engine.focus(id);
        if (!node) { json(res, { error: 'not found' }, 404); return; }
        json(res, node);
        return;
      }

      // POST /link
      if (path === '/link' && req.method === 'POST') {
        const body = await readBody(req);
        const { source, target, strength } = body;
        const result = await engine.link(source, target, strength || 0.5);
        await engine._flush();
        json(res, result);
        return;
      }

      // POST /update
      if (path === '/update' && req.method === 'POST') {
        const body = await readBody(req);
        const { nodeId, ...fields } = body;
        const result = await engine.update(nodeId, fields);
        await engine._flush();
        json(res, result);
        return;
      }

      // POST /remove
      if (path === '/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const { nodeId } = body;
        const result = await engine.remove(nodeId);
        await engine._flush();
        json(res, result);
        return;
      }

      // GET /stats
      if (path === '/stats' && req.method === 'GET') {
        json(res, engine.stats());
        return;
      }

      // POST /reset — wipe all data
      if (path === '/reset' && req.method === 'POST') {
        engine._articles.clear();
        engine._dirty = true;
        await engine._flush();
        json(res, { reset: true });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));

    } catch (err) {
      console.error(`Error on ${path}:`, err.message);
      json(res, { error: err.message }, 500);
    }
  });

  server.listen(PORT, () => {
    console.log(`Grepmem Server listening on http://localhost:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /recall     { query } → grep search`);
    console.log(`  POST /add        { summary, triggers?, detail?, author? }`);
    console.log(`  POST /addBatch   { items: [...] }`);
    console.log(`  GET  /focus/:id`);
    console.log(`  POST /link       { source, target, strength? }`);
    console.log(`  POST /update     { nodeId, ...fields }`);
    console.log(`  POST /remove     { nodeId }`);
    console.log(`  POST /reset`);
    console.log(`  GET  /stats`);
    console.log(`  GET  /health`);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
