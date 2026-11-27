// The collection through the web API, with the whole app running: tying
// files to titles, looking books up on Hardcover, and what a paired reader
// app may fetch and report.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startApp } from '../dev/app-harness.js';
import { makeEpub } from '../dev/make-epub.js';

const MORT_FILE = 'Pratchett, Terry - Discworld 04 - Mort.epub';

async function signedIn(t, env = {}, fakeOptions = {}, start = '/auth/hardcover') {
  const app = await startApp(t, env, fakeOptions);
  const downloads = path.join(app.dataDir, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const v = app.visit();
  await v.follow(start);
  await app.library(v);
  const put = (name, data) => fs.writeFileSync(path.join(downloads, name), data);
  return { app, v, put, downloads };
}

/** The reader app: no cookies, a token in every request. */
function device(base, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return {
    get: (url, extra = {}) => fetch(new URL(url, base), { headers: { ...headers, ...extra } }),
    json: async (url) => (await fetch(new URL(url, base), { headers })).json(),
    post: (url, body) => fetch(new URL(url, base), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

test('a file is tied to a book from the library and shows up in the collection', async (t) => {
  const { v, put } = await signedIn(t);
  put(MORT_FILE, makeEpub({ title: 'Mort', author: 'Pratchett, Terry' }));
  put('unknown-thing.epub', makeEpub({ title: 'Piranesi', author: 'Clarke, Susanna' }));

  let data = await v.json('/api/collection');
  assert.deepEqual(data.books, []);
  assert.deepEqual(data.loose.map((f) => f.name).sort(), [MORT_FILE, 'unknown-thing.epub']);
  assert.deepEqual(data.can, { hardcover: true, library: true, catalog: false, connected: true });

  // The file says what it is, and the library has that book.
  const info = await v.json(`/api/collection/describe?path=${encodeURIComponent(MORT_FILE)}`);
  assert.equal(info.embedded.title, 'Mort');
  assert.deepEqual(info.guesses.map((g) => g.title), ['Mort']);
  const mortId = info.guesses[0].id;

  const tied = await v.post('/api/collection/attach', { path: MORT_FILE, hardcoverId: mortId });
  assert.equal(tied.status, 200);
  data = await v.json('/api/collection');
  assert.equal(data.books.length, 1);
  const [book] = data.books;
  assert.deepEqual(
    { title: book.title, authors: book.authors, series: book.series, hardcoverId: book.hardcoverId, formats: book.files.map((f) => f.format) },
    { title: 'Mort', authors: ['Terry Pratchett'], series: { name: 'Discworld', position: 4 }, hardcoverId: mortId, formats: ['epub'] },
  );
  assert.deepEqual((await v.json('/api/collection/owned')).owned, { [mortId]: { id: book.id, formats: ['epub'] } });

  const cover = await v.get(`/api/collection/cover?book=${book.id}&v=${book.cover}`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/png');

  // Without the search scope only the library is looked in; a book outside it cannot be picked by id.
  const looked = await v.json('/api/collection/lookup?q=piranesi+clarke');
  assert.deepEqual({ library: looked.library, catalog: looked.catalog, can: looked.can.catalog }, { library: [], catalog: [], can: false });
  assert.equal((await v.post('/api/collection/attach', { path: 'unknown-thing.epub', hardcoverId: 203 })).status, 404);

  // It can still be added with what the file says about itself.
  assert.equal((await v.post('/api/collection/attach', { path: 'unknown-thing.epub' })).status, 200);
  data = await v.json('/api/collection');
  assert.deepEqual(data.books.map((b) => [b.title, b.authors[0]]).sort(), [['Mort', 'Terry Pratchett'], ['Piranesi', 'Susanna Clarke']]);
  assert.deepEqual(data.loose, []);

  // Taking a title out leaves its file in the folder, loose again.
  const piranesi = data.books.find((b) => b.title === 'Piranesi');
  assert.equal((await v.post('/api/collection/remove', { book: piranesi.id })).status, 200);
  assert.deepEqual((await v.json('/api/collection')).loose.map((f) => f.name), ['unknown-thing.epub']);

  // Changes are only taken from the app's own page.
  assert.equal((await v.post('/api/collection/remove', { book: book.id }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await v.post('/api/collection/attach', { path: '../auth.json' })).status, 404);
});

test('with the search scope, any book on Hardcover can be tied to a file', async (t) => {
  const { v, put, app } = await signedIn(t, {}, {}, '/auth/hardcover?catalog=1');
  assert.equal((await v.json('/api/session')).account.hardcover.catalog, true);
  put('unknown-thing.epub', makeEpub({ title: 'Piranesi', author: 'Clarke, Susanna' }));

  const looked = await v.json('/api/collection/lookup?q=piranesi+clarke');
  assert.equal(looked.can.catalog, true);
  assert.deepEqual(looked.catalog.map((b) => [b.id, b.title, b.authors[0], b.inLibrary]), [[203, 'Piranesi', 'Susanna Clarke', false]]);
  // A book that is in the library is listed once, with the library's books.
  const dragons = await v.json('/api/collection/lookup?q=nice+dragons+finish+last');
  assert.deepEqual(dragons.library.map((b) => b.title), ['Nice Dragons Finish Last']);
  assert.ok(!dragons.catalog.some((b) => b.title === 'Nice Dragons Finish Last'));

  const lookupCover = await v.get('/api/collection/lookup-cover?id=203');
  assert.equal(lookupCover.status, 200);
  assert.equal((await v.get('/api/collection/lookup-cover?id=999')).status, 404);

  assert.equal((await v.post('/api/collection/attach', { path: 'unknown-thing.epub', hardcoverId: 203 })).status, 200);
  const [book] = (await v.json('/api/collection')).books;
  assert.deepEqual({ title: book.title, hardcoverId: book.hardcoverId, year: book.year }, { title: 'Piranesi', hardcoverId: 203, year: 2020 });
  assert.equal((await v.get(`/api/collection/cover?book=${book.id}`)).status, 200);

  // Signing in again the ordinary way keeps the scope that was granted before.
  await v.follow('/auth/hardcover');
  assert.equal((await v.json('/api/session')).account.hardcover.catalog, true);
  assert.match(app.fake.stats.lastQuery, /./);
});

test('asking for the search scope when the Hardcover app does not allow it says so', async (t) => {
  const { v } = await signedIn(t, {}, { noCatalog: true });
  const landed = await v.follow('/auth/hardcover?catalog=1&next=/%3Fv%3Dcollection');
  assert.equal(landed.search, '?signin=catalog-scope');
  assert.equal((await v.json('/api/session')).signedIn, true, 'the sign-in that was there stays');
  assert.equal((await v.json('/api/session')).account.hardcover.catalog, false);
});

test('the reader app is paired with a code and reaches only the collection', async (t) => {
  const { app, v, put } = await signedIn(t);
  const epub = makeEpub({ title: 'Mort', author: 'Pratchett, Terry', chapters: 3 });
  put(MORT_FILE, epub);
  const info = await v.json(`/api/collection/describe?path=${encodeURIComponent(MORT_FILE)}`);
  await v.post('/api/collection/attach', { path: MORT_FILE, hardcoverId: info.guesses[0].id });

  // Nothing without a token; a made-up token or code gets nowhere.
  assert.equal((await device(app.base).get('/api/collection')).status, 401);
  assert.equal((await device(app.base, 'made-up').get('/api/collection')).status, 401);
  assert.equal((await device(app.base).post('/api/pair', { code: 'AAAA-AAAA', name: 'Phone' })).status, 401);
  assert.equal((await device(app.base).post('/api/devices/code', {})).status, 401, 'a code is only made for someone signed in');

  const made = await (await v.post('/api/devices/code')).json();
  assert.match(made.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const paired = await (await device(app.base).post('/api/pair', { code: made.code.toLowerCase(), name: 'OnePlus 13' })).json();
  assert.ok(paired.token.length > 30);
  assert.equal(paired.device.name, 'OnePlus 13');
  assert.equal((await device(app.base).post('/api/pair', { code: made.code, name: 'Again' })).status, 401, 'a code works once');

  const phone = device(app.base, paired.token);
  const session = await phone.json('/api/session');
  assert.equal(session.signedIn, true);
  assert.equal(session.device.name, 'OnePlus 13');

  const { books } = await phone.json('/api/collection');
  assert.equal(books.length, 1);
  const file = books[0].files[0];
  assert.equal(file.format, 'epub');
  assert.equal(file.size, epub.length);

  // The file, whole and in parts (a download that broke off continues).
  const whole = await phone.get(`/api/collection/file?id=${file.id}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'application/epub+zip');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), epub);
  const rest = await phone.get(`/api/collection/file?id=${file.id}`, { Range: 'bytes=100-' });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('content-range'), `bytes 100-${epub.length - 1}/${epub.length}`);
  assert.deepEqual(Buffer.from(await rest.arrayBuffer()), epub.subarray(100));
  assert.equal((await phone.get(`/api/collection/file?id=${file.id}`, { Range: `bytes=${epub.length}-` })).status, 416);
  assert.equal((await phone.get('/api/collection/file?id=f999')).status, 404);
  assert.equal((await phone.get(`/api/collection/cover?book=${books[0].id}`)).status, 200);

  // Progress goes up from the phone and is seen on the web.
  const sent = await phone.post('/api/collection/progress', { file: file.id, fraction: 0.42, updatedAt: Date.now() - 1000, locator: { spine: 1, inner: 0.3 } });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).progress.device, 'OnePlus 13');
  assert.equal((await phone.json(`/api/collection/progress?file=${file.id}`)).progress.fraction, 0.42);
  const seen = (await v.json('/api/collection')).books[0].progress;
  assert.deepEqual({ fraction: seen.fraction, device: seen.device, file: seen.file }, { fraction: 0.42, device: 'OnePlus 13', file: file.id });

  // Everything else is closed to it.
  for (const url of ['/api/status', '/api/search?q=mort', '/api/irc/state', '/api/hardcover/library', '/api/devices', '/api/collection/lookup?q=mort', `/api/collection/describe?path=${encodeURIComponent(MORT_FILE)}`]) {
    assert.equal((await phone.get(url)).status, 403, url);
  }
  assert.equal((await phone.post('/api/collection/remove', { book: books[0].id })).status, 403);
  assert.equal((await phone.post('/api/irc/request', { commands: ['!Bsk x.epub'] })).status, 403);
  assert.equal((await phone.post('/api/logout', {})).status, 200, 'signing out is harmless: a device has no session cookie');
  assert.equal((await phone.get('/api/collection')).status, 200);

  // A phone that disconnects takes itself off the list.
  const second = await (await v.post('/api/devices/code')).json();
  const other = device(app.base, (await (await device(app.base).post('/api/pair', { code: second.code, name: 'Old phone' })).json()).token);
  assert.equal((await v.json('/api/devices')).devices.length, 2);
  assert.equal((await other.post('/api/devices/leave', {})).status, 200);
  assert.equal((await other.get('/api/collection')).status, 401);
  assert.equal((await v.post('/api/devices/leave', {})).status, 405, 'only a device can leave');

  // It is listed, and removing it ends its access at once.
  const listed = await v.json('/api/devices');
  assert.deepEqual(listed.devices.map((d) => d.name), ['OnePlus 13']);
  assert.equal((await v.post('/api/devices/remove', { id: listed.devices[0].id })).status, 200);
  assert.equal((await phone.get('/api/collection')).status, 401);
  assert.deepEqual((await v.json('/api/devices')).devices, []);
});

test('wrong pairing codes are slowed down, and an open app needs no code', async (t) => {
  const { app } = await signedIn(t);
  const stranger = device(app.base);
  let last;
  for (let i = 0; i < 9; i += 1) last = await stranger.post('/api/pair', { code: 'ZZZZ-ZZZZ' });
  assert.equal(last.status, 429);

  const open = await startApp(t, { HARDCOVER_CLIENT_ID: '', HARDCOVER_CLIENT_SECRET: '' });
  assert.equal((await device(open.base).get('/api/collection')).status, 200);
  assert.equal((await device(open.base).post('/api/pair', { code: 'ZZZZ-ZZZZ' })).status, 409);
});
