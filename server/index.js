import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import { Auth, createAuthRoutes, hardcoverIdOf } from './auth.js';
import { config } from './config.js';
import { HardcoverClient } from './hardcover/client.js';
import { createHardcoverRoutes } from './hardcover/routes.js';
import { Hardcover } from './hardcover/service.js';
import { IrcManager } from './irc/manager.js';
import { createIrcRoutes } from './irc/routes.js';
import { Library } from './library.js';
import { ListError, ListStore } from './lists.js';

const library = new Library(config.dbPath);
const store = new ListStore(config.dataDir);
const irc = new IrcManager({
  dataDir: config.dataDir,
  downloadDir: config.downloadDir,
  dccPorts: config.dccPorts,
  dccPublicIp: config.dccPublicIp,
  version: config.version,
  // The senders named by the loaded lists: files are only taken from them.
  listBots: () => library.info?.bots || [],
});
const hardcover = new Hardcover({
  client: new HardcoverClient({ ...config.hardcover, userAgent: `Shelfmark/${config.version || 'dev'}` }),
  dataDir: config.dataDir,
});
const auth = new Auth({
  dataDir: config.dataDir,
  password: config.password,
  username: config.username,
  hardcover: hardcover.configured,
  allowedUsers: config.hardcover.allowedUsers,
  appUrl: config.appUrl,
});

// State of the most recent change to the lists.
const importState = {
  running: false,
  phase: '',
  progress: 0,
  error: null,
  finishedAt: null,
};

// ---------------------------------------------------------------- importing

/**
 * Build the database for a planned set of lists (see ListStore.plan) in a
 * worker, then swap it in. Until that succeeds nothing changes.
 */
function startBuild(plan) {
  importState.running = true;
  importState.phase = 'Reading folders';
  importState.progress = 0;
  importState.error = null;

  const worker = new Worker(new URL('./import-worker.js', import.meta.url), {
    workerData: { sources: plan.sources, outPath: config.buildPath, key: plan.key },
  });
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    importState.running = false;
    importState.finishedAt = new Date().toISOString();
    importState.error = error;
    if (error) {
      console.error(`Loading the lists failed: ${error}`);
      fs.rmSync(config.buildPath, { force: true });
      plan.discard();
    }
  };

  worker.on('message', (msg) => {
    if (msg.type === 'progress') {
      importState.phase = msg.phase;
      importState.progress = msg.progress;
    } else if (msg.type === 'error') {
      finish(msg.message);
    } else if (msg.type === 'done') {
      try {
        library.swap(config.buildPath);
        plan.commit(msg.stats.lists);
        console.log(
          `Loaded ${msg.stats.files.toLocaleString('en')} files in ${msg.stats.folders.toLocaleString('en')} folders from ${msg.stats.lists.map((l) => `"${l.name}"`).join(', ')}.`,
        );
        finish(null);
      } catch (err) {
        library.open();
        finish(err.message);
      }
    }
  });
  worker.on('error', (err) => finish(err.message));
  worker.on('exit', (code) => {
    if (code !== 0) finish(`Loading stopped unexpectedly (exit code ${code}).`);
  });
}

/** Add, replace or remove lists. Throws ListError when the request makes no sense. */
function applyListChanges(changes) {
  const plan = store.plan(changes);
  if (plan.sources.length > 0) {
    startBuild(plan);
    return;
  }
  // The last list was removed: there is nothing left to search.
  library.close();
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
  plan.commit();
  importState.error = null;
  importState.finishedAt = new Date().toISOString();
  console.log('All lists were removed.');
}

function boot() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const stale of [config.uploadPath, config.buildPath]) fs.rmSync(stale, { force: true });
  store.load();
  auth.load();
  hardcover.load();

  const opened = library.open();
  if (store.lists.length === 0) {
    console.log(opened
      ? `List loaded: ${library.info.files.toLocaleString('en')} files from "${library.info.sourceName}".`
      : 'No list loaded yet. Open the app and upload your list file.');
  } else if (opened && library.info.listsKey === store.key()) {
    console.log(`${store.lists.length === 1 ? 'List' : `${store.lists.length} lists`} loaded: ${library.info.files.toLocaleString('en')} files.`);
  } else {
    // A new app version, or lists changed while the app was off: build from the stored files.
    console.log('Rebuilding the database from the stored list files…');
    startBuild({
      sources: store.sources(),
      key: store.key(),
      commit: (stats) => store.setStats(stats),
      discard: () => {},
    });
  }
}

// ------------------------------------------------------------------ helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const acceptsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

function sendJson(req, res, status, body) {
  let payload = Buffer.from(JSON.stringify(body));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (payload.length > 1024 && acceptsGzip(req)) {
    payload = zlib.gzipSync(payload, { level: 4 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = payload.length;
  res.writeHead(status, headers);
  res.end(payload);
}

const sendError = (req, res, status, message) => sendJson(req, res, status, { error: message });

const staticCache = new Map(); // file path -> { etag, mtimeMs, raw, gzip }

function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(config.publicDir, rel);
  if (!filePath.startsWith(config.publicDir + path.sep)) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  let entry = staticCache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    const raw = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    entry = {
      mtimeMs: stat.mtimeMs,
      raw,
      gzip: COMPRESSIBLE.has(ext) ? zlib.gzipSync(raw, { level: 9 }) : null,
      etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`,
      type: MIME[ext] || 'application/octet-stream',
      immutable: ext === '.woff2',
    };
    staticCache.set(filePath, entry);
  }

  const headers = {
    'Content-Type': entry.type,
    ETag: entry.etag,
    'Cache-Control': entry.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let body = entry.raw;
  if (entry.gzip && acceptsGzip(req)) {
    body = entry.gzip;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** Requests that change something must come from this app's own page, not from another site. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser, or a same-origin request from an older one
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === (req.headers['x-forwarded-host'] || req.headers.host);
}

const http_ = { sendJson, sendError, sameOrigin };
const ircRoutes = createIrcRoutes(irc, http_);
const hardcoverRoutes = createHardcoverRoutes({ auth, hardcover, library, appUrl: config.appUrl }, http_);
const authRoutes = createAuthRoutes(auth, http_, (session) => {
  const userId = hardcoverIdOf(session.account);
  return { hardcover: userId ? hardcover.describe(userId) : null };
});

function statusPayload() {
  return {
    state: library.ready ? 'ready' : 'empty',
    library: library.info,
    lists: store.lists,
    import: { ...importState },
    maxUploadBytes: config.maxUploadBytes,
  };
}

// ------------------------------------------------------------------- upload

/** Receive one list file. It waits in a holding area until /api/lists/apply says what it is. */
function handleUpload(req, res) {
  if (!sameOrigin(req)) {
    req.resume();
    return sendError(req, res, 403, 'Uploads are only accepted from this app.');
  }
  if (!/^application\/octet-stream/i.test(req.headers['content-type'] || '')) {
    req.resume();
    return sendError(req, res, 415, 'Send the list file as application/octet-stream.');
  }
  const declared = Number(req.headers['content-length'] || 0);
  const limitMb = Math.round(config.maxUploadBytes / 1024 / 1024);
  if (declared > config.maxUploadBytes) {
    req.resume();
    return sendError(req, res, 413, `This file is larger than the ${limitMb} MB limit.`);
  }

  let fileName = 'list.txt';
  try {
    const raw = decodeURIComponent(String(req.headers['x-filename'] || ''));
    const base = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
    if (base) fileName = base.slice(0, 200);
  } catch {
    // keep the default name
  }

  const staged = store.stage();
  const out = fs.createWriteStream(staged.path);
  let received = 0;
  let failed = false;
  const fail = (status, message) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(staged.path, { force: true }, () => {});
    if (!res.headersSent) {
      res.setHeader('Connection', 'close');
      sendError(req, res, status, message);
    }
    req.resume();
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.maxUploadBytes) fail(413, `This file is larger than the ${limitMb} MB limit.`);
  });
  req.on('close', () => {
    if (!req.complete) fail(400, 'The upload was interrupted.');
  });
  req.on('error', () => fail(400, 'The upload was interrupted.'));
  out.on('error', (err) => fail(500, `Could not save the upload: ${err.message}`));
  out.on('finish', () => {
    if (failed) return;
    if (received === 0) return fail(400, `"${fileName}" is empty.`);
    sendJson(req, res, 200, { token: staged.token, fileName, bytes: received });
  });
  req.pipe(out);
}

/** Say what the uploaded files are (new lists, or newer copies), and which lists to drop. */
function handleApply(req, res) {
  if (!sameOrigin(req) || !/^application\/json/i.test(req.headers['content-type'] || '')) {
    req.resume();
    return sendError(req, res, 403, 'This is only accepted from the app itself.');
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('error', () => {});
  req.on('end', () => {
    let changes;
    try {
      changes = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendError(req, res, 400, 'The request could not be read.');
    }
    if (importState.running) {
      store.discard([...(changes?.add || []), ...(changes?.replace || [])].map((c) => c?.token));
      return sendError(req, res, 409, 'Lists are already being loaded. Wait for that to finish.');
    }
    try {
      applyListChanges(changes);
      return sendJson(req, res, 202, { started: true });
    } catch (err) {
      if (err instanceof ListError) return sendError(req, res, 400, err.message);
      console.error(err);
      return sendError(req, res, 500, 'Something went wrong on the server.');
    }
  });
  return undefined;
}

// ------------------------------------------------------------------ routing

function handleApi(req, res, url, session) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(req, res, 200, statusPayload());
  }
  if (p === '/api/lists/upload' && req.method === 'POST') {
    return handleUpload(req, res);
  }
  if (p === '/api/lists/apply' && req.method === 'POST') {
    return handleApply(req, res);
  }
  if (ircRoutes.handle(req, res, url)) return undefined;
  if (hardcoverRoutes.handle(req, res, url, session)) return undefined;
  if (req.method !== 'GET') return sendError(req, res, 405, 'Method not allowed.');

  if (p === '/api/search' || p === '/api/browse' || p === '/api/files') {
    if (!library.ready) return sendError(req, res, 503, 'No list is loaded yet.');
    const all = q.get('all') === '1';
    const folderPath = q.get('path') || '/';
    const int = (name) => Math.max(0, Number.parseInt(q.get(name) || '0', 10) || 0);
    let result;
    if (p === '/api/search') {
      result = library.search({ q: q.get('q') || '', path: folderPath, all, page: Math.min(int('page'), 10000) });
    } else if (p === '/api/browse') {
      result = library.browse({ path: folderPath, all });
    } else {
      result = library.files({
        path: folderPath,
        q: q.get('q') || '',
        all,
        offset: int('offset'),
        limit: int('limit') || undefined,
      });
    }
    if (result.notFound) return sendError(req, res, 404, 'That folder is not in the loaded lists.');
    return sendJson(req, res, 200, result);
  }
  return sendError(req, res, 404, 'Not found.');
}

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }

  try {
    // The page itself and signing in are open to everyone; everything it shows is not.
    const session = auth.session(req);
    if (authRoutes.handle(req, res, url, session)) return;
    if (hardcoverRoutes.handlePublic(req, res, url, session)) return;
    if (url.pathname.startsWith('/api/')) {
      if (!session) {
        req.resume();
        sendJson(req, res, 401, { error: 'Sign in to continue.', signIn: true });
        return;
      }
      handleApi(req, res, url, session);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendError(req, res, 500, 'Something went wrong on the server.');
    else res.end();
  }
});

// Large uploads over a slow link need more than the default 5 minutes.
server.requestTimeout = 30 * 60 * 1000;

boot();
irc.start();
server.listen(config.port, config.host, () => {
  console.log(`Shelfmark is running on http://localhost:${config.port}`);
  console.log(`Downloads are saved to ${config.downloadDir}`);
  if (hardcover.configured) {
    const who = config.hardcover.allowedUsers.length
      ? `only ${config.hardcover.allowedUsers.map((u) => `@${u}`).join(', ')}`
      : auth.owner
        ? `only @${auth.owner.username}, who owns this app`
        : config.password
          ? 'the first account to connect after signing in with the app password will own this app'
          : 'the first account to sign in will own this app';
    console.log(`Sign-in with Hardcover is on (${who}).`);
    console.log(`Redirect URI to register at hardcover.app: ${config.appUrl || `http://localhost:${config.port}`}/oauth/callback`);
  } else if (config.hardcover.clientId || config.hardcover.clientSecret) {
    console.log('Hardcover needs both HARDCOVER_CLIENT_ID and HARDCOVER_CLIENT_SECRET: it is off until both are set.');
  }
  if (!auth.required) {
    console.log('No sign-in is set up: anyone who can reach this address can use the app, including the IRC connection.');
  }
});

function shutdown() {
  irc.shutdown();
  ircRoutes.close();
  auth.flush();
  server.close(() => {
    library.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
