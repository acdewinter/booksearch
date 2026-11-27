// The /api/collection/* endpoints: what the Collection page shows and
// changes, and what the reader app on a phone fetches (the list, the files,
// the covers) and reports back (how far a book has been read).

import fs from 'node:fs';
import path from 'node:path';
import { hardcoverIdOf, readJsonBody } from '../auth.js';
import { coverStamp } from '../hardcover/service.js';
import { CollectionError, guessBooks } from './store.js';

const FILE_TYPES = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  cbz: 'application/vnd.comicbook+zip',
  mp3: 'audio/mpeg',
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  zip: 'application/zip',
};
const FOUND_MS = 30 * 60 * 1000;
const MAX_FOUND = 400;

// What a paired device may do. Everything else is for someone signed in on the web.
const DEVICE_GET = new Set(['', 'file', 'cover', 'progress']);
const DEVICE_POST = new Set(['progress']);

/**
 * @param {object} o
 * @param {import('./store.js').Collection} o.collection
 * @param {import('../hardcover/service.js').Hardcover} o.hardcover
 * @param {string} o.downloadDir
 * @param {object} http helpers from the web server: sendJson, sendError, sameOrigin
 */
export function createCollectionRoutes({ collection, hardcover, downloadDir }, { sendJson, sendError, sameOrigin }) {
  // Books found on Hardcover a moment ago, so one of them can be picked by its id alone.
  const found = new Map(); // "account|book id" -> { facts, at }

  function remember(account, books) {
    const now = Date.now();
    for (const book of books) {
      found.delete(`${account}|${book.id}`);
      found.set(`${account}|${book.id}`, { facts: book, at: now });
    }
    for (const [key, entry] of found) {
      if (found.size <= MAX_FOUND && now - entry.at < FOUND_MS) break;
      found.delete(key);
    }
  }

  /** The facts of a Hardcover book this account may tie a file to: from its library, or from a search just now. */
  function hardcoverFacts(hardcoverId, account) {
    const userId = hardcoverIdOf(account);
    const data = userId ? hardcover.library(userId) : null;
    const book = data?.byId.get(hardcoverId);
    if (book) {
      const entry = data.entryById.get(hardcoverId);
      return { ...book, pages: entry?.editionPages || book.pages, cover: entry?.editionCover || book.cover };
    }
    const recent = found.get(`${account}|${hardcoverId}`);
    return recent && Date.now() - recent.at < FOUND_MS ? recent.facts : null;
  }

  /** A book as the lookup lists it. */
  const choice = (book, inLibrary) => ({
    id: book.id,
    title: book.title,
    subtitle: book.subtitle || undefined,
    authors: book.authors,
    series: book.series || undefined,
    year: book.year ?? undefined,
    color: book.color || undefined,
    inLibrary,
    inCollection: Boolean(collection.byHardcoverId(book.id)) || undefined,
    // Where its cover is served from: with the library's covers, or with the ones just looked up.
    cover: book.cover ? (inLibrary ? 'library' : 'lookup') : undefined,
    coverStamp: book.cover ? coverStamp(book.cover) : undefined,
  });

  function capabilities(account) {
    const userId = hardcoverIdOf(account);
    const connected = Boolean(userId && hardcover.describe(userId));
    return {
      hardcover: hardcover.configured,
      library: connected && Boolean(hardcover.library(userId)),
      catalog: connected && hardcover.canSearch(userId),
      connected,
    };
  }

  async function lookup(req, res, url, account) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const userId = hardcoverIdOf(account);
    const can = capabilities(account);
    const library = can.library && q ? guessBooks(q, hardcover.library(userId).books, 8) : [];
    const out = { q, can, library: library.map((b) => choice(b, true)), catalog: [], catalogError: undefined };
    if (can.catalog && q) {
      try {
        const inLibrary = new Set(library.map((b) => b.id));
        const hits = (await hardcover.search(userId, q, 12)).filter((b) => !inLibrary.has(b.id));
        remember(account, hits);
        out.catalog = hits.map((b) => choice(b, Boolean(hardcover.library(userId)?.byId.has(b.id))));
      } catch (err) {
        if (err.code === 'insufficient_scope' || err.status === 403) out.can.catalog = false;
        else out.catalogError = err.message;
      }
    }
    return sendJson(req, res, 200, out);
  }

  // ---------------------------------------------------------------- files

  /** Send a file, whole or the part asked for, so a download that broke off can pick up again. */
  function sendFile(req, res, file) {
    const etag = `"${file.size}-${file.mtimeMs}"`;
    const headers = {
      'Content-Type': FILE_TYPES[file.format] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    };
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const ifRange = req.headers['if-range'];
    if (range && (range[1] || range[2]) && (!ifRange || ifRange === etag)) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), file.size - 1);
      } else {
        start = Math.max(0, file.size - Number(range[2]));
      }
      if (start > end || start >= file.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
    headers['Content-Length'] = file.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !file.size) {
      res.end();
      return;
    }
    fs.createReadStream(file.abs, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  /** The cover of a book that was just looked up and is not in the collection or the library yet. */
  async function lookupCover(url, account) {
    const id = Number.parseInt(url.searchParams.get('id') || '', 10);
    const recent = found.get(`${account}|${id}`);
    if (!recent?.facts.cover) return null;
    fs.mkdirSync(collection.coverDir, { recursive: true });
    const stem = path.join(collection.coverDir, `lookup-${id}-${coverStamp(recent.facts.cover)}`);
    for (const ext of ['.jpg', '.png', '.webp', '.gif', '.avif']) {
      if (fs.existsSync(stem + ext)) return { file: stem + ext, type: { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }[ext] };
    }
    return hardcover.coverFromUrl(recent.facts.cover, stem);
  }

  async function cover(req, res, url, account) {
    const foundCover = account === undefined
      ? await collection.cover(url.searchParams.get('book') || '')
      : await lookupCover(url, account);
    let size = 0;
    try {
      if (foundCover) size = fs.statSync(foundCover.file).size;
    } catch {
      // treated as no cover
    }
    if (!size) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=600' });
      res.end('No cover');
      return;
    }
    res.writeHead(200, {
      'Content-Type': foundCover.type,
      'Content-Length': size,
      // The address carries a stamp of the cover, so this copy never goes stale.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(foundCover.file).on('error', () => res.destroy()).pipe(res);
  }

  // -------------------------------------------------------------- changes

  const actions = {
    attach(body, account) {
      const hardcoverId = Number.isInteger(body.hardcoverId) ? body.hardcoverId : null;
      let title = {};
      if (hardcoverId) {
        const facts = hardcoverFacts(hardcoverId, account);
        if (!facts) throw new CollectionError('That book could not be found any more. Look it up again.', 404);
        title = { ...facts, hardcoverId };
      } else if (typeof body.title === 'string' && body.title.trim()) {
        title = {
          title: body.title,
          authors: String(body.authors || '').split(/\s*[,;&]\s*|\s+and\s+/i).filter(Boolean),
        };
      }
      const book = collection.attach(body.path, title);
      return { book: { id: book.id, title: book.title } };
    },
    detach(body) {
      collection.detach(body.file);
    },
    remove(body) {
      collection.remove(body.book);
    },
    expect(body, account) {
      const commands = Array.isArray(body.commands) ? body.commands.slice(0, 200) : [];
      for (const command of commands) collection.expect(command, body.book, account);
    },
    progress(body, account, session) {
      return {
        progress: collection.setProgress(account, body.file, { ...body, device: body.device || session.device?.name || 'Web' }),
      };
    },
  };

  /** Whether a paired device (the reader app) may make this request. */
  function allowsDevice(req, url) {
    if (url.pathname !== '/api/collection' && !url.pathname.startsWith('/api/collection/')) return false;
    const name = url.pathname.slice('/api/collection/'.length);
    if (req.method === 'GET' || req.method === 'HEAD') return DEVICE_GET.has(name);
    return req.method === 'POST' && DEVICE_POST.has(name);
  }

  /** Returns true when the request was for this part of the API. The visitor is signed in. */
  function handle(req, res, url, session) {
    if (url.pathname !== '/api/collection' && !url.pathname.startsWith('/api/collection/')) return false;
    const name = url.pathname.slice('/api/collection/'.length);
    const { account } = session;
    const q = url.searchParams;

    const fail = (err) => {
      if (err instanceof CollectionError) return sendError(req, res, err.status, err.message);
      console.error(err);
      if (res.headersSent) return res.destroy();
      return sendError(req, res, 500, 'Something went wrong on the server.');
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        if (name === '') {
          sendJson(req, res, 200, { ...collection.list(account), folder: downloadDir, can: capabilities(account), now: Date.now() });
        } else if (name === 'owned') {
          sendJson(req, res, 200, { owned: collection.owned() });
        } else if (name === 'file') {
          const file = collection.fileOnDisk(q.get('id') || '');
          if (!file) sendError(req, res, 404, 'That file is not in the collection, or it is gone from the download folder.');
          else sendFile(req, res, file);
        } else if (name === 'cover') {
          cover(req, res, url).catch(fail);
        } else if (name === 'lookup-cover') {
          cover(req, res, url, account).catch(fail);
        } else if (name === 'progress') {
          sendJson(req, res, 200, { progress: collection.getProgress(account, q.get('file') || ''), now: Date.now() });
        } else if (name === 'describe') {
          const info = collection.describeFile(q.get('path') || '');
          const userId = hardcoverIdOf(account);
          const library = userId ? hardcover.library(userId) : null;
          const guesses = library ? guessBooks(`${info.query} ${info.name}`, library.books, 4) : [];
          sendJson(req, res, 200, { ...info, can: capabilities(account), guesses: guesses.map((b) => choice(b, true)) });
        } else if (name === 'lookup') {
          lookup(req, res, url, account).catch(fail);
        } else {
          sendError(req, res, 404, 'Not found.');
        }
      } catch (err) {
        fail(err);
      }
      return true;
    }

    if (req.method !== 'POST') {
      req.resume();
      sendError(req, res, 405, 'Method not allowed.');
      return true;
    }
    const action = Object.hasOwn(actions, name) ? actions[name] : null;
    if (!action) {
      req.resume();
      sendError(req, res, 404, 'Not found.');
      return true;
    }
    if (!sameOrigin(req) || !/^application\/json/i.test(req.headers['content-type'] || '')) {
      req.resume();
      sendError(req, res, 403, 'This is only accepted from the app itself.');
      return true;
    }
    readJsonBody(req)
      .then((body) => sendJson(req, res, 200, { ok: true, ...(action(body, account, session) || {}) }))
      .catch((err) => {
        if (err instanceof CollectionError) fail(err);
        else if (/request/.test(err.message || '')) sendError(req, res, 400, err.message);
        else fail(err);
      });
    return true;
  }

  return { handle, allowsDevice, hardcoverFacts };
}
