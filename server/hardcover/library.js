// Reading someone's Hardcover library: the queries, and turning the answers
// into the plain shape the rest of the app uses.
//
// Hardcover says its API is still changing. So the queries are built from a
// list of fields, and when Hardcover answers that one of them does not exist
// it is left out and the query is tried again, instead of the whole sync
// failing over one renamed column.

export const STATUSES = {
  1: 'want',
  2: 'reading',
  3: 'read',
  4: 'paused',
  5: 'dnf',
  6: 'ignored',
};

const FORMATS = { 1: 'physical', 2: 'audio', 3: 'physical and audio', 4: 'ebook' };

// A field is a name, or [name, type, fields] for something with fields of its own.
const IMAGE = ['url'];
const BOOK = [
  'id', 'title', 'subtitle', 'slug', 'description', 'pages', 'audio_seconds',
  'release_year', 'release_date', 'rating', 'ratings_count', 'users_count',
  'alternative_titles', 'cached_contributors', 'cached_image', 'cached_featured_series', 'cached_tags',
  ['contributions', 'contributions', ['contribution', ['author', 'authors', ['name']]]],
  ['image', 'images', IMAGE],
  ['book_series', 'book_series', ['position', 'featured', ['series', 'series', ['name']]]],
];
const EDITION = ['id', 'title', 'edition_format', 'reading_format_id', 'pages', 'audio_seconds', 'cached_image'];
const USER_BOOK = [
  'id', 'book_id', 'status_id', 'rating', 'date_added', 'first_started_reading_date', 'last_read_date',
  'updated_at', 'owned', 'read_count', 'has_review',
  ['edition', 'editions', EDITION],
  ['book', 'books', BOOK],
];
const LIST = ['id', 'name', 'slug', 'description', 'books_count', 'privacy_setting_id', 'ranked', 'updated_at'];
const LIST_BOOK = ['id', 'list_id', 'book_id', 'position', 'date_added', ['book', 'books', BOOK]];

// Left out when Hardcover refuses a query for being too deep: each of these
// has a "cached_" field on the book that carries the same facts.
const DEEP = ['books.contributions', 'books.image', 'books.book_series'];

/** Write a list of fields as GraphQL, leaving out the ones in `dropped` ("type.field"). */
export function renderFields(fields, type, dropped) {
  const out = [];
  for (const field of fields) {
    if (typeof field === 'string') {
      if (!dropped.has(`${type}.${field}`)) out.push(field);
      continue;
    }
    const [name, childType, children] = field;
    if (dropped.has(`${type}.${name}`)) continue;
    const inner = renderFields(children, childType, dropped);
    if (inner) out.push(`${name} { ${inner} }`);
  }
  return out.join(' ');
}

const QUERIES = {
  me: () => 'query Me { me { id username name } }',
  books: (dropped) => `query LibraryBooks($userId: Int!, $limit: Int!, $offset: Int!) {
    user_books(where: {user_id: {_eq: $userId}}, order_by: {id: asc}, limit: $limit, offset: $offset) {
      ${renderFields(USER_BOOK, 'user_books', dropped)}
    }
  }`,
  lists: (dropped) => `query Lists($userId: Int!) {
    lists(where: {user_id: {_eq: $userId}}, order_by: {name: asc}, limit: 500) {
      ${renderFields(LIST, 'lists', dropped)}
    }
  }`,
  listBooks: (dropped) => `query ListBooks($listIds: [Int!]!, $limit: Int!, $offset: Int!) {
    list_books(where: {list_id: {_in: $listIds}}, order_by: {id: asc}, limit: $limit, offset: $offset) {
      ${renderFields(LIST_BOOK, 'list_books', dropped)}
    }
  }`,
};

const MISSING_FIELD = /field ['"`]?(\w+)['"`]? not found in type:? ['"`]?(\w+)['"`]?/i;
const TOO_DEEP = /depth|too deep|complex/i;

/**
 * Run one of the queries above. `gql(query, variables)` does the request.
 * `dropped` is shared by a whole sync, so a field is only refused once.
 */
export async function runQuery(gql, name, variables, dropped) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await gql(QUERIES[name](dropped), variables);
    } catch (err) {
      if (attempt >= 12 || [401, 403, 429].includes(err.status) || err.status >= 500) throw err;
      const missing = MISSING_FIELD.exec(err.message);
      if (missing && !dropped.has(`${missing[2]}.${missing[1]}`)) {
        dropped.add(`${missing[2]}.${missing[1]}`);
        continue;
      }
      if (TOO_DEEP.test(err.message) && DEEP.some((key) => !dropped.has(key))) {
        for (const key of DEEP) dropped.add(key);
        continue;
      }
      throw err;
    }
  }
}

// ------------------------------------------------------------- tidying up

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const number = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const list = (value) => (Array.isArray(value) ? value : []);

function contributors(book) {
  const cached = list(book.cached_contributors)
    .map((c) => ({ name: text(c?.author?.name ?? c?.name), role: text(c?.contribution) }));
  const related = list(book.contributions)
    .map((c) => ({ name: text(c?.author?.name), role: text(c?.contribution) }));
  const seen = new Set();
  return (cached.some((c) => c.name) ? cached : related).filter((c) => {
    const key = `${c.name.toLowerCase()}|${c.role.toLowerCase()}`;
    if (!c.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function seriesOf(book) {
  const featured = book.cached_featured_series;
  const name = text(featured?.series?.name ?? featured?.name);
  if (name) return { name, position: number(featured.position) };
  const all = list(book.book_series).filter((s) => text(s?.series?.name));
  const pick = all.find((s) => s.featured) || all[0];
  return pick ? { name: text(pick.series.name), position: number(pick.position) } : null;
}

function genresOf(book) {
  const tags = book.cached_tags;
  const genres = list(tags?.Genre ?? tags?.genre ?? tags?.genres);
  return genres.map((g) => text(typeof g === 'string' ? g : g?.tag ?? g?.name)).filter(Boolean).slice(0, 6);
}

/** Descriptions are shown as text, so any markup in them is taken out. */
const plainText = (value) => text(value).replace(/<[^>]{1,200}>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

const httpUrl = (value) => (/^https?:\/\//i.test(text(value)) ? text(value) : '');

/** Titles worth trying when the main one finds nothing: Latin script only, a handful at most. */
function otherTitles(book, title) {
  const seen = new Set([title.toLowerCase()]);
  const out = [];
  for (const raw of list(book.alternative_titles)) {
    const t = text(typeof raw === 'string' ? raw : raw?.title);
    if (!t || t.length > 120 || seen.has(t.toLowerCase())) continue;
    if (!/^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(t)) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 4) break;
  }
  return out;
}

/** One book as Hardcover sends it -> the facts the app keeps. Returns null for a book without an id. */
export function normalizeBook(book) {
  const id = number(book?.id);
  if (!id) return null;
  const title = text(book.title) || 'Untitled';
  const people = contributors(book);
  let authors = people.filter((c) => !c.role || /^(co-?)?(author|writer)/i.test(c.role)).map((c) => c.name);
  if (!authors.length && people.length) authors = [people[0].name];
  return {
    id,
    title,
    subtitle: text(book.subtitle),
    slug: text(book.slug),
    authors: [...new Set(authors)],
    contributors: people.filter((c) => c.role && !/^(co-?)?(author|writer)/i.test(c.role)).slice(0, 8),
    series: seriesOf(book),
    year: number(book.release_year) ?? (number(text(book.release_date).slice(0, 4)) || null),
    pages: number(book.pages),
    audioSeconds: number(book.audio_seconds),
    rating: number(book.rating),
    ratings: number(book.ratings_count) ?? 0,
    readers: number(book.users_count) ?? 0,
    genres: genresOf(book),
    description: plainText(book.description),
    cover: httpUrl(book.cached_image?.url) || httpUrl(book.image?.url),
    color: /^#[0-9a-f]{3,8}$/i.test(text(book.cached_image?.color)) ? text(book.cached_image.color) : '',
    otherTitles: otherTitles(book, title),
  };
}

/** One library entry (a book with its status) -> the facts the app keeps about it. */
export function normalizeEntry(row) {
  const bookId = number(row?.book?.id ?? row?.book_id);
  if (!bookId) return null;
  const edition = row.edition || null;
  return {
    bookId,
    status: STATUSES[row.status_id] || 'want',
    rating: number(row.rating) || null,
    added: text(row.date_added),
    started: text(row.first_started_reading_date),
    finished: text(row.last_read_date),
    updated: text(row.updated_at),
    owned: Boolean(row.owned),
    reads: number(row.read_count) ?? 0,
    format: FORMATS[edition?.reading_format_id] || '',
    editionTitle: text(edition?.title),
    editionCover: httpUrl(edition?.cached_image?.url),
    editionPages: number(edition?.pages),
    editionAudioSeconds: number(edition?.audio_seconds),
  };
}

// ----------------------------------------------------------------- search

const SEARCH = `query FindBooks($query: String!, $perPage: Int!) {
  search(query: $query, query_type: "Book", per_page: $perPage, page: 1) { results }
}`;

/**
 * One hit of Hardcover's search -> the same facts normalizeBook() gives.
 * The search index names things a little differently from the books table.
 */
export function normalizeSearchHit(hit) {
  const doc = hit?.document ?? hit;
  if (!doc || typeof doc !== 'object') return null;
  const book = normalizeBook({
    ...doc,
    id: number(doc.id),
    cached_contributors: doc.contributions,
    contributions: undefined,
    cached_image: doc.image,
    image: undefined,
    cached_featured_series: doc.featured_series,
    cached_tags: { Genre: doc.genres },
  });
  if (!book) return null;
  if (!book.authors.length) book.authors = list(doc.author_names).map(text).filter(Boolean).slice(0, 4);
  if (!book.series && text(list(doc.series_names)[0])) {
    book.series = { name: text(doc.series_names[0]), position: number(doc.featured_series_position) };
  }
  return book;
}

/**
 * Look for books in the whole of Hardcover, the way its own search box does.
 * Needs a sign-in with the scope read:catalog:search.
 *
 * @param {(query: string, variables: object) => Promise<object>} gql
 * @param {string} query
 * @param {number} [limit]
 */
export async function searchBooks(gql, query, limit = 12) {
  const data = await gql(SEARCH, { query: String(query).slice(0, 200), perPage: limit });
  let results = data?.search?.results;
  if (typeof results === 'string') {
    try {
      results = JSON.parse(results);
    } catch {
      results = null;
    }
  }
  const seen = new Set();
  return list(results?.hits ?? results).map(normalizeSearchHit).filter((book) => {
    if (!book || seen.has(book.id)) return false;
    seen.add(book.id);
    return true;
  });
}

// ------------------------------------------------------------------- sync

/**
 * Fetch everything: who this is, their books with a status, and their lists.
 *
 * @param {(query: string, variables: object) => Promise<object>} gql
 * @param {object} [o]
 * @param {number} [o.pageSize]
 * @param {(p: {phase: string, count: number}) => void} [o.onProgress]
 */
export async function fetchLibrary(gql, { pageSize = 100, onProgress = () => {} } = {}) {
  const dropped = new Set();
  const warnings = [];

  const me = list((await runQuery(gql, 'me', {}, dropped)).me)[0];
  const userId = number(me?.id);
  if (!userId) throw new Error('Hardcover did not say whose account this is.');
  const user = { id: userId, username: text(me.username), name: text(me.name) };

  const books = new Map();
  const entries = new Map();
  const addBook = (raw) => {
    const book = normalizeBook(raw);
    if (book && !books.has(book.id)) books.set(book.id, book);
    return book;
  };

  onProgress({ phase: 'Reading your books', count: 0 });
  for (let offset = 0; ; offset += pageSize) {
    const rows = list((await runQuery(gql, 'books', { userId, limit: pageSize, offset }, dropped)).user_books);
    for (const row of rows) {
      const book = addBook(row?.book);
      const entry = book && normalizeEntry(row);
      if (!entry) continue;
      // The same book can be in a library twice after a merge: keep the newer entry.
      const earlier = entries.get(entry.bookId);
      if (!earlier || entry.updated > earlier.updated) entries.set(entry.bookId, entry);
    }
    onProgress({ phase: 'Reading your books', count: entries.size });
    if (rows.length < pageSize) break;
  }

  // Lists are extra: a library without them is still worth having.
  let lists = [];
  try {
    onProgress({ phase: 'Reading your lists', count: 0 });
    const found = list((await runQuery(gql, 'lists', { userId }, dropped)).lists)
      .map((l) => ({
        id: number(l?.id),
        name: text(l?.name) || 'List',
        slug: text(l?.slug),
        description: text(l?.description),
        ranked: Boolean(l?.ranked),
        isPrivate: l?.privacy_setting_id === 3,
        items: [],
      }))
      .filter((l) => l.id);
    const byId = new Map(found.map((l) => [l.id, l]));
    let count = 0;
    for (let offset = 0; found.length; offset += pageSize) {
      const rows = list((await runQuery(gql, 'listBooks', { listIds: [...byId.keys()], limit: pageSize, offset }, dropped)).list_books);
      for (const row of rows) {
        const target = byId.get(number(row?.list_id));
        const book = addBook(row?.book);
        if (!target || !book) continue;
        target.items.push({ bookId: book.id, position: number(row.position) ?? 0, id: number(row.id) ?? 0 });
        count += 1;
      }
      onProgress({ phase: 'Reading your lists', count });
      if (rows.length < pageSize) break;
    }
    lists = found.map(({ items, ...rest }) => ({
      ...rest,
      bookIds: [...new Set(items.sort((a, b) => a.position - b.position || a.id - b.id).map((i) => i.bookId))],
    }));
  } catch (err) {
    warnings.push(err.code === 'insufficient_scope'
      ? 'Your lists could not be read: the Hardcover app is not allowed the "read:lists" scope.'
      : `Your lists could not be read: ${err.message}`);
  }

  if (dropped.size) console.log(`Hardcover no longer has these fields, so they were left out: ${[...dropped].join(', ')}`);
  return { user, books: [...books.values()], entries: [...entries.values()], lists, warnings };
}
