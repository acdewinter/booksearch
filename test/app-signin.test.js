// The whole app, started the way `npm start` does, with the practice
// Hardcover behind it: who gets in, and what a signed-in visitor can reach.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeHardcover } from '../dev/fake-hardcover.js';
import { buildDatabase } from '../server/build.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/sample-list.txt', import.meta.url));

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** A browser's worth of behaviour: it keeps cookies and can follow redirects. */
function visitor(base) {
  const jar = new Map();
  async function request(url, options = {}) {
    const target = new URL(url, base);
    const headers = { ...(options.headers || {}) };
    // Cookies belong to the app; the practice Hardcover never sees them.
    if (target.origin === base && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(target, { ...options, headers, redirect: 'manual' });
    if (target.origin === base) {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        if (attrs.some((a) => /^\s*Max-Age=0$/i.test(a))) jar.delete(pair.slice(0, eq));
        else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    return res;
  }
  return {
    jar,
    get: (url) => request(url),
    json: async (url) => (await request(url)).json(),
    post: (url, body = {}, headers = {}) => request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
      body: JSON.stringify(body),
    }),
    /** Follow redirects to the end, as a browser would. Returns the last address. */
    async follow(url) {
      let next = new URL(url, base);
      for (let i = 0; i < 8; i += 1) {
        const res = await request(next);
        await res.arrayBuffer();
        if (res.status < 300 || res.status >= 400) return next;
        next = new URL(res.headers.get('location'), next);
      }
      throw new Error('too many redirects');
    },
  };
}

async function startApp(t, env = {}, fakeOptions = {}) {
  const fake = await startFakeHardcover(fakeOptions);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-app-'));
  buildDatabase(fixture, path.join(dataDir, 'library.db'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      HARDCOVER_CLIENT_ID: 'practice',
      HARDCOVER_CLIENT_SECRET: 'practice',
      HARDCOVER_API_URL: fake.url,
      HARDCOVER_WEB_URL: fake.url,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; ; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (i > 200) throw new Error(`The app did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 25));
  }

  async function library(v) {
    for (let i = 0; i < 400; i += 1) {
      const data = await v.json('/api/hardcover/library');
      if (data.syncedAt && !data.sync.running) return data;
      if (data.sync?.error) throw new Error(data.sync.error);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('The library was never synced.');
  }
  return { fake, base, dataDir, library, visit: () => visitor(base), output: () => output };
}

test('signing in with Hardcover opens the app and brings the library', async (t) => {
  const app = await startApp(t);
  const v = app.visit();

  // Before signing in: the page loads, nothing behind it does.
  assert.equal((await v.get('/')).status, 200);
  assert.deepEqual(await v.json('/api/session'), {
    authRequired: true, signedIn: false, methods: { password: false, username: false, hardcover: true }, account: null,
  });
  for (const url of ['/api/status', '/api/search?q=mort', '/api/irc/state', '/api/hardcover/library']) {
    assert.equal((await v.get(url)).status, 401, url);
  }

  const landed = await v.follow('/auth/hardcover?next=/%3Fv%3Dlibrary');
  assert.equal(`${landed.pathname}${landed.search}`, '/?v=library');
  const session = await v.json('/api/session');
  assert.equal(session.signedIn, true);
  assert.deepEqual(session.account, { kind: 'hardcover', hardcover: { id: 4242, username: 'reader', name: 'Practice Reader', signInAgain: false } });
  assert.equal((await v.get('/api/status')).status, 200);

  const data = await app.library(v);
  assert.equal(data.books.length, 12);
  const mort = data.books.find((b) => b.title === 'Mort');
  assert.deepEqual(
    { authors: mort.authors, series: mort.series, status: mort.status, myRating: mort.myRating },
    { authors: ['Terry Pratchett'], series: { name: 'Discworld', position: 4 }, status: 'read', myRating: 5 },
  );
  assert.equal(mort.description, undefined, 'the long text is only sent for the book that is opened');
  assert.deepEqual(data.lists.map((l) => l.name), ['Dragons, mostly', 'To find on audio']);

  // Picking a book: the search that finds it, and the same files the search page then shows.
  const match = await v.json(`/api/hardcover/match?book=${mort.id}`);
  assert.equal(match.best, 'pratchett mort');
  assert.match(match.book.description, /practice description/);
  assert.equal(match.queries[0].files, 2);
  const found = await v.json(`/api/search?q=${encodeURIComponent(match.best)}`);
  assert.deepEqual(found.groups[0].files.map((f) => f.c.slice(f.p)), ['Pratchett, Terry - Discworld 04 - Mort.epub', 'Pratchett, Terry - Discworld 04 - Mort.mobi']);
  assert.equal((await v.json('/api/hardcover/match?book=108')).best, null, 'a book that is not in the lists');
  assert.equal((await v.get('/api/hardcover/match?book=31337')).status, 404);

  const cover = await v.get(`/api/hardcover/cover?book=${mort.id}&v=${mort.cover}`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/png');
  assert.equal((await v.get('/api/hardcover/cover?book=31337')).status, 404);

  // Signing out ends it; another site cannot do that on the visitor's behalf.
  assert.equal((await v.post('/api/logout', {}, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await v.json('/api/session')).signedIn, true);
  assert.equal((await v.post('/api/logout')).status, 200);
  assert.equal((await v.get('/api/status')).status, 401);

  // The owner gets back in; the library is still there, no new sync needed.
  await v.follow('/auth/hardcover');
  assert.equal((await v.json('/api/hardcover/library')).books.length, 12);
});

test('a sign-in that was not started in this browser is turned away', async (t) => {
  const app = await startApp(t);
  const v = app.visit();

  // An answer nobody asked for.
  let landed = await v.follow(`/oauth/callback?code=abc&state=made-up&iss=${encodeURIComponent(app.fake.url)}`);
  assert.equal(landed.search, '?signin=expired');

  // An answer started by someone else: their state, but not their browser.
  const other = app.visit();
  const start = await other.get('/auth/hardcover');
  const approve = await fetch(start.headers.get('location'), { redirect: 'manual' });
  landed = await v.follow(approve.headers.get('location'));
  assert.equal(landed.search, '?signin=expired');
  assert.equal((await v.json('/api/session')).signedIn, false);

  // An answer that claims to come from another server.
  const mine = await v.get('/auth/hardcover');
  const back = new URL((await fetch(mine.headers.get('location'), { redirect: 'manual' })).headers.get('location'));
  back.searchParams.set('iss', 'https://not-hardcover.example');
  landed = await v.follow(back);
  assert.equal(landed.search, '?signin=failed');
  assert.equal((await v.json('/api/session')).signedIn, false);

  // The address to come back to cannot point away from the app.
  const away = app.visit();
  landed = await away.follow('/auth/hardcover?next=//elsewhere.example/');
  assert.equal(landed.origin, app.base);
});

test('saying no on Hardcover leaves the visitor signed out', async (t) => {
  const app = await startApp(t, {}, { deny: true });
  const v = app.visit();
  const landed = await v.follow('/auth/hardcover');
  assert.equal(landed.search, '?signin=denied');
  assert.equal((await v.json('/api/session')).signedIn, false);
});

test('only the allowed Hardcover accounts get in', async (t) => {
  const app = await startApp(t, { HARDCOVER_ALLOWED_USERS: 'adrian, someone-else' });
  const v = app.visit();
  const landed = await v.follow('/auth/hardcover');
  assert.equal(landed.search, '?signin=not-allowed');
  assert.equal((await v.json('/api/session')).signedIn, false);
  assert.equal(app.fake.stats.revoked, 1, 'the tokens that were handed over are given back');
});

test('with an app password, the password comes first and Hardcover is connected after', async (t) => {
  const app = await startApp(t, { APP_PASSWORD: 'open sesame' });
  const v = app.visit();
  assert.deepEqual((await v.json('/api/session')).methods, { password: true, username: false, hardcover: true });

  // Nobody owns the app yet, and a stranger cannot claim it past the password.
  assert.equal((await v.follow('/auth/hardcover')).search, '?signin=password-first');
  assert.equal((await v.json('/api/session')).signedIn, false);

  assert.equal((await v.post('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await v.post('/api/login', { password: 'open sesame' }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await v.post('/api/login', { password: 'open sesame' })).status, 200);
  assert.deepEqual((await v.json('/api/session')).account, { kind: 'local', hardcover: null });
  assert.equal((await v.get('/api/status')).status, 200);
  const before = await v.get('/api/hardcover/library');
  assert.equal(before.status, 409);
  assert.equal((await before.json()).connect, true);

  // Connecting keeps the same session and makes this account the owner.
  const cookie = v.jar.get('shelfmark_session');
  await v.follow('/auth/hardcover?next=/%3Fv%3Dlibrary');
  assert.equal(v.jar.get('shelfmark_session'), cookie);
  assert.equal((await v.json('/api/session')).account.hardcover.username, 'reader');
  assert.equal((await app.library(v)).books.length, 12);

  // From now on the owner can come straight in with Hardcover.
  const later = app.visit();
  await later.follow('/auth/hardcover');
  assert.equal((await later.json('/api/session')).signedIn, true);

  // Disconnecting deletes the copy and ends the sessions of that account.
  assert.equal((await v.post('/api/hardcover/disconnect')).status, 200);
  assert.equal((await v.json('/api/session')).signedIn, false);
  assert.equal((await later.json('/api/session')).signedIn, false);
  assert.equal(fs.existsSync(path.join(app.dataDir, 'hardcover', 'library-4242.json')), false);
});

test('with no sign-in set up the app is open, as before', async (t) => {
  const app = await startApp(t, { HARDCOVER_CLIENT_ID: '', HARDCOVER_CLIENT_SECRET: '' });
  const v = app.visit();
  assert.deepEqual(await v.json('/api/session'), {
    authRequired: false, signedIn: true, methods: { password: false, username: false, hardcover: false }, account: { kind: 'local', hardcover: null },
  });
  assert.equal((await v.get('/api/status')).status, 200);
  assert.equal((await v.get('/api/hardcover/library')).status, 404);
  assert.equal((await v.follow('/auth/hardcover')).search, '?signin=unavailable');
});
