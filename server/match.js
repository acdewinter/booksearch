// From a book (title, authors, series) to searches of the list.
//
// File names in the lists follow no single convention:
//
//   Sanderson, Brandon - Mistborn 01 - The Final Empire (audiobook).zip
//   Brandon Sanderson - The Final Empire.epub
//   Final Empire, The - B. Sanderson [Mistborn 1] (retail).mobi
//   /Audio Books/S/Sanderson, Brandon/Mistborn 1 - The Final Empire/01 of 24.mp3
//
// What they share is the surname and the telling words of the title, in some
// order, somewhere in the file name or its folders. So a search is those
// words and nothing else: no "the" or "and", no punctuation, no subtitle, no
// first name. Each word matches the start of a word (see query.js), which
// also covers "Ender's" against "Enders".
//
// One search is not enough for every book, so bookQueries() returns a ladder,
// strictest first. Whoever calls it runs them in order and takes the first
// that finds something.

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'to', 'for', 'at', 'by', 'from', 'with', 'or']);
const NAME_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq']);
const MAX_TITLE_WORDS = 6;

// Letters that do not split into a plain letter plus an accent.
const PLAIN = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };

/**
 * Lower case, Latin letters without their accents, every kind of apostrophe written as '.
 * Other scripts are left as they are: the search index does not take them apart either.
 */
export function fold(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[À-ɏḀ-ỿ]/g, (ch) => ch.normalize('NFD').replace(/\p{M}+/gu, ''))
    .toLowerCase()
    .replace(/[’‘ʼ`´]/g, "'");
}

/**
 * The words of a title or a name, as they would be typed into the search.
 *   "Ender's Game"   -> ender, game       (matches "Enders" and "Ender's")
 *   "O'Brien"        -> brien
 *   "Nesbø"          -> nesb              (matches "Nesbø" and "Nesbo")
 */
export function words(value) {
  const out = [];
  for (let word of fold(value).split(/[^\p{L}\p{N}']+/u)) {
    word = word.replace(/^'+|'+$/g, '');
    if (!word) continue;
    const lead = /^(\p{L}{1,2})'(\p{L}{3,})$/u.exec(word);
    if (lead) word = lead[2];
    else word = word.replace(/'(s|t|d|m|ll|re|ve)?$/, '');
    for (let part of word.split("'")) {
      if (!part) continue;
      const odd = part.search(/[øæœßđðłþı]/);
      if (odd >= 4) part = part.slice(0, odd);
      else if (odd >= 0) part = part.replace(/[øæœßđðłþı]/g, (ch) => PLAIN[ch]);
      out.push(part);
    }
  }
  return out;
}

/** Short words and numbers are matched whole: "it" must not find "Italian". */
const term = (word) => (word.length <= 3 || /^\d+$/.test(word) ? `"${word}"` : word);

/** The words of a title that tell it apart, at most a handful. */
function telling(text) {
  const all = words(text);
  const kept = all.filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
  return (kept.length ? kept : all).slice(0, MAX_TITLE_WORDS);
}

/** "The Final Empire (Mistborn, #1)" -> "The Final Empire" */
const withoutBrackets = (title) => String(title ?? '').replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The ways a title may be written in a file name, most complete first.
 *   "Mistborn: The Final Empire" -> [mistborn final empire], [mistborn], [final empire]
 */
export function titleVariants(title) {
  const clean = withoutBrackets(title) || String(title ?? '');
  const parts = clean.split(/\s*[:;–—]\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const candidates = [telling(parts.join(' '))];
  if (parts.length > 1) {
    candidates.push(telling(parts[0]));
    const last = telling(parts[parts.length - 1]);
    if (last.length >= 2) candidates.push(last);
  }
  const seen = new Set();
  return candidates.filter((w) => {
    const key = w.join(' ');
    if (!w.length || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The surname and first name files are likely to carry.
 *   "Brandon Sanderson"       -> { last: sanderson, first: brandon }
 *   "Le Guin, Ursula K."      -> { last: guin, first: ursula }
 *   "Martin Luther King Jr."  -> { last: king, first: martin }
 */
export function authorName(name) {
  const text = String(name ?? '');
  const comma = text.indexOf(',');
  if (comma > 0) {
    const last = words(text.slice(0, comma)).filter((w) => !NAME_SUFFIX.has(w));
    const first = words(text.slice(comma + 1)).filter((w) => !NAME_SUFFIX.has(w) && w.length > 1);
    if (last.length) return { last: last[last.length - 1], first: first[0] || '' };
  }
  const parts = words(text).filter((w) => !NAME_SUFFIX.has(w));
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const first = parts.length > 1 && parts[0].length > 1 ? parts[0] : '';
  return { last, first };
}

const join = (...parts) => parts.flat().filter(Boolean).map(term).join(' ');

/**
 * The searches worth trying for a book, strictest first.
 *
 * @param {{title: string, authors?: string[], series?: {name: string} | null, otherTitles?: string[], editionTitle?: string}} book
 * @returns {{kind: 'book' | 'title' | 'series' | 'author', label: string, q: string}[]}
 *   `book` searches name the title and an author, `title` the title alone.
 *   `series` and `author` are for looking around, not for finding this book.
 */
export function bookQueries(book) {
  const out = [];
  const seen = new Set();
  const add = (kind, label, q) => {
    if (!q || seen.has(q)) return;
    seen.add(q);
    out.push({ kind, label, q });
  };

  const authors = (book.authors || []).map((name) => ({ name, parts: authorName(name) })).filter((a) => a.parts).slice(0, 3);
  const titles = titleVariants(book.title);
  const others = [book.editionTitle, ...(book.otherTitles || [])]
    .filter(Boolean)
    .flatMap((t) => titleVariants(t).slice(0, 1));

  // The title with the first author, then with the others (a co-author is sometimes the one named).
  for (const [i, author] of authors.entries()) {
    for (const [j, title] of titles.entries()) {
      add('book', i === 0 && j === 0 ? 'Title and author' : `Title and ${author.name}`, join(author.parts.last, title));
    }
  }
  // The same book under another title: a translation, or the name it has in another country.
  for (const title of others) {
    if (authors[0]) add('book', 'Other title and author', join(authors[0].parts.last, title));
  }
  // No author anywhere near the file.
  for (const title of [...titles, ...others]) add('title', 'Title only', join(title));

  const seriesWords = book.series?.name ? telling(book.series.name).slice(0, 4) : [];
  if (seriesWords.length) {
    add('series', `Series: ${book.series.name}`, join(authors[0]?.parts.last, seriesWords));
  }
  for (const author of authors) {
    add('author', `Everything by ${author.name}`, join(author.parts.last, author.parts.first));
    add('author', `Everything by ${author.name}`, join(author.parts.last));
  }
  return out;
}

/**
 * Run the ladder against the list and say which search to show.
 *
 * @param {ReturnType<typeof bookQueries>} queries
 * @param {(q: string) => {files: number, folders: number}} count
 * @returns {{queries: object[], best: string | null}} every search that finds something, plus the
 *   first one even when it finds nothing (so the page can say what was looked for)
 */
export function pickQueries(queries, count) {
  const counted = queries.map((query) => ({ ...query, ...count(query.q) }));
  const best = counted.find((c) => (c.kind === 'book' || c.kind === 'title') && c.files > 0) || null;

  const shown = [];
  const labels = new Set();
  for (const [i, c] of counted.entries()) {
    if (c.files === 0 && i !== 0) continue;
    // Two searches by the same author with the same result say nothing new.
    const key = c.kind === 'author' ? `${c.label}` : `${c.kind}|${c.q}`;
    if (labels.has(key)) continue;
    labels.add(key);
    shown.push(c);
  }
  return { queries: shown, best: best ? best.q : null };
}
