/* Cushion & Cue — authoritative server + static host. Zero dependencies.
 * Node >= 18. Serves the distribution, exposes:
 *   GET  /api/v1/time                     → {now, epochMs}
 *   POST /api/v1/session/start  {config}  → {sessionId, state, hash}
 *   POST /api/v1/session/:id/command {commandId, command}
 *                                         → {ok, invalid?, state, hash, events}
 *   GET  /api/v1/session/:id              → snapshot (reconnect source of truth)
 *   POST /api/v1/session/:id/resign       → terminal snapshot
 * Rules run server-side via ./js/rules.js. In-memory store, compact JSON,
 * idempotent duplicate rejection by commandId, state hash per transition.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const Rules = require('./js/rules.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 16 * 1024;
const MAX_SESSIONS = 500;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.opus': 'audio/ogg; codecs=opus',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// ---------------- session store ----------------
const sessions = new Map(); // id → {state, commands: Map(commandId → result), createdAt}

function newSession(config) {
  if (!config || typeof config !== 'object' || !Number.isInteger(config.seed)) {
    const e = new Error('config requires an integer seed');
    e.status = 400;
    throw e;
  }
  const state = Rules.createGame(config); // throws on bad config
  if (sessions.size >= MAX_SESSIONS) {
    // evict oldest
    let oldestId = null, oldest = Infinity;
    for (const [id, s] of sessions) if (s.createdAt < oldest) { oldest = s.createdAt; oldestId = id; }
    if (oldestId) sessions.delete(oldestId);
  }
  const id = crypto.randomBytes(12).toString('hex');
  sessions.set(id, { state, commands: new Map(), createdAt: Date.now(), hash: Rules.hashState(state) });
  return id;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) { const e = new Error('session not found'); e.status = 404; throw e; }
  return s;
}

function applySessionCommand(sess, commandId, command) {
  if (typeof commandId !== 'string' || !commandId || commandId.length > 64) {
    const e = new Error('commandId (string, ≤64 chars) is required');
    e.status = 400; throw e;
  }
  if (sess.commands.has(commandId)) {
    return Object.assign({ duplicate: true }, sess.commands.get(commandId));
  }
  const res = Rules.applyCommand(sess.state, command);
  if (res.ok) {
    sess.state = res.state;
    sess.hash = Rules.hashState(res.state);
  }
  const out = { ok: res.ok, state: sess.state, hash: sess.hash, events: res.events || [] };
  if (!res.ok) out.invalid = res.invalid;
  sess.commands.set(commandId, out);
  return out;
}

// ---------------- http plumbing ----------------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { const e = new Error('payload too large'); e.status = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { e.status = 400; e.message = 'invalid JSON body'; reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','v1',...]
  const method = req.method;

  if (method === 'GET' && url.pathname === '/api/v1/time') {
    const now = new Date();
    return send(res, 200, { now: now.toISOString(), epochMs: now.getTime() });
  }

  if (method === 'POST' && url.pathname === '/api/v1/session/start') {
    const body = await readBody(req);
    const id = newSession(body.config);
    const sess = getSession(id);
    return send(res, 201, { sessionId: id, state: sess.state, hash: sess.hash });
  }

  const m = url.pathname.match(/^\/api\/v1\/session\/([0-9a-f]{24})(\/command|\/resign)?$/);
  if (m) {
    const sess = getSession(m[1]);
    if (method === 'GET' && !m[2]) {
      return send(res, 200, { sessionId: m[1], state: sess.state, hash: sess.hash, terminal: sess.state.terminal });
    }
    if (method === 'POST' && m[2] === '/command') {
      const body = await readBody(req);
      const out = applySessionCommand(sess, body.commandId, body.command);
      return send(res, out.ok ? 200 : 422, out);
    }
    if (method === 'POST' && m[2] === '/resign') {
      const out = applySessionCommand(sess, 'resign-' + crypto.randomBytes(6).toString('hex'), { type: 'resign' });
      return send(res, 200, out);
    }
  }

  send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400); res.end('bad request'); return; }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => {
      send(res, err.status || 500, { error: err.message || 'internal error' });
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname);
  } else {
    res.writeHead(405); res.end('method not allowed');
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Cushion & Cue server on http://localhost:${PORT}`);
  });
}

module.exports = { server, sessions };
