// The web side of Hardcover: signing in (/auth/hardcover and /oauth/callback)
// and the /api/hardcover/* endpoints the Library page uses.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { hardcoverAccount, hardcoverIdOf, parseCookies, randomToken, setCookie } from '../auth.js';
import { bookQueries, pickQueries } from '../match.js';
import { pkcePair } from './client.js';
import { coverStamp } from './service.js';

const OAUTH_COOKIE = 'shelfmark_oauth';
const PENDING_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Only ever send people back to a page of this app. */
function safeNext(value) {
  const next = String(value || '');
  return /^\/(?![/\\])/.test(next) && !/[\r\n]/.test(next) ? next : '/?v=library';
}

/**
 * @param {object} o
 * @param {import('../auth.js').Auth} o.auth
 * @param {import('./service.js').Hardcover} o.hardcover
 * @param {import('../library.js').Library} o.library the loaded lists, to look books up in
 * @param {string} o.appUrl the app's public address, if it was configured
 * @param {object} http helpers from the web server: sendJson, sendError, sameOrigin
 */
export function createHardcoverRoutes({ auth, hardcover, library, appUrl }, { sendJson, sendError, sameOrigin }) {
  const { client } = hardcover;
  const pending = new Map(); // state -> { verifier, redirectUri, next, binder, at }

  function baseUrl(req) {
    if (appUrl) return appUrl;
    const proto = auth.isSecure(req) ? 'https' : 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }

  /** The address registered with Hardcover as the app's redirect URI. */
  const redirectUri = (req) => `${baseUrl(req)}/oauth/callback`;

  function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  // --------------------------------------------------------------- signing in

  function start(req, res, url) {
    if (!hardcover.configured) return redirect(res, '/?signin=unavailable');
    const now = Date.now();
    for (const [state, entry] of pending) {
      if (now - entry.at > PENDING_MS) pending.delete(state);
    }
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);

    const { verifier, challenge } = pkcePair();
    const state = randomToken(24);
    const binder = randomToken(24);
    const uri = redirectUri(req);
    pending.set(state, { verifier, redirectUri: uri, next: safeNext(url.searchParams.get('next')), binder: sha(binder), at: now });
    // Ties the answer to the browser that asked, so a sign-in cannot be finished in someone else's.
    setCookie(res, OAUTH_COOKIE, binder, { maxAgeSec: PENDING_MS / 1000, path: '/oauth', secure: auth.isSecure(req) });
    return redirect(res, client.authorizeUrl({ state, challenge, redirectUri: uri }));
  }

  async function callback(req, res, url, session) {
    const q = url.searchParams;
    const state = q.get('state') || '';
    const entry = pending.get(state);
    pending.delete(state);
    const binder = parseCookies(req.headers.cookie)[OAUTH_COOKIE] || '';
    setCookie(res, OAUTH_COOKIE, '', { maxAgeSec: 0, path: '/oauth', secure: auth.isSecure(req) });
    const fail = (reason) => redirect(res, `/?signin=${reason}`);

    if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'denied' : 'failed');
    const code = q.get('code');
    if (!entry || Date.now() - entry.at > PENDING_MS || !binder || sha(binder) !== entry.binder || !code) return fail('expired');
    // Only an answer from Hardcover's own server is taken further (RFC 9207).
    if (q.get('iss') !== client.issuer) return fail('failed');

    let tokens;
    let user;
    try {
      tokens = await client.exchangeCode({ code, verifier: entry.verifier, redirectUri: entry.redirectUri });
      const me = (await client.graphql(tokens.accessToken, 'query Me { me { id username name } }')).me;
      const first = Array.isArray(me) ? me[0] : me;
      if (!Number.isInteger(first?.id)) throw new Error('Hardcover did not say whose account this is.');
      user = { id: first.id, username: String(first.username || ''), name: String(first.name || '') };
    } catch (err) {
      console.error(`Hardcover sign-in failed: ${err.message}`);
      if (tokens) client.revoke(tokens.refreshToken || tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token');
      return fail(err.code === 'insufficient_scope' ? 'scope' : 'failed');
    }

    const signedIn = Boolean(session && !session.open);
    const decision = auth.decide(user, { signedIn });
    if (!decision.ok) {
      console.log(`Hardcover sign-in refused for @${user.username}: ${decision.reason}.`);
      client.revoke(tokens.refreshToken || tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token');
      return fail(decision.reason);
    }
    if (decision.claim) {
      auth.claim(user);
      console.log(`@${user.username} was the first to sign in with Hardcover and now owns this app.`);
    }

    hardcover.connect(user, tokens);
    const account = hardcoverAccount(user.id);
    if (!signedIn || !auth.setAccount(session, account)) auth.open(req, res, account);
    if (hardcover.isStale(user.id)) hardcover.startSync(user.id);
    return redirect(res, entry.next);
  }

  /** The two addresses a visitor reaches before having a session. Returns true when handled. */
  function handlePublic(req, res, url, session) {
    if (req.method !== 'GET') return false;
    if (url.pathname === '/auth/hardcover') {
      start(req, res, url);
      return true;
    }
    if (url.pathname === '/oauth/callback') {
      callback(req, res, url, session).catch((err) => {
        console.error(err);
        if (!res.headersSent) redirect(res, '/?signin=failed');
      });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- the library

  /** A book as the Library page lists it. The long text stays behind until a book is opened. */
  function card(book, entry) {
    const cover = entry?.editionCover || book.cover;
    return {
      id: book.id,
      title: book.title,
      subtitle: book.subtitle || undefined,
      authors: book.authors,
      series: book.series || undefined,
      year: book.year ?? undefined,
      pages: entry?.editionPages || book.pages || undefined,
      audioSeconds: entry?.editionAudioSeconds || book.audioSeconds || undefined,
      rating: book.rating ?? undefined,
      genres: book.genres.length ? book.genres : undefined,
      cover: cover ? coverStamp(cover) : undefined,
      color: book.color || undefined,
      status: entry?.status,
      myRating: entry?.rating ?? undefined,
      added: entry?.added || undefined,
      finished: entry?.finished || undefined,
      owned: entry?.owned || undefined,
      format: entry?.format || undefined,
    };
  }

  function libraryPayload(userId) {
    const data = hardcover.library(userId);
    return {
      user: hardcover.describe(userId),
      sync: hardcover.syncState(userId),
      syncedAt: data?.syncedAt || null,
      warnings: data?.warnings || [],
      books: data ? data.books.map((b) => card(b, data.entryById.get(b.id))) : [],
      lists: data ? data.lists.map((l) => ({ id: l.id, name: l.name, description: l.description || undefined, ranked: l.ranked, bookIds: l.bookIds })) : [],
    };
  }

  function match(req, res, url, userId) {
    const data = hardcover.library(userId);
    const bookId = Number.parseInt(url.searchParams.get('book') || '', 10);
    const book = data?.byId.get(bookId);
    if (!book) return sendError(req, res, 404, 'That book is not in your Hardcover library. Sync it and try again.');
    const entry = data.entryById.get(bookId) || null;
    const all = url.searchParams.get('all') === '1';
    const queries = bookQueries({ ...book, editionTitle: entry?.editionTitle });
    const picked = pickQueries(queries, (q) => library.count({ q, all }));
    return sendJson(req, res, 200, {
      listLoaded: library.ready,
      book: {
        ...card(book, entry),
        description: book.description || undefined,
        contributors: book.contributors.length ? book.contributors : undefined,
        ratings: book.ratings || undefined,
        readers: book.readers || undefined,
        started: entry?.started || undefined,
        reads: entry?.reads || undefined,
        lists: data.lists.filter((l) => l.bookIds.includes(bookId)).map((l) => l.name),
        url: book.slug ? `${client.webUrl}/books/${encodeURIComponent(book.slug)}` : undefined,
      },
      ...picked,
    });
  }

  async function cover(req, res, url, userId) {
    const bookId = Number.parseInt(url.searchParams.get('book') || '', 10);
    const found = Number.isInteger(bookId) ? await hardcover.cover(userId, bookId) : null;
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=600' });
      res.end('No cover');
      return;
    }
    let size;
    try {
      size = fs.statSync(found.file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': found.type,
      'Content-Length': size,
      // The address carries a stamp of the cover, so this copy never goes stale.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(found.file).on('error', () => res.destroy()).pipe(res);
  }

  /** Returns true when the request was for this part of the API. The visitor is signed in. */
  function handle(req, res, url, session) {
    if (!url.pathname.startsWith('/api/hardcover/')) return false;
    const name = url.pathname.slice('/api/hardcover/'.length);
    const userId = hardcoverIdOf(session.account);
    const account = userId ? hardcover.describe(userId) : null;

    if (!hardcover.configured) {
      req.resume();
      sendError(req, res, 404, 'Hardcover is not set up on this server.');
      return true;
    }
    if (!account) {
      req.resume();
      sendJson(req, res, 409, { error: 'Sign in with Hardcover to see your library.', connect: true });
      return true;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (name === 'library') {
        if (hardcover.isStale(userId) && !account.signInAgain && !hardcover.syncState(userId).error) hardcover.startSync(userId);
        sendJson(req, res, 200, libraryPayload(userId));
      } else if (name === 'sync') {
        sendJson(req, res, 200, { sync: hardcover.syncState(userId), syncedAt: hardcover.library(userId)?.syncedAt || null });
      } else if (name === 'match') {
        match(req, res, url, userId);
      } else if (name === 'cover') {
        cover(req, res, url, userId).catch((err) => {
          console.error(err);
          if (!res.headersSent) res.writeHead(500).end();
          else res.destroy();
        });
      } else {
        sendError(req, res, 404, 'Not found.');
      }
      return true;
    }

    req.resume();
    if (req.method !== 'POST') {
      sendError(req, res, 405, 'Method not allowed.');
      return true;
    }
    if (!sameOrigin(req) || !/^application\/json/i.test(req.headers['content-type'] || '')) {
      sendError(req, res, 403, 'This is only accepted from the app itself.');
      return true;
    }
    if (name === 'sync') {
      if (account.signInAgain) sendJson(req, res, 409, { error: 'Sign in with Hardcover again to sync.', connect: true });
      else sendJson(req, res, 202, { sync: hardcover.startSync(userId) });
    } else if (name === 'disconnect') {
      hardcover.disconnect(userId)
        .then(() => {
          auth.closeAccount(session.account);
          auth.close(req, res, session);
          sendJson(req, res, 200, { ok: true });
        })
        .catch((err) => {
          console.error(err);
          sendError(req, res, 500, 'Something went wrong on the server.');
        });
    } else {
      sendError(req, res, 404, 'Not found.');
    }
    return true;
  }

  return { handle, handlePublic, redirectUri };
}
