// The Hardcover accounts connected to this app: their tokens, their synced
// libraries and the cover images, all kept in <data>/hardcover.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HardcoverError } from './client.js';
import { fetchLibrary } from './library.js';

const REFRESH_EARLY_MS = 5 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const COVER_MAX_BYTES = 6 * 1024 * 1024;
const COVER_TIMEOUT_MS = 15_000;
const COVER_PARALLEL = 6;
const COVER_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
const TYPE_OF = Object.fromEntries(Object.entries(COVER_TYPES).map(([type, ext]) => [ext, type]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** A short stamp for a cover address, so the browser fetches again when the cover changes. */
export const coverStamp = (url) => (url ? crypto.createHash('sha1').update(url).digest('hex').slice(0, 10) : '');

export class Hardcover {
  /**
   * @param {object} o
   * @param {import('./client.js').HardcoverClient} o.client
   * @param {string} o.dataDir
   * @param {{burst: number, perSecond: number} | null} [o.pace] how fast to ask. Hardcover allows a
   *        burst of 10 requests and then 60 a minute, per person; the default stays a little under that.
   */
  constructor(o) {
    this.client = o.client;
    this.dir = path.join(o.dataDir, 'hardcover');
    this.coverDir = path.join(this.dir, 'covers');
    this.accountsPath = path.join(this.dir, 'accounts.json');
    this.pace = o.pace === undefined ? { burst: 8, perSecond: 0.9 } : o.pace;
    this.buckets = new Map();    // user id -> { tokens, at }: what is left of the rate limit
    this.accounts = new Map();   // user id -> { id, username, name, tokens, connectedAt, signInAgain }
    this.libraries = new Map();  // user id -> the synced library, as stored
    this.syncs = new Map();      // user id -> { running, phase, count, error, finishedAt }
    this.refreshing = new Map(); // user id -> the refresh in flight
    this.coverJobs = new Map();  // file path -> the download in flight
    this.coverSlots = COVER_PARALLEL;
    this.coverQueue = [];
  }

  get configured() {
    return this.client.configured;
  }

  load() {
    if (!this.configured) return;
    fs.mkdirSync(this.coverDir, { recursive: true });
    const saved = readJson(this.accountsPath)?.users;
    if (saved && typeof saved === 'object') {
      for (const account of Object.values(saved)) {
        if (account && Number.isInteger(account.id)) this.accounts.set(account.id, account);
      }
    }
  }

  #saveAccounts() {
    writeJson(this.accountsPath, { users: Object.fromEntries(this.accounts) });
  }

  // ---------------------------------------------------------------- accounts

  /** What the page may know about a connected account. */
  describe(userId) {
    const a = this.accounts.get(userId);
    if (!a) return null;
    return { id: a.id, username: a.username, name: a.name, signInAgain: Boolean(a.signInAgain) };
  }

  /** Remember an account that just signed in. */
  connect(user, tokens) {
    const earlier = this.accounts.get(user.id);
    this.accounts.set(user.id, {
      id: user.id,
      username: user.username,
      name: user.name,
      tokens,
      connectedAt: earlier?.connectedAt || new Date().toISOString(),
      signInAgain: false,
    });
    this.#saveAccounts();
  }

  /** Forget an account: its tokens are revoked and its library is deleted. */
  async disconnect(userId) {
    const account = this.accounts.get(userId);
    if (!account) return;
    this.accounts.delete(userId);
    this.#saveAccounts();
    this.libraries.delete(userId);
    this.syncs.delete(userId);
    this.buckets.delete(userId);
    fs.rmSync(this.#libraryPath(userId), { force: true });
    await this.client.revoke(account.tokens?.refreshToken || account.tokens?.accessToken, account.tokens?.refreshToken ? 'refresh_token' : 'access_token');
  }

  #needsSignIn(userId) {
    const account = this.accounts.get(userId);
    if (!account) return;
    account.signInAgain = true;
    account.tokens = null;
    this.#saveAccounts();
  }

  /**
   * A token that works right now. Hardcover's refresh tokens can be used once,
   * so only one refresh runs at a time and its result is saved before anything else.
   */
  async #accessToken(userId, { force = false } = {}) {
    const account = this.accounts.get(userId);
    if (!account?.tokens?.accessToken) throw new HardcoverError('Sign in with Hardcover again to continue.', { code: 'sign_in_again' });
    const { tokens } = account;
    if (!force && tokens.expiresAt - Date.now() > REFRESH_EARLY_MS) return tokens.accessToken;
    if (!tokens.refreshToken) {
      if (!force && tokens.expiresAt > Date.now()) return tokens.accessToken;
      this.#needsSignIn(userId);
      throw new HardcoverError('Sign in with Hardcover again to continue.', { code: 'sign_in_again' });
    }

    let job = this.refreshing.get(userId);
    if (!job) {
      job = this.client.refresh(tokens.refreshToken)
        .then((fresh) => {
          const current = this.accounts.get(userId);
          if (current) {
            current.tokens = { ...fresh, refreshToken: fresh.refreshToken || tokens.refreshToken };
            this.#saveAccounts();
          }
          return fresh.accessToken;
        })
        .catch((err) => {
          if (err.signInAgain || err.status === 400 || err.status === 401) {
            this.#needsSignIn(userId);
            throw new HardcoverError('Sign in with Hardcover again to continue.', { code: 'sign_in_again' });
          }
          throw err;
        })
        .finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, job);
    }
    return job;
  }

  /** Wait until this account may ask Hardcover something again. */
  async #turn(userId) {
    if (!this.pace) return;
    const { burst, perSecond } = this.pace;
    let bucket = this.buckets.get(userId);
    if (!bucket) this.buckets.set(userId, bucket = { tokens: burst, at: Date.now() });
    const now = Date.now();
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
    bucket.at = now;
    bucket.tokens -= 1;
    if (bucket.tokens < 0) await sleep((-bucket.tokens / perSecond) * 1000);
  }

  /** Run a query as this account, getting a new token first if the old one ran out. */
  async gql(userId, query, variables) {
    await this.#turn(userId);
    const token = await this.#accessToken(userId);
    try {
      return await this.client.graphql(token, query, variables);
    } catch (err) {
      if (!err.unauthorized) throw err;
      const fresh = await this.#accessToken(userId, { force: true });
      return this.client.graphql(fresh, query, variables);
    }
  }

  // ----------------------------------------------------------------- library

  #libraryPath(userId) {
    return path.join(this.dir, `library-${userId}.json`);
  }

  /** The library as last synced, or null if it never was. */
  library(userId) {
    if (!this.libraries.has(userId)) {
      const saved = readJson(this.#libraryPath(userId));
      this.libraries.set(userId, saved && Array.isArray(saved.books) ? this.#index(saved) : null);
    }
    return this.libraries.get(userId);
  }

  #index(data) {
    Object.defineProperty(data, 'byId', { value: new Map(data.books.map((b) => [b.id, b])), enumerable: false });
    Object.defineProperty(data, 'entryById', { value: new Map(data.entries.map((e) => [e.bookId, e])), enumerable: false });
    return data;
  }

  syncState(userId) {
    return this.syncs.get(userId) || { running: false, phase: '', count: 0, error: null, finishedAt: null };
  }

  /** Whether the stored library is missing or old enough to fetch again. */
  isStale(userId) {
    const data = this.library(userId);
    return !data || Date.now() - Date.parse(data.syncedAt) > STALE_MS;
  }

  /** Fetch the library again in the background. Does nothing if that is already happening. */
  startSync(userId) {
    const current = this.syncs.get(userId);
    if (current?.running) return current;
    const state = { running: true, phase: 'Starting', count: 0, error: null, finishedAt: current?.finishedAt || null };
    this.syncs.set(userId, state);

    fetchLibrary((query, variables) => this.gql(userId, query, variables), {
      onProgress: ({ phase, count }) => {
        state.phase = phase;
        state.count = count;
      },
    })
      .then((result) => {
        if (!this.accounts.has(userId)) return; // disconnected while this ran
        const data = {
          version: 1,
          userId,
          syncedAt: new Date().toISOString(),
          books: result.books,
          entries: result.entries,
          lists: result.lists,
          warnings: result.warnings,
        };
        writeJson(this.#libraryPath(userId), data);
        this.libraries.set(userId, this.#index(data));
        const account = this.accounts.get(userId);
        if (account.username !== result.user.username || account.name !== result.user.name) {
          account.username = result.user.username;
          account.name = result.user.name;
          this.#saveAccounts();
        }
        console.log(`Hardcover: synced ${result.entries.length} books and ${result.lists.length} lists for @${result.user.username}.`);
      })
      .catch((err) => {
        state.error = err.code === 'insufficient_scope'
          ? `Hardcover did not let this app read your library${err.scope ? ` (missing scope: ${err.scope})` : ''}. Allow the scopes read:me:content, read:library and read:lists on the app's page at hardcover.app, then sign in again.`
          : err.message;
        if (!(err instanceof HardcoverError)) console.error(err);
        else console.error(`Hardcover: the sync failed: ${err.message}`);
      })
      .finally(() => {
        state.running = false;
        state.finishedAt = new Date().toISOString();
      });
    return state;
  }

  // ------------------------------------------------------------------ covers

  /** Where a book's cover comes from, preferring the edition this person picked. */
  coverUrl(userId, bookId) {
    const data = this.library(userId);
    const book = data?.byId.get(bookId);
    if (!book) return '';
    return data.entryById.get(bookId)?.editionCover || book.cover || '';
  }

  /**
   * The cover of a book in this person's library, fetched once and then kept.
   * Only addresses that came from Hardcover are ever fetched.
   * @returns {Promise<{file: string, type: string} | null>}
   */
  async cover(userId, bookId) {
    const url = this.coverUrl(userId, bookId);
    if (!url || !this.#coverAllowed(url)) return null;
    const stem = path.join(this.coverDir, `${bookId}-${coverStamp(url)}`);
    for (const ext of Object.keys(TYPE_OF)) {
      if (fs.existsSync(stem + ext)) return { file: stem + ext, type: TYPE_OF[ext] };
    }
    if (fs.existsSync(`${stem}.none`)) return null;

    let job = this.coverJobs.get(stem);
    if (!job) {
      job = this.#withCoverSlot(() => this.#downloadCover(url, stem)).finally(() => this.coverJobs.delete(stem));
      this.coverJobs.set(stem, job);
    }
    return job;
  }

  #coverAllowed(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) || u.hostname === 'localhost') {
      // Only the practice server in dev/ is reached this way.
      return this.client.apiUrl.startsWith('http://') && u.origin === new URL(this.client.apiUrl).origin;
    }
    return u.protocol === 'https:';
  }

  async #withCoverSlot(run) {
    if (this.coverSlots === 0) await new Promise((resolve) => this.coverQueue.push(resolve));
    else this.coverSlots -= 1;
    try {
      return await run();
    } finally {
      const next = this.coverQueue.shift();
      if (next) next();
      else this.coverSlots += 1;
    }
  }

  async #downloadCover(url, stem) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': this.client.userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
      });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = COVER_TYPES[type];
      if (!res.ok || !ext || Number(res.headers.get('content-length') || 0) > COVER_MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        // A cover that is not there is remembered, so it is not asked for on every visit.
        if (res.status === 404 || res.status === 403 || res.status === 410 || (res.ok && !ext)) fs.writeFileSync(`${stem}.none`, '');
        return null;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length || bytes.length > COVER_MAX_BYTES) return null;
      const tmp = `${stem}.tmp-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, stem + ext);
      return { file: stem + ext, type };
    } catch {
      return null; // try again next time
    }
  }
}
