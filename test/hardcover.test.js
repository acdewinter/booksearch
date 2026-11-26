// The Hardcover side against the practice server in dev/fake-hardcover.js:
// signing in, keeping the tokens fresh, and reading a library.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startFakeHardcover } from '../dev/fake-hardcover.js';
import { HardcoverClient, pkcePair } from '../server/hardcover/client.js';
import { normalizeBook, normalizeEntry, renderFields } from '../server/hardcover/library.js';
import { Hardcover } from '../server/hardcover/service.js';

const REDIRECT = 'http://localhost:3000/oauth/callback';

async function setup(t, { fake: fakeOptions = {}, scopes } = {}) {
  const fake = await startFakeHardcover(fakeOptions);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-hc-'));
  const client = new HardcoverClient({ clientId: 'practice', clientSecret: 'practice', apiUrl: fake.url, webUrl: fake.url, scopes });
  const make = () => {
    const hardcover = new Hardcover({ client, dataDir, pace: null });
    hardcover.load();
    return hardcover;
  };
  t.after(async () => {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Go through the sign-in the way a browser would, and come back with tokens. */
  async function signIn(c = client) {
    const { verifier, challenge } = pkcePair();
    const res = await fetch(c.authorizeUrl({ state: 'state-1', challenge, redirectUri: REDIRECT }), { redirect: 'manual' });
    const back = new URL(res.headers.get('location'));
    assert.equal(back.searchParams.get('state'), 'state-1');
    assert.equal(back.searchParams.get('iss'), c.issuer);
    return { code: back.searchParams.get('code'), verifier };
  }

  async function synced(hardcover) {
    hardcover.startSync(fake.user.id);
    while (hardcover.syncState(fake.user.id).running) await new Promise((r) => setTimeout(r, 10));
    return hardcover.syncState(fake.user.id);
  }

  return { fake, client, make, signIn, synced, dataDir };
}

test('the code from the callback is traded for tokens, once', async (t) => {
  const { client, signIn } = await setup(t);
  const { code, verifier } = await signIn();
  const tokens = await client.exchangeCode({ code, verifier, redirectUri: REDIRECT });
  assert.match(tokens.accessToken, /^hc_at_/);
  assert.match(tokens.refreshToken, /^hc_rt_/);
  assert.ok(tokens.expiresAt > Date.now());
  assert.deepEqual((await client.graphql(tokens.accessToken, 'query Me { me { id username name } }')).me[0].username, 'reader');

  await assert.rejects(client.exchangeCode({ code, verifier, redirectUri: REDIRECT }), (err) => err.code === 'invalid_grant');
});

test('a code is useless without the secret it was started with', async (t) => {
  const { client, signIn } = await setup(t);
  const { code } = await signIn();
  await assert.rejects(client.exchangeCode({ code, verifier: 'not-the-verifier', redirectUri: REDIRECT }), /did not accept the sign-in/);

  const wrongSecret = new HardcoverClient({ clientId: 'practice', clientSecret: 'nope', apiUrl: client.apiUrl, webUrl: client.webUrl });
  const second = await signIn();
  await assert.rejects(wrongSecret.exchangeCode({ ...second, redirectUri: REDIRECT }), (err) => err.code === 'invalid_client');
});

test('a library is read with its statuses, series and lists', async (t) => {
  const { fake, client, make, signIn, synced } = await setup(t);
  const hardcover = make();
  hardcover.connect(fake.user, await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT }));
  assert.equal(hardcover.isStale(fake.user.id), true);

  const state = await synced(hardcover);
  assert.equal(state.error, null);
  const data = hardcover.library(fake.user.id);
  assert.equal(data.entries.length, 10);
  assert.equal(data.books.length, 12, 'two books are only on a list');
  assert.equal(hardcover.isStale(fake.user.id), false);

  const mort = data.byId.get(104);
  assert.deepEqual(
    { title: mort.title, authors: mort.authors, series: mort.series, year: mort.year, genres: mort.genres },
    { title: 'Mort', authors: ['Terry Pratchett'], series: { name: 'Discworld', position: 4 }, year: 1987, genres: ['Fantasy', 'Humor'] },
  );
  const entry = data.entryById.get(104);
  assert.deepEqual({ status: entry.status, rating: entry.rating, format: entry.format }, { status: 'read', rating: 5, format: 'audio' });
  assert.equal(data.entryById.get(102).status, 'reading');

  assert.deepEqual(data.lists.map((l) => [l.name, l.ranked, l.isPrivate, l.bookIds]), [
    ['Dragons, mostly', true, false, [102, 101, 103]],
    ['To find on audio', false, true, [111, 112, 105]],
  ]);

  // Kept on disk: a new start has the library without asking Hardcover again.
  const queries = fake.stats.queries;
  assert.equal(make().library(fake.user.id).books.length, 12);
  assert.equal(fake.stats.queries, queries);
});

test('a token that ran out is replaced, and the new refresh token is the one kept', async (t) => {
  const { fake, client, make, signIn, synced, dataDir } = await setup(t);
  const hardcover = make();
  const first = await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT });
  hardcover.connect(fake.user, first);

  fake.expireTokens(); // Hardcover says no, although the token looked fine from here
  assert.equal((await synced(hardcover)).error, null);
  assert.equal(fake.stats.refreshes, 1, 'several queries, one refresh');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'hardcover', 'accounts.json'), 'utf8')).users[fake.user.id].tokens;
  assert.notEqual(saved.refreshToken, first.refreshToken);

  // A second run uses the new pair; the spent one is never sent again.
  fake.expireTokens();
  assert.equal((await synced(make())).error, null);
  assert.equal(fake.stats.refreshes, 2);
});

test('when the session is gone for good, the person is asked to sign in again', async (t) => {
  const { fake, client, make, signIn, synced } = await setup(t);
  const hardcover = make();
  const tokens = await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT });
  hardcover.connect(fake.user, tokens);
  await client.revoke(tokens.refreshToken);

  const state = await synced(hardcover);
  assert.match(state.error, /Sign in with Hardcover again/);
  assert.equal(hardcover.describe(fake.user.id).signInAgain, true);
});

test('a field Hardcover no longer has is left out instead of failing the sync', async (t) => {
  const { fake, client, make, signIn, synced } = await setup(t, { fake: { missingFields: ['books.cached_tags', 'user_books.has_review'] } });
  const hardcover = make();
  hardcover.connect(fake.user, await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT }));
  assert.equal((await synced(hardcover)).error, null);
  assert.equal(hardcover.library(fake.user.id).entries.length, 10);
  assert.doesNotMatch(fake.stats.lastQuery, /cached_tags|has_review/);
  assert.match(fake.stats.lastQuery, /cached_contributors/);
});

test('being told to slow down is waited out', async (t) => {
  const { fake, client, make, signIn, synced } = await setup(t, { fake: { throttleOnce: true } });
  const hardcover = make();
  hardcover.connect(fake.user, await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT }));
  assert.equal((await synced(hardcover)).error, null);
});

test('a missing scope is explained', async (t) => {
  const { fake, client, make, signIn, synced } = await setup(t, { scopes: 'read:me:content' });
  const hardcover = make();
  hardcover.connect(fake.user, await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT }));
  assert.match((await synced(hardcover)).error, /missing scope: read:library/);
});

test('covers are fetched once, and only for books in the library', async (t) => {
  const { fake, client, make, signIn, synced } = await setup(t);
  const hardcover = make();
  hardcover.connect(fake.user, await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT }));
  await synced(hardcover);

  const [a, b] = await Promise.all([hardcover.cover(fake.user.id, 104), hardcover.cover(fake.user.id, 104)]);
  assert.equal(a.type, 'image/png');
  assert.equal(a.file, b.file);
  assert.ok(fs.statSync(a.file).size > 0);
  assert.equal(await hardcover.cover(fake.user.id, 999), null);
});

test('disconnecting forgets the tokens and the library', async (t) => {
  const { fake, client, make, signIn, synced, dataDir } = await setup(t);
  const hardcover = make();
  hardcover.connect(fake.user, await client.exchangeCode({ ...(await signIn()), redirectUri: REDIRECT }));
  await synced(hardcover);
  await hardcover.disconnect(fake.user.id);
  assert.equal(fake.stats.revoked, 1);
  assert.equal(hardcover.describe(fake.user.id), null);
  assert.equal(hardcover.library(fake.user.id), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'hardcover', `library-${fake.user.id}.json`)), false);
  assert.equal(make().describe(fake.user.id), null);
});

test('books are tidied whichever way Hardcover describes them', () => {
  const viaRelations = normalizeBook({
    id: 1,
    title: ' The Hobbit ',
    description: '<p>In a hole in the ground</p>\n\n<p>there lived a hobbit.</p>',
    contributions: [
      { contribution: null, author: { name: 'J.R.R. Tolkien' } },
      { contribution: 'Illustrator', author: { name: 'Alan Lee' } },
      { contribution: 'Narrator', author: { name: 'Andy Serkis' } },
    ],
    image: { url: 'https://assets.hardcover.app/books/1/cover.jpg' },
    book_series: [{ position: 0, featured: false, series: { name: 'Middle-earth' } }, { position: 1, featured: true, series: { name: 'The Lord of the Rings' } }],
    release_date: '1937-09-21',
    rating: '4.25',
    alternative_titles: ['There and Back Again', 'Хоббит', 'The Hobbit'],
  });
  assert.deepEqual(viaRelations.authors, ['J.R.R. Tolkien']);
  assert.deepEqual(viaRelations.contributors, [{ name: 'Alan Lee', role: 'Illustrator' }, { name: 'Andy Serkis', role: 'Narrator' }]);
  assert.deepEqual(viaRelations.series, { name: 'The Lord of the Rings', position: 1 });
  assert.equal(viaRelations.title, 'The Hobbit');
  assert.equal(viaRelations.year, 1937);
  assert.equal(viaRelations.rating, 4.25);
  assert.equal(viaRelations.description, 'In a hole in the ground\nthere lived a hobbit.');
  assert.deepEqual(viaRelations.otherTitles, ['There and Back Again']);

  const bare = normalizeBook({ id: 2 });
  assert.deepEqual({ title: bare.title, authors: bare.authors, series: bare.series, cover: bare.cover }, { title: 'Untitled', authors: [], series: null, cover: '' });
  assert.equal(normalizeBook({ title: 'No id' }), null);
  assert.equal(normalizeBook({ id: 3, cached_image: { url: 'javascript:alert(1)' } }).cover, '');

  assert.equal(normalizeEntry({ book: { id: 9 }, status_id: 5, rating: '3.5' }).status, 'dnf');
  assert.equal(normalizeEntry({ status_id: 1 }), null);
});

test('queries leave out dropped fields, and anything left empty', () => {
  const fields = ['id', ['image', 'images', ['url']], ['book', 'books', ['title', ['image', 'images', ['url']]]]];
  assert.equal(renderFields(fields, 'user_books', new Set()), 'id image { url } book { title image { url } }');
  assert.equal(renderFields(fields, 'user_books', new Set(['books.image'])), 'id image { url } book { title }');
  assert.equal(renderFields(fields, 'user_books', new Set(['images.url'])), 'id book { title }');
});
