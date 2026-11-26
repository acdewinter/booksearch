// Who may use the app.
//
// A visitor signs in with the app password, with a Hardcover account, or
// both ways are offered. Either way the browser gets a cookie that names a
// session kept here; nothing about the person is stored in the cookie itself.
//
//   account "local"    signed in with the password (or no sign-in is set up)
//   account "hc:123"   signed in as Hardcover user 123

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'shelfmark_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_MS = 60 * 60 * 1000; // how often "last seen" is written to disk
const MAX_SESSIONS = 500;
const MAX_BODY = 64 * 1024;

const LOGIN_TRIES = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** "a=1; b=two" -> { a: '1', b: 'two' } */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

/** Add a Set-Cookie header without dropping one that is already there. */
export function setCookie(res, name, value, { maxAgeSec, path: cookiePath = '/', secure = false } = {}) {
  const parts = [`${name}=${value}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  if (secure) parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

/** Read a small JSON body. Rejects with an Error whose message is fit to show. */
export function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new Error('The request could not be read.'));
      }
    });
    req.on('error', reject);
  });
}

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

export const hardcoverAccount = (userId) => `hc:${userId}`;

/** "hc:123" -> 123; anything else -> null */
export function hardcoverIdOf(account) {
  const m = /^hc:(\d+)$/.exec(account || '');
  return m ? Number(m[1]) : null;
}

export class Auth {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {string} [o.password]       the app password; empty = no password sign-in
   * @param {string} [o.username]       if set, this username is required with the password
   * @param {boolean} [o.hardcover]     whether signing in with Hardcover is set up
   * @param {string[]} [o.allowedUsers] Hardcover usernames (lower case) that may sign in
   * @param {string} [o.appUrl]         the app's public address, if it was configured
   */
  constructor(o) {
    this.sessionsPath = path.join(o.dataDir, 'sessions.json');
    this.statePath = path.join(o.dataDir, 'auth.json');
    this.password = o.password || '';
    this.username = o.username || '';
    this.hardcover = Boolean(o.hardcover);
    this.allowedUsers = new Set(o.allowedUsers || []);
    this.appUrl = o.appUrl || '';
    this.sessions = new Map(); // hash of the cookie value -> { account, createdAt, seenAt }
    this.owner = null;         // { id, username }: the Hardcover account that owns this app
    this.tries = new Map();    // address -> { count, resetAt }
    this.savedAt = 0;
  }

  /** Whether anyone has to sign in at all. */
  get required() {
    return Boolean(this.password) || this.hardcover;
  }

  get methods() {
    return { password: Boolean(this.password), username: Boolean(this.password && this.username), hardcover: this.hardcover };
  }

  load() {
    const now = Date.now();
    const saved = readJson(this.sessionsPath)?.sessions;
    if (saved && typeof saved === 'object') {
      for (const [id, s] of Object.entries(saved)) {
        if (s && typeof s.account === 'string' && now - (s.seenAt || 0) < SESSION_MS) this.sessions.set(id, s);
      }
    }
    const owner = readJson(this.statePath)?.owner;
    if (owner && Number.isInteger(owner.id)) this.owner = { id: owner.id, username: String(owner.username || '') };
  }

  #save() {
    this.savedAt = Date.now();
    writeJson(this.sessionsPath, { sessions: Object.fromEntries(this.sessions) });
  }

  /** Write "last seen" times that are only in memory. */
  flush() {
    if (this.sessions.size || fs.existsSync(this.sessionsPath)) this.#save();
  }

  // ---------------------------------------------------------------- sessions

  /** Whether the visitor reached the app over https (directly or through a proxy). */
  isSecure(req) {
    if (this.appUrl) return this.appUrl.startsWith('https:');
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto ? proto === 'https' : Boolean(req.socket?.encrypted);
  }

  /**
   * The session this request belongs to, or null when the visitor has to sign in.
   * Without any sign-in set up everyone shares one open session.
   */
  session(req) {
    if (!this.required) return { account: 'local', open: true };
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const id = hashToken(token);
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seenAt > SESSION_MS) {
      this.sessions.delete(id);
      this.#save();
      return null;
    }
    s.seenAt = now;
    if (now - this.savedAt > TOUCH_MS) this.#save();
    return { id, account: s.account, createdAt: s.createdAt };
  }

  /** Start a session and hand the browser its cookie. */
  open(req, res, account) {
    const token = randomToken();
    const now = Date.now();
    this.sessions.set(hashToken(token), { account, createdAt: now, seenAt: now });
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
      for (const [id] of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(id);
    }
    this.#save();
    setCookie(res, SESSION_COOKIE, token, { maxAgeSec: SESSION_MS / 1000, secure: this.isSecure(req) });
  }

  /** Change which account a session belongs to (a password session that connects Hardcover). */
  setAccount(session, account) {
    const s = session?.id && this.sessions.get(session.id);
    if (!s) return false;
    s.account = account;
    this.#save();
    return true;
  }

  close(req, res, session) {
    if (session?.id && this.sessions.delete(session.id)) this.#save();
    setCookie(res, SESSION_COOKIE, '', { maxAgeSec: 0, secure: this.isSecure(req) });
  }

  /** End every session of one account, such as after disconnecting Hardcover. */
  closeAccount(account) {
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.account === account) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  // ---------------------------------------------------------------- password

  /** How long this address has to wait before another password attempt, in seconds. 0 = go ahead. */
  lockedFor(address) {
    const t = this.tries.get(address);
    if (!t) return 0;
    const now = Date.now();
    if (now >= t.resetAt) {
      this.tries.delete(address);
      return 0;
    }
    return t.count >= LOGIN_TRIES ? Math.ceil((t.resetAt - now) / 1000) : 0;
  }

  checkPassword(address, username, password) {
    if (!this.password) return false;
    const userOk = this.username ? safeEqual(username ?? '', this.username) : true;
    const ok = safeEqual(password ?? '', this.password) && userOk;
    if (ok) {
      this.tries.delete(address);
      return true;
    }
    const now = Date.now();
    if (this.tries.size > 5000) this.tries.clear();
    const t = this.tries.get(address);
    if (t && now < t.resetAt) t.count += 1;
    else this.tries.set(address, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }

  // --------------------------------------------------------------- hardcover

  /**
   * Whether a Hardcover account may sign in.
   *
   *   - Someone already signed in with the password may connect any account.
   *   - With HARDCOVER_ALLOWED_USERS set, only those usernames get in.
   *   - Otherwise only the owner does. The owner is the first account to sign
   *     in; with an app password set, that first time needs the password too,
   *     so a stranger cannot claim an app that was meant to be private.
   *
   * @param {{id: number, username: string}} user
   * @param {{signedIn?: boolean}} [o] whether the visitor already has a session
   * @returns {{ok: true, claim: boolean} | {ok: false, reason: 'not-allowed' | 'password-first'}}
   */
  decide(user, { signedIn = false } = {}) {
    const claim = !this.owner && this.allowedUsers.size === 0;
    if (signedIn) return { ok: true, claim };
    if (this.allowedUsers.size) {
      const name = String(user.username || '').toLowerCase();
      return this.allowedUsers.has(name) ? { ok: true, claim: false } : { ok: false, reason: 'not-allowed' };
    }
    if (this.owner) return this.owner.id === user.id ? { ok: true, claim: false } : { ok: false, reason: 'not-allowed' };
    if (this.password) return { ok: false, reason: 'password-first' };
    return { ok: true, claim: true };
  }

  claim(user) {
    this.owner = { id: user.id, username: String(user.username || '') };
    writeJson(this.statePath, { owner: this.owner });
  }
}

/**
 * The sign-in endpoints that do not need a session: who am I, password sign-in, sign out.
 *
 * @param {Auth} auth
 * @param {object} http helpers from the web server: sendJson, sendError, sameOrigin
 * @param {(session: object) => object} describe extra facts about the signed-in account
 */
export function createAuthRoutes(auth, { sendJson, sendError, sameOrigin }, describe = () => ({})) {
  const fromApp = (req) => sameOrigin(req) && /^application\/json/i.test(req.headers['content-type'] || '');

  /** Returns true when the request was for this part of the API. */
  function handle(req, res, url, session) {
    const p = url.pathname;

    if (p === '/api/session' && req.method === 'GET') {
      sendJson(req, res, 200, {
        authRequired: auth.required,
        signedIn: Boolean(session),
        methods: auth.methods,
        account: session ? { kind: hardcoverIdOf(session.account) ? 'hardcover' : 'local', ...describe(session) } : null,
      });
      return true;
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (!fromApp(req)) {
        req.resume();
        sendError(req, res, 403, 'This is only accepted from the app itself.');
        return true;
      }
      if (!auth.methods.password) {
        req.resume();
        sendError(req, res, 404, 'Signing in with a password is not set up.');
        return true;
      }
      const address = req.socket.remoteAddress || 'unknown';
      const wait = auth.lockedFor(address);
      if (wait) {
        req.resume();
        res.setHeader('Retry-After', String(wait));
        sendError(req, res, 429, `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`);
        return true;
      }
      readJsonBody(req)
        .then((body) => {
          if (!auth.checkPassword(address, String(body.username ?? ''), String(body.password ?? ''))) {
            sendError(req, res, 401, auth.methods.username ? 'That username or password is not right.' : 'That password is not right.');
            return;
          }
          auth.open(req, res, 'local');
          sendJson(req, res, 200, { ok: true });
        })
        .catch((err) => sendError(req, res, 400, err.message));
      return true;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      req.resume();
      if (!fromApp(req)) {
        sendError(req, res, 403, 'This is only accepted from the app itself.');
        return true;
      }
      auth.close(req, res, session);
      sendJson(req, res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { handle };
}
