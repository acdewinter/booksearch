import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Auth, SESSION_COOKIE, hardcoverIdOf, parseCookies } from '../server/auth.js';

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const make = () => {
    const auth = new Auth({ dataDir, ...options });
    auth.load();
    return auth;
  };
  return { dataDir, make, auth: make() };
}

/** A response that only remembers its headers. */
function fakeRes() {
  const headers = {};
  return { headers, getHeader: (name) => headers[name], setHeader: (name, value) => { headers[name] = value; } };
}

const reqWith = (cookie, extra = {}) => ({ headers: { cookie, ...extra }, socket: {} });
const cookieFrom = (res) => res.headers['Set-Cookie'][0].split(';')[0];

const adrian = { id: 7, username: 'Adrian' };
const stranger = { id: 8, username: 'someone' };

test('cookies are read by name', () => {
  assert.deepEqual(parseCookies('a=1; shelfmark_session=abc; b="two"'), { a: '1', shelfmark_session: 'abc', b: 'two' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('without any sign-in set up everyone is let in', (t) => {
  const { auth } = setup(t);
  assert.equal(auth.required, false);
  assert.equal(auth.session(reqWith('')).account, 'local');
});

test('a session lasts across restarts and ends when closed', (t) => {
  const { auth, make } = setup(t, { password: 'secret' });
  assert.equal(auth.session(reqWith('')), null);

  const res = fakeRes();
  auth.open(reqWith(''), res, 'local');
  const cookie = cookieFrom(res);
  assert.match(res.headers['Set-Cookie'][0], /HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.equal(auth.session(reqWith(cookie)).account, 'local');
  assert.equal(auth.session(reqWith(`${SESSION_COOKIE}=made-up`)), null);

  const again = make();
  const session = again.session(reqWith(cookie));
  assert.equal(session.account, 'local');
  assert.ok(again.setAccount(session, 'hc:7'));
  assert.equal(hardcoverIdOf(again.session(reqWith(cookie)).account), 7);

  again.close(reqWith(cookie), fakeRes(), session);
  assert.equal(again.session(reqWith(cookie)), null);
  assert.equal(make().session(reqWith(cookie)), null);
});

test('the cookie is marked secure behind https', (t) => {
  const { auth } = setup(t, { password: 'secret' });
  const res = fakeRes();
  auth.open(reqWith('', { 'x-forwarded-proto': 'https' }), res, 'local');
  assert.match(res.headers['Set-Cookie'][0], /; Secure$/);
});

test('the password is checked, and guessing is slowed down', (t) => {
  const { auth } = setup(t, { password: 'secret', username: 'me' });
  assert.equal(auth.checkPassword('1.1.1.1', 'me', 'secret'), true);
  assert.equal(auth.checkPassword('1.1.1.1', 'you', 'secret'), false);
  for (let i = 0; i < 8; i += 1) assert.equal(auth.checkPassword('2.2.2.2', 'me', 'wrong'), false);
  assert.ok(auth.lockedFor('2.2.2.2') > 0);
  assert.equal(auth.lockedFor('1.1.1.1'), 0, 'another address is not held back');
});

test('the first Hardcover account to sign in owns the app', (t) => {
  const { auth, make } = setup(t, { hardcover: true });
  assert.deepEqual(auth.decide(adrian), { ok: true, claim: true });
  auth.claim(adrian);
  assert.deepEqual(auth.decide(adrian), { ok: true, claim: false });
  assert.deepEqual(auth.decide(stranger), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(make().decide(stranger), { ok: false, reason: 'not-allowed' }, 'the owner is remembered');
});

test('with an app password, claiming the app needs the password first', (t) => {
  const { auth } = setup(t, { hardcover: true, password: 'secret' });
  assert.deepEqual(auth.decide(stranger), { ok: false, reason: 'password-first' });
  assert.deepEqual(auth.decide(adrian, { signedIn: true }), { ok: true, claim: true });
  auth.claim(adrian);
  assert.deepEqual(auth.decide(adrian), { ok: true, claim: false });
  assert.deepEqual(auth.decide(stranger), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(auth.decide(stranger, { signedIn: true }), { ok: true, claim: false }, 'someone with the password may connect their own account');
});

test('a list of allowed usernames replaces the owner rule', (t) => {
  const { auth } = setup(t, { hardcover: true, allowedUsers: ['adrian'] });
  assert.deepEqual(auth.decide(adrian), { ok: true, claim: false });
  assert.deepEqual(auth.decide(stranger), { ok: false, reason: 'not-allowed' });
});
