// The collection: the books you actually have, each tied to one or more
// files in the download folder, and how far each has been read.
//
// The files stay where they are. The collection only remembers which file
// belongs to which title, in <data>/collection.json:
//
//   books     a title (from Hardcover, or from the file's own details) and its files
//   expected  downloads that were asked for from a book's page, so the file
//             can be tied to that book by itself when it arrives
//   progress  per account, per file: where the reader app last was
//
// The download folder is shared by everyone who can sign in, and so is the
// collection. Reading progress is kept per account.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EpubError, readEpub } from '../epub.js';
import { fold, words } from '../match.js';

const SCAN_FRESH_MS = 2500;
const MAX_DEPTH = 5;
const MAX_FILES = 20000;
const EXPECT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EXPECTED = 500;
const COVER_EXTS = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

const EBOOK = new Set(['epub', 'mobi', 'azw', 'azw3', 'kfx', 'pdf', 'fb2', 'djvu', 'lit', 'cbz', 'cbr', 'txt', 'rtf', 'doc', 'docx']);
const AUDIO = new Set(['mp3', 'm4b', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'wav', 'wma']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz']);

/** An error whose message is meant for the person using the app. */
export class CollectionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
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

const text = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function formatOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

/** What a file is, going by its extension: an ebook, audio, an archive, or something else. */
export function kindOf(format) {
  if (EBOOK.has(format)) return 'ebook';
  if (AUDIO.has(format)) return 'audio';
  if (ARCHIVE.has(format)) return 'archive';
  return 'other';
}

/**
 * A file name as words to look a book up with.
 *   "Aaron, Rachel - By a Silver Thread (retail) (epub).epub" -> "Aaron, Rachel - By a Silver Thread"
 */
export function nameQuery(name) {
  return path.basename(name, path.extname(name))
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The facts kept about a title, from whatever described it. */
function bookFacts(source) {
  const series = source.series && text(source.series.name)
    ? { name: text(source.series.name, 200), position: number(source.series.position) }
    : null;
  return {
    title: text(source.title, 300) || 'Untitled',
    subtitle: text(source.subtitle, 300),
    authors: (Array.isArray(source.authors) ? source.authors : []).map((a) => text(a, 120)).filter(Boolean).slice(0, 8),
    series,
    year: number(source.year),
    pages: number(source.pages),
    description: text(source.description, 6000),
    slug: text(source.slug, 200),
    coverUrl: /^https?:\/\//i.test(text(source.cover, 1000)) ? text(source.cover, 1000) : '',
    color: /^#[0-9a-f]{3,8}$/i.test(text(source.color)) ? text(source.color) : '',
  };
}

const titleKey = (book) => `${fold(book.title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}|${fold(book.authors[0] || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;

export class Collection {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {string} o.downloadDir the folder the files are in
   * @param {(url: string, stem: string) => Promise<{file: string, type: string} | null>} [o.fetchCover]
   *        fetch a cover image from Hardcover into `stem` + its extension
   */
  constructor(o) {
    this.statePath = path.join(o.dataDir, 'collection.json');
    this.coverDir = path.join(o.dataDir, 'collection-covers');
    this.downloadDir = path.resolve(o.downloadDir);
    this.fetchCover = o.fetchCover || (async () => null);
    this.books = new Map();    // book id -> book
    this.expected = new Map(); // list command -> { hardcoverId, account, at }
    this.progress = {};        // account -> { file id -> { fraction, locator, updatedAt, device } }
    this.seq = 0;
    this.scanned = null;       // { at, files: Map<relative path, {path, name, size, mtimeMs}> }
    this.coverJobs = new Map();
    this.listeners = new Set();
  }

  load() {
    const saved = readJson(this.statePath);
    if (!saved || typeof saved !== 'object') return;
    this.seq = Number.isInteger(saved.seq) ? saved.seq : 0;
    for (const book of Array.isArray(saved.books) ? saved.books : []) {
      if (book && typeof book.id === 'string' && Array.isArray(book.files)) this.books.set(book.id, book);
    }
    const now = Date.now();
    for (const [command, entry] of Object.entries(saved.expected || {})) {
      if (entry && now - entry.at < EXPECT_MS) this.expected.set(command, entry);
    }
    if (saved.progress && typeof saved.progress === 'object') this.progress = saved.progress;
  }

  #save() {
    try {
      writeJson(this.statePath, {
        version: 1,
        seq: this.seq,
        books: [...this.books.values()],
        expected: Object.fromEntries(this.expected),
        progress: this.progress,
      });
    } catch (err) {
      console.error(`Could not save the collection: ${err.message}`);
    }
  }

  /** Call fn() whenever the collection changes, so open pages can be told. */
  onChange(fn) {
    this.listeners.add(fn);
  }

  #changed() {
    this.#save();
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ the folder

  /** Turn a path from a request into one inside the download folder, or null. */
  #inside(relative) {
    const rel = text(relative, 1000);
    if (!rel || rel.includes('\0')) return null;
    const abs = path.resolve(this.downloadDir, rel);
    if (abs !== this.downloadDir && !abs.startsWith(this.downloadDir + path.sep)) return null;
    return abs;
  }

  /** Every file in the download folder, by its path inside it. Looked at again every few seconds. */
  scan({ force = false } = {}) {
    if (!force && this.scanned && Date.now() - this.scanned.at < SCAN_FRESH_MS) return this.scanned.files;
    const files = new Map();
    const walk = (dir, rel, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.size >= MAX_FILES) return;
        if (entry.name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) walk(path.join(dir, entry.name), relPath, depth + 1);
        } else if (entry.isFile() && !entry.name.endsWith('.part')) {
          try {
            const stat = fs.statSync(path.join(dir, entry.name));
            files.set(relPath, { path: relPath, name: entry.name, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
          } catch {
            // gone again already
          }
        }
      }
    };
    walk(this.downloadDir, '', 0);
    this.scanned = { at: Date.now(), files };
    this.#relink(files);
    return files;
  }

  /** A file that was renamed or moved keeps its title: the one loose file of the same size takes its place. */
  #relink(files) {
    const taken = new Set();
    for (const book of this.books.values()) for (const f of book.files) taken.add(f.path);
    let changed = false;
    for (const book of this.books.values()) {
      for (const f of book.files) {
        if (files.has(f.path)) continue;
        const same = [...files.values()].filter((c) => !taken.has(c.path) && c.size === f.size && formatOf(c.name) === f.format);
        if (same.length !== 1) continue;
        taken.add(same[0].path);
        f.path = same[0].path;
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  // ------------------------------------------------------------- looking up

  #fileRecord(fileId) {
    for (const book of this.books.values()) {
      const file = book.files.find((f) => f.id === fileId);
      if (file) return { book, file };
    }
    return null;
  }

  #byPath(relPath) {
    for (const book of this.books.values()) {
      const file = book.files.find((f) => f.path === relPath);
      if (file) return { book, file };
    }
    return null;
  }

  /** Where a collected file is on disk, for sending it to the reader app. */
  fileOnDisk(fileId) {
    const found = this.#fileRecord(text(fileId, 40));
    if (!found) return null;
    const abs = this.#inside(found.file.path);
    if (!abs) return null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      return { abs, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), name: path.basename(found.file.path), format: found.file.format };
    } catch {
      return null;
    }
  }

  byHardcoverId(hardcoverId) {
    for (const book of this.books.values()) if (book.hardcoverId === hardcoverId) return book;
    return null;
  }

  // ------------------------------------------------------------ what to show

  #publicFile(file, onDisk) {
    return {
      id: file.id,
      name: path.basename(file.path),
      path: file.path,
      format: file.format,
      kind: kindOf(file.format),
      size: onDisk?.size ?? file.size,
      addedAt: file.addedAt,
      // Changes when the file itself does, so the reader app knows to fetch it again.
      version: `${onDisk?.size ?? file.size}-${onDisk?.mtimeMs ?? 0}`,
      missing: !onDisk || undefined,
    };
  }

  #coverStamp(book) {
    if (book.coverUrl) return crypto.createHash('sha1').update(book.coverUrl).digest('hex').slice(0, 10);
    const own = book.files.find((f) => f.hasCover);
    return own ? `f${own.id.slice(1)}` : '';
  }

  #publicBook(book, files, account) {
    const mine = this.progress[account] || {};
    let progress = null;
    for (const f of book.files) {
      const p = mine[f.id];
      if (p && (!progress || p.updatedAt > progress.updatedAt)) progress = { file: f.id, ...p };
    }
    return {
      id: book.id,
      hardcoverId: book.hardcoverId || undefined,
      title: book.title,
      subtitle: book.subtitle || undefined,
      authors: book.authors,
      series: book.series || undefined,
      year: book.year ?? undefined,
      pages: book.pages ?? undefined,
      description: book.description || undefined,
      slug: book.slug || undefined,
      color: book.color || undefined,
      cover: this.#coverStamp(book) || undefined,
      addedAt: book.addedAt,
      files: book.files.map((f) => this.#publicFile(f, files.get(f.path))),
      progress: progress || undefined,
    };
  }

  /** Everything the Collection page and the reader app show. */
  list(account) {
    const files = this.scan();
    const taken = new Set();
    for (const book of this.books.values()) for (const f of book.files) taken.add(f.path);
    const loose = [...files.values()]
      .filter((f) => !taken.has(f.path))
      .map((f) => ({ path: f.path, name: f.name, size: f.size, modifiedAt: f.mtimeMs, format: formatOf(f.name), kind: kindOf(formatOf(f.name)) }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    return {
      books: [...this.books.values()].map((b) => this.#publicBook(b, files, account)).sort((a, b) => b.addedAt - a.addedAt),
      loose,
    };
  }

  /** Which Hardcover books are in the collection, for the marks on the Library page: id -> formats. */
  owned() {
    const out = {};
    for (const book of this.books.values()) {
      if (book.hardcoverId) out[book.hardcoverId] = { id: book.id, formats: [...new Set(book.files.map((f) => f.format))] };
    }
    return out;
  }

  /**
   * What a loose file says about itself, and the words to look it up with.
   * @returns {{path: string, name: string, format: string, embedded: object|null, query: string, problem?: string}}
   */
  describeFile(relPath) {
    const abs = this.#inside(relPath);
    const known = abs && this.scan().get(path.relative(this.downloadDir, abs).split(path.sep).join('/'));
    if (!known) throw new CollectionError('That file is no longer in the download folder.', 404);
    const format = formatOf(known.name);
    let embedded = null;
    let problem;
    if (format === 'epub') {
      try {
        const meta = readEpub(abs);
        embedded = { title: meta.title, authors: meta.authors, series: meta.series, year: meta.year, hasCover: meta.hasCover };
      } catch (err) {
        problem = err instanceof EpubError ? err.message : 'This epub could not be read.';
      }
    }
    const query = embedded?.title
      ? `${embedded.title} ${embedded.authors[0] || ''}`.trim()
      : nameQuery(known.name);
    return { path: known.path, name: known.name, format, kind: kindOf(format), size: known.size, embedded, query, problem };
  }

  // -------------------------------------------------------------- changing

  /**
   * Tie a file in the download folder to a title.
   *
   * @param {string} relPath the file, as a path inside the download folder
   * @param {object} title   `{hardcoverId, ...facts}` for a Hardcover book, or `{...facts}` typed in or
   *                         taken from the file; with neither title nor id, the file's own details are used
   * @returns {object} the book as stored
   */
  attach(relPath, title = {}) {
    const info = this.describeFile(relPath);
    const existing = this.#byPath(info.path);
    if (existing) this.#detachRecord(existing.book, existing.file, { keepProgress: true });

    const hardcoverId = Number.isInteger(title.hardcoverId) && title.hardcoverId > 0 ? title.hardcoverId : null;
    let facts;
    if (hardcoverId || text(title.title)) {
      facts = bookFacts(title);
    } else {
      // No title given: the file speaks for itself.
      const e = info.embedded;
      facts = bookFacts(e?.title ? e : { title: nameQuery(info.name) });
    }

    let book = hardcoverId ? this.byHardcoverId(hardcoverId) : null;
    if (!book && !hardcoverId) {
      const key = titleKey(facts);
      book = [...this.books.values()].find((b) => !b.hardcoverId && titleKey(b) === key) || null;
    }
    if (book) {
      // A known title gets another file. Fresh facts from Hardcover replace the old ones.
      if (hardcoverId) Object.assign(book, facts);
    } else {
      book = { id: `b${++this.seq}`, hardcoverId, ...facts, addedAt: Date.now(), files: [] };
      this.books.set(book.id, book);
    }
    const file = {
      id: existing?.file.id || `f${++this.seq}`,
      path: info.path,
      size: info.size,
      format: info.format,
      hasCover: Boolean(info.embedded?.hasCover),
      addedAt: Date.now(),
    };
    book.files.push(file);
    this.#changed();
    return book;
  }

  #detachRecord(book, file, { keepProgress = false } = {}) {
    book.files = book.files.filter((f) => f !== file);
    if (!keepProgress) for (const mine of Object.values(this.progress)) delete mine[file.id];
    if (!book.files.length) {
      this.books.delete(book.id);
      this.#dropCovers(book.id);
    }
  }

  /** Untie a file from its title. The file stays in the folder. A title without files leaves the collection. */
  detach(fileId) {
    const found = this.#fileRecord(text(fileId, 40));
    if (!found) throw new CollectionError('That file is not in the collection.', 404);
    this.#detachRecord(found.book, found.file);
    this.#changed();
  }

  /** Take a title out of the collection. Its files stay in the folder. */
  remove(bookId) {
    const book = this.books.get(text(bookId, 40));
    if (!book) throw new CollectionError('That book is not in the collection.', 404);
    for (const file of [...book.files]) this.#detachRecord(book, file);
    this.books.delete(book.id);
    this.#dropCovers(book.id);
    this.#changed();
  }

  // ------------------------------------------------- downloads asked for a book

  /** Remember that a list command was asked for with a book in mind. */
  expect(command, hardcoverId, account) {
    const key = text(command, 500);
    if (!key || !Number.isInteger(hardcoverId)) return;
    this.expected.delete(key);
    this.expected.set(key, { hardcoverId, account, at: Date.now() });
    while (this.expected.size > MAX_EXPECTED) this.expected.delete(this.expected.keys().next().value);
    this.#save();
  }

  /**
   * A download finished. If it was asked for from a book's page, tie it to that book.
   * @param {{command: string, file: string}} item the finished queue entry
   * @param {(hardcoverId: number, account: string) => object | null} findBook the book's facts
   * @returns {object | null} the book it was added to
   */
  downloaded(item, findBook) {
    const entry = item.command && this.expected.get(item.command);
    if (!entry || !item.file) return null;
    this.expected.delete(item.command);
    const facts = findBook(entry.hardcoverId, entry.account);
    if (!facts) {
      this.#save();
      return null;
    }
    try {
      this.scan({ force: true });
      return this.attach(item.file, { ...facts, hardcoverId: entry.hardcoverId });
    } catch (err) {
      console.error(`Could not add "${item.file}" to the collection: ${err.message}`);
      this.#save();
      return null;
    }
  }

  // --------------------------------------------------------------- progress

  getProgress(account, fileId) {
    return this.progress[account]?.[fileId] || null;
  }

  /**
   * Remember where the reader is. The newer of what is stored and what is sent wins,
   * so a phone that was offline for a while cannot wind a book back.
   * @returns {object} what is stored afterwards
   */
  setProgress(account, fileId, input) {
    const found = this.#fileRecord(text(fileId, 40));
    if (!found) throw new CollectionError('That file is not in the collection.', 404);
    const fraction = Number(input?.fraction);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new CollectionError('That is not a place in the book.');
    const now = Date.now();
    const updatedAt = Math.min(Number.isFinite(Number(input.updatedAt)) && Number(input.updatedAt) > 0 ? Number(input.updatedAt) : now, now);
    const mine = this.progress[account] || (this.progress[account] = {});
    const stored = mine[found.file.id];
    if (stored && stored.updatedAt >= updatedAt) return stored;

    const locator = {};
    const l = input.locator && typeof input.locator === 'object' ? input.locator : {};
    if (Number.isInteger(l.spine) && l.spine >= 0) locator.spine = l.spine;
    if (typeof l.href === 'string') locator.href = l.href.slice(0, 500);
    if (Number.isFinite(l.inner) && l.inner >= 0 && l.inner <= 1) locator.inner = l.inner;
    if (typeof l.chapter === 'string') locator.chapter = l.chapter.slice(0, 200);

    mine[found.file.id] = {
      fraction,
      locator,
      updatedAt,
      device: text(input.device, 80),
      finished: fraction >= 0.995 || undefined,
    };
    this.#changed();
    return mine[found.file.id];
  }

  // ----------------------------------------------------------------- covers

  #dropCovers(bookId) {
    try {
      for (const name of fs.readdirSync(this.coverDir)) {
        if (name.startsWith(`${bookId}-`)) fs.rmSync(path.join(this.coverDir, name), { force: true });
      }
    } catch {
      // no covers were kept yet
    }
  }

  /**
   * A book's cover: Hardcover's if it has one, otherwise the one inside the epub.
   * Fetched or unpacked once, then kept.
   * @returns {Promise<{file: string, type: string} | null>}
   */
  async cover(bookId) {
    const book = this.books.get(text(bookId, 40));
    if (!book) return null;
    const stamp = this.#coverStamp(book);
    if (!stamp) return null;
    const stem = path.join(this.coverDir, `${book.id}-${stamp}`);
    for (const [ext, type] of Object.entries(COVER_EXTS)) {
      if (fs.existsSync(stem + ext)) return { file: stem + ext, type };
    }
    let job = this.coverJobs.get(stem);
    if (!job) {
      job = this.#makeCover(book, stem).finally(() => this.coverJobs.delete(stem));
      this.coverJobs.set(stem, job);
    }
    return job;
  }

  async #makeCover(book, stem) {
    fs.mkdirSync(this.coverDir, { recursive: true });
    if (book.coverUrl) {
      const fetched = await this.fetchCover(book.coverUrl, stem);
      if (fetched) return fetched;
    }
    for (const f of book.files) {
      if (!f.hasCover) continue;
      const abs = this.#inside(f.path);
      try {
        const { cover } = readEpub(abs, { cover: true });
        if (!cover) continue;
        // Kept under the stamp that was asked for, so it is found again next time.
        const tmp = `${stem}.tmp-${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tmp, cover.data);
        fs.renameSync(tmp, stem + cover.ext);
        return { file: stem + cover.ext, type: cover.type };
      } catch {
        // try the next file
      }
    }
    return null;
  }
}

/**
 * The books of a Hardcover library that a file most likely is, best first.
 * A book counts when every telling word of its title is in the file's words;
 * the author's surname being there too puts it ahead.
 */
export function guessBooks(query, books, limit = 6) {
  const typed = words(query);
  if (!typed.length) return [];
  const exact = new Set(typed);
  // As in the search: a longer word may be the start of one in the file name ("ender" in "enders").
  const has = (w) => exact.has(w) || (w.length >= 4 && typed.some((t) => t.startsWith(w)));
  const scored = [];
  for (const book of books) {
    const title = words(book.title).filter((w) => w.length > 1);
    if (!title.length) continue;
    const hit = title.filter(has).length;
    const telling = title.filter((w) => w.length > 3);
    const allTelling = telling.length ? telling.every(has) : hit === title.length;
    if (!allTelling || hit === 0) continue;
    const surname = words(book.authors?.[0] || '').pop();
    const author = surname && has(surname) ? 1 : 0;
    scored.push({ book, score: hit / title.length + author * 2 + Math.min(title.length, 6) / 10 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.book);
}
