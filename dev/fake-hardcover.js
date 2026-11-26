// A stand-in for Hardcover, for trying the sign-in and the Library page
// without touching the real service. It speaks just enough OAuth (code + PKCE,
// rotating refresh tokens) and GraphQL (me, user_books, lists, list_books).
//
//   npm run fake-hardcover
//
// Then start the app with:
//
//   HARDCOVER_CLIENT_ID=practice HARDCOVER_CLIENT_SECRET=practice \
//   HARDCOVER_API_URL=http://127.0.0.1:4010 HARDCOVER_WEB_URL=http://127.0.0.1:4010 npm start
//
// Signing in approves by itself, as the account "reader".

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const b = (id, title, authors, extra = {}) => ({ id, title, authors, ...extra });

// Several of these are in test/fixtures/sample-list.txt, so the matching has something to find.
const BOOKS = [
  b(101, 'Nice Dragons Finish Last', ['Rachel Aaron'], { series: ['Heartstrikers', 1], year: 2014, pages: 287, audio: 47880, rating: 4.02, genres: ['Fantasy', 'Urban Fantasy'] }),
  b(102, 'One Good Dragon Deserves Another', ['Rachel Aaron'], { series: ['Heartstrikers', 2], year: 2015, pages: 416, rating: 4.31, genres: ['Fantasy'] }),
  b(103, 'By a Silver Thread', ['Rachel Aaron'], { series: ['DFZ Changeling', 1], year: 2023, pages: 308, rating: 4.1, genres: ['Fantasy'] }),
  b(104, 'Mort', ['Terry Pratchett'], { series: ['Discworld', 4], year: 1987, pages: 243, rating: 4.25, genres: ['Fantasy', 'Humor'] }),
  b(105, 'The Five People You Meet in Heaven', ['Mitch Albom'], { year: 2003, pages: 196, rating: 3.95, genres: ['Fiction'] }),
  b(106, 'The Stopped Heart', ['Julie Myerson'], { year: 2016, pages: 512, rating: 3.4, genres: ['Thriller'] }),
  b(107, 'David Copperfield', ['Charles Dickens'], { year: 1850, pages: 882, rating: 4.0, genres: ['Classics'] }),
  b(108, 'The Final Empire', ['Brandon Sanderson'], { series: ['Mistborn', 1], year: 2006, pages: 541, rating: 4.46, genres: ['Fantasy'], subtitle: 'Mistborn Book One' }),
  b(109, "Ender's Game", ['Orson Scott Card'], { series: ['Ender Saga', 1], year: 1985, pages: 324, rating: 4.3, genres: ['Science Fiction'] }),
  b(110, 'Good Omens: The Nice and Accurate Prophecies of Agnes Nutter, Witch', ['Terry Pratchett', 'Neil Gaiman'], { year: 1990, pages: 412, rating: 4.25, genres: ['Fantasy', 'Humor'] }),
  b(111, 'The First Phone Call from Heaven', ['Mitch Albom'], { year: 2013, pages: 323, rating: 3.7, genres: ['Fiction'] }),
  b(112, 'The Snowman', ['Jo Nesbø'], { series: ['Harry Hole', 7], year: 2007, pages: 383, rating: 4.0, genres: ['Crime'] }),
];

const ENTRIES = [
  [101, 3, 4.5, '2024-03-02', '2024-03-20'], [102, 2, null, '2024-03-21', null], [103, 1, null, '2025-01-11', null],
  [104, 3, 5, '2022-07-01', '2022-07-09'], [105, 1, null, '2025-02-01', null], [106, 5, 2, '2023-05-05', null],
  [107, 4, null, '2023-09-12', null], [108, 3, 4, '2021-01-03', '2021-02-01'], [109, 1, null, '2025-06-06', null],
  [110, 3, 4.5, '2020-11-11', '2020-12-01'],
];

const LISTS = [
  { id: 9001, name: 'Dragons, mostly', description: 'Scales required.', ranked: true, privacy_setting_id: 1, books: [102, 101, 103] },
  { id: 9002, name: 'To find on audio', description: '', ranked: false, privacy_setting_id: 3, books: [111, 112, 105] },
];

const COVER_COLORS = ['#1d5b4d', '#7a3e6e', '#6f4e00', '#a3322b', '#2b4a7a', '#4b4b4b'];

/** A tiny PNG: one colour, 2 by 3 pixels, so covers have the right shape without any files. */
function coverPng(hex) {
  const [r, g, bl] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const raw = Buffer.concat(Array.from({ length: 3 }, () => Buffer.from([0, r, g, bl, r, g, bl])));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(3, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {object} [o]
 * @param {number} [o.port]             0 = any free port
 * @param {string} [o.clientId]
 * @param {string} [o.clientSecret]
 * @param {number} [o.tokenSeconds]     how long an access token lasts
 * @param {string[]} [o.missingFields]  "type.field" names this server claims not to have
 * @param {string} [o.username]
 */
export async function startFakeHardcover(o = {}) {
  const clientId = o.clientId || 'practice';
  const clientSecret = o.clientSecret || 'practice';
  const tokenSeconds = o.tokenSeconds ?? 3600;
  const missing = new Set(o.missingFields || []);
  const user = { id: 4242, username: o.username || 'reader', name: 'Practice Reader' };

  const codes = new Map();    // code -> { challenge, redirectUri, scope }
  const access = new Map();   // access token -> { expiresAt, scope }
  const refresh = new Map();  // refresh token -> { scope, spent }
  const stats = { queries: 0, refreshes: 0, revoked: 0, authorizations: 0 };
  let origin = '';

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  function issue(scope) {
    const accessToken = `hc_at_${crypto.randomBytes(12).toString('hex')}`;
    const refreshToken = `hc_rt_${crypto.randomBytes(12).toString('hex')}`;
    access.set(accessToken, { expiresAt: Date.now() + tokenSeconds * 1000, scope });
    refresh.set(refreshToken, { scope, spent: false });
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: tokenSeconds, token_type: 'Bearer', scope };
  }

  const clientOk = (req) => req.headers.authorization === `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  function bookJson(book) {
    const [seriesName, position] = book.series || [];
    return {
      id: book.id,
      title: book.title,
      subtitle: book.subtitle || null,
      slug: book.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      description: `A practice description for ${book.title}. `.repeat(6).trim(),
      pages: book.pages ?? null,
      audio_seconds: book.audio ?? null,
      release_year: book.year ?? null,
      release_date: book.year ? `${book.year}-01-01` : null,
      rating: book.rating ?? null,
      ratings_count: 1200,
      users_count: 5400,
      alternative_titles: book.id === 105 ? ['Die fünf Menschen, die dir im Himmel begegnen'] : [],
      cached_contributors: book.authors.map((name) => ({ author: { name, slug: name.toLowerCase().replace(/\W+/g, '-') }, contribution: null })),
      cached_image: { url: `${origin}/covers/${book.id}.png`, color: COVER_COLORS[book.id % COVER_COLORS.length] },
      cached_featured_series: seriesName ? { series: { name: seriesName }, position } : null,
      cached_tags: { Genre: (book.genres || []).map((tag) => ({ tag })) },
      contributions: book.authors.map((name) => ({ contribution: null, author: { name } })),
      image: { url: `${origin}/covers/${book.id}.png` },
      book_series: seriesName ? [{ position, featured: true, series: { name: seriesName } }] : [],
    };
  }

  function graphql(query, variables) {
    for (const key of missing) {
      const [type, field] = key.split('.');
      if (new RegExp(`\\b${field}\\b`).test(query)) {
        return { errors: [{ message: `field '${field}' not found in type: '${type}'`, extensions: { code: 'validation-failed' } }] };
      }
    }
    const page = (rows) => rows.slice(variables.offset || 0, (variables.offset || 0) + (variables.limit || rows.length));
    if (/\bme\s*\{/.test(query)) return { data: { me: [user] } };
    if (/\buser_books\s*\(/.test(query)) {
      const rows = ENTRIES.map(([bookId, status, rating, added, finished], i) => ({
        id: 7000 + i,
        book_id: bookId,
        status_id: status,
        rating,
        date_added: added,
        first_started_reading_date: null,
        last_read_date: finished,
        updated_at: `${added}T10:00:00+00:00`,
        owned: i % 4 === 0,
        read_count: finished ? 1 : 0,
        has_review: false,
        edition: i % 3 === 0 ? { id: 50 + i, title: null, edition_format: 'Audiobook', reading_format_id: 2, pages: null, audio_seconds: 36000, cached_image: null } : null,
        book: bookJson(BOOKS.find((x) => x.id === bookId)),
      }));
      return { data: { user_books: page(rows) } };
    }
    if (/\blist_books\s*\(/.test(query)) {
      const rows = LISTS.filter((l) => (variables.listIds || []).includes(l.id)).flatMap((l) => l.books.map((bookId, i) => ({
        id: l.id * 10 + i,
        list_id: l.id,
        book_id: bookId,
        position: i + 1,
        date_added: '2025-01-01T00:00:00+00:00',
        book: bookJson(BOOKS.find((x) => x.id === bookId)),
      })));
      return { data: { list_books: page(rows) } };
    }
    if (/\blists\s*\(/.test(query)) {
      return { data: { lists: LISTS.map(({ books, ...l }) => ({ ...l, slug: `list-${l.id}`, books_count: books.length, updated_at: '2025-01-01T00:00:00+00:00' })) } };
    }
    return { errors: [{ message: 'The practice server does not know that query.', extensions: { code: 'validation-failed' } }] };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);

    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid authorization request');
        return;
      }
      stats.authorizations += 1;
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('state', q.get('state') || '');
      back.searchParams.set('iss', origin);
      if (o.deny) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = crypto.randomBytes(12).toString('hex');
        codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), scope: q.get('scope') || '' });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(await readBody(req));
      if (!clientOk(req)) return json(res, 401, { error: 'invalid_client', error_description: 'Unknown client or wrong secret.' });
      if (form.get('grant_type') === 'authorization_code') {
        const entry = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!entry || entry.redirectUri !== form.get('redirect_uri') || entry.challenge !== challenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'The code, redirect_uri or code_verifier is not right.' });
        }
        return json(res, 200, issue(entry.scope));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const entry = refresh.get(form.get('refresh_token'));
        if (!entry || entry.spent) {
          // A refresh token used twice ends the whole session, as on Hardcover.
          refresh.clear();
          access.clear();
          return json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is spent or unknown.' });
        }
        entry.spent = true;
        stats.refreshes += 1;
        return json(res, 200, issue(entry.scope));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
      await readBody(req);
      stats.revoked += 1;
      access.clear();
      refresh.clear();
      return json(res, 200, {});
    }

    if (req.method === 'POST' && url.pathname === '/v1/graphql') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const token = access.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!token || token.expiresAt <= Date.now()) return json(res, 401, { error: 'invalid_token', error_description: 'The token is missing, invalid or expired.' });
      if (o.throttleOnce && !stats.throttled) {
        stats.throttled = true;
        return json(res, 429, { error: 'Too Many Requests' }, { 'Retry-After': '0' });
      }
      stats.queries += 1;
      stats.lastQuery = body.query || '';
      if (/\buser_books\s*\(/.test(body.query) && !/read:library/.test(token.scope)) {
        return json(res, 403, { error: 'insufficient_scope', error_description: 'The token is missing a scope.', scope: 'read:library' });
      }
      return json(res, 200, graphql(body.query || '', body.variables || {}));
    }

    const cover = /^\/covers\/(\d+)\.png$/.exec(url.pathname);
    if (req.method === 'GET' && cover) {
      const png = coverPng(COVER_COLORS[Number(cover[1]) % COVER_COLORS.length]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }).end(png);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });

  await new Promise((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    url: origin,
    user,
    stats,
    books: BOOKS,
    /** Make every access token handed out so far count as run out. */
    expireTokens() {
      for (const token of access.values()) token.expiresAt = 0;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = await startFakeHardcover({ port: Number(process.env.FAKE_HARDCOVER_PORT) || 4010 });
  console.log(`Practice Hardcover is running on ${fake.url}`);
  console.log('Start the app with:');
  console.log(`  HARDCOVER_CLIENT_ID=practice HARDCOVER_CLIENT_SECRET=practice HARDCOVER_API_URL=${fake.url} HARDCOVER_WEB_URL=${fake.url} npm start`);
}
