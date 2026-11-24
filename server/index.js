import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import { config } from './config.js';
import { Library } from './library.js';

const library = new Library(config.dbPath);

// State of the most recent list upload/import.
const importState = {
  running: false,
  phase: '',
  progress: 0,
  error: null,
  finishedAt: null,
};

// ---------------------------------------------------------------- importing

function startImport(sourcePath, sourceName, { keepSource }) {
  importState.running = true;
  importState.phase = 'Reading folders';
  importState.progress = 0;
  importState.error = null;

  const worker = new Worker(new URL('./import-worker.js', import.meta.url), {
    workerData: { sourcePath, outPath: config.buildPath, sourceName },
  });
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    importState.running = false;
    importState.finishedAt = new Date().toISOString();
    importState.error = error;
    if (error) {
      console.error(`Import failed: ${error}`);
      fs.rmSync(config.buildPath, { force: true });
      if (keepSource) fs.rmSync(sourcePath, { force: true });
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
        // The uploaded file replaces the stored copy of the list.
        if (keepSource) {
          fs.renameSync(sourcePath, config.sourcePath);
          fs.writeFileSync(config.sourceNamePath, sourceName);
        }
        console.log(
          `Loaded "${sourceName}": ${msg.stats.files.toLocaleString('en')} files in ${msg.stats.folders.toLocaleString('en')} folders.`,
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
    if (code !== 0) finish(`The import stopped unexpectedly (exit code ${code}).`);
  });
}

function boot() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const stale of [config.uploadPath, config.buildPath]) fs.rmSync(stale, { force: true });

  if (library.open()) {
    console.log(`List loaded: ${library.info.files.toLocaleString('en')} files from "${library.info.sourceName}".`);
  } else if (fs.existsSync(config.sourcePath)) {
    console.log('Rebuilding the database from the stored list file…');
    let name = 'source.txt';
    try {
      name = fs.readFileSync(config.sourceNamePath, 'utf8').trim() || name;
    } catch {
      // no stored name
    }
    startImport(config.sourcePath, name, { keepSource: false });
  } else {
    console.log('No list loaded yet. Open the app and upload your list file.');
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

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function isAuthorized(req) {
  if (!config.password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  const userOk = config.username ? safeEqual(user, config.username) : true;
  return safeEqual(pass, config.password) && userOk;
}

function statusPayload() {
  return {
    state: library.ready ? 'ready' : 'empty',
    library: library.info,
    import: { ...importState },
    maxUploadBytes: config.maxUploadBytes,
  };
}

// ------------------------------------------------------------------- upload

function handleUpload(req, res) {
  if (importState.running) {
    req.resume();
    return sendError(req, res, 409, 'A list is already being loaded. Wait for it to finish.');
  }
  // Uploads must come from this app's own page, not from another site.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      // leave empty
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (originHost !== host) {
      req.resume();
      return sendError(req, res, 403, 'Uploads are only accepted from this app.');
    }
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

  let sourceName = 'list.txt';
  try {
    const raw = decodeURIComponent(String(req.headers['x-filename'] || ''));
    const base = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
    if (base) sourceName = base.slice(0, 200);
  } catch {
    // keep the default name
  }

  importState.running = true;
  importState.phase = 'Uploading';
  importState.progress = 0;
  importState.error = null;

  const out = fs.createWriteStream(config.uploadPath);
  let received = 0;
  let failed = false;
  const fail = (status, message) => {
    if (failed) return;
    failed = true;
    importState.running = false;
    importState.error = message;
    importState.finishedAt = new Date().toISOString();
    req.unpipe(out);
    out.destroy();
    fs.rm(config.uploadPath, { force: true }, () => {});
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
    if (received === 0) return fail(400, 'The uploaded file is empty.');
    startImport(config.uploadPath, sourceName, { keepSource: true });
    sendJson(req, res, 202, { started: true });
  });
  req.pipe(out);
}

// ------------------------------------------------------------------ routing

function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(req, res, 200, statusPayload());
  }
  if (p === '/api/import' && req.method === 'POST') {
    return handleUpload(req, res);
  }
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
    if (result.notFound) return sendError(req, res, 404, 'That folder is not in the current list.');
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

  if (!isAuthorized(req)) {
    req.resume();
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Shelfmark", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Sign in to continue.');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url);
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
server.listen(config.port, config.host, () => {
  console.log(`Shelfmark is running on http://localhost:${config.port}`);
  if (!config.password) console.log('No APP_PASSWORD set: anyone who can reach this address can use the app.');
});

function shutdown() {
  server.close(() => {
    library.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
