// The Library page: the books and lists from someone's Hardcover account.
// Picking a book looks for it in the loaded lists.

import { getJson, h, icon, n, plural, postJson, setChildren, toast } from './dom.js';
import { hardcoverSignInUrl, hardcoverUser } from './session.js';

export const STATUS = {
  want: 'Want to read',
  reading: 'Reading',
  read: 'Read',
  paused: 'Paused',
  dnf: 'Did not finish',
  ignored: 'Ignored',
};
const SHELVES = ['want', 'reading', 'read', 'paused', 'dnf', 'ignored'];
// Not a status on Hardcover: the books that have a file in the collection.
const HAVE = 'have';

const SORTS = [
  ['added', 'Recently added'],
  ['list', 'List order'],
  ['title', 'Title'],
  ['author', 'Author'],
  ['series', 'Series'],
  ['myRating', 'Your rating'],
  ['rating', 'Hardcover rating'],
  ['year', 'Newest first'],
  ['finished', 'Recently finished'],
];

const PAGE = 120;
const FRESH_MS = 60 * 1000;
const PREFS_KEY = 'shelfmark.library';

// Kept while the page is open, so coming back from a search lands where you left.
const memory = { data: null, loadedAt: 0, filter: '', shown: PAGE, scrollY: 0, restore: false, owned: {} };
const prefs = { sort: 'added', layout: 'grid' };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
} catch {
  // start with the defaults
}
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // not remembered, that is all
  }
};

let view = null;

// ------------------------------------------------------------- wording

function fold(text) {
  return String(text || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

const sortTitle = (title) => fold(title).replace(/^(the|a|an)\s+/, '');
const surname = (name) => fold(name).trim().split(/\s+/).pop() || '';

export function seriesLabel(series) {
  if (!series) return '';
  return series.position != null ? `${series.name} #${series.position}` : series.name;
}

/** 47880 -> "13 h 18 min" */
export function audioLength(seconds) {
  if (!seconds) return '';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} min`;
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export function day(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 14 ? `${plural(days, 'day')} ago` : `on ${day(iso)}`;
}

const stars = (value) => `★ ${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// ------------------------------------------------------------- pieces

/**
 * A book's cover, or a block with its title when there is none.
 * `src` is where the image is, for covers that are not the Hardcover library's; '' for none.
 */
export function coverEl(book, src) {
  const box = h('span', { class: 'book-cover' });
  const blank = () => {
    box.classList.add('is-blank');
    if (book.color) box.style.backgroundColor = book.color;
    box.replaceChildren(h('span', { class: 'book-cover-title' }, book.title));
  };
  if (src === undefined ? !book.cover : !src) {
    blank();
    return box;
  }
  if (book.color) box.style.backgroundColor = book.color;
  const img = h('img', {
    src: src || `/api/hardcover/cover?book=${book.id}&v=${book.cover}`,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    width: '200',
    height: '300',
  });
  img.addEventListener('error', blank, { once: true });
  box.append(img);
  return box;
}

export function statusEl(status) {
  return status && STATUS[status] ? h('span', { class: `status is-${status}` }, STATUS[status]) : null;
}

function bookItem(book) {
  const extra = [
    book.year,
    book.format === 'audio' && book.audioSeconds ? audioLength(book.audioSeconds) : book.pages ? `${n(book.pages)} pages` : '',
    book.rating ? stars(book.rating) : '',
  ].filter(Boolean).join(' · ');
  return h('li', null, h('button', {
    type: 'button',
    class: 'book',
    'data-id': String(book.id),
    title: `Look for “${book.title}” in the lists`,
  },
    coverEl(book),
    h('span', { class: 'book-main' },
      h('span', { class: 'book-title' }, book.title),
      book.authors.length ? h('span', { class: 'book-author' }, book.authors.join(', ')) : null,
      book.series ? h('span', { class: 'book-series' }, seriesLabel(book.series)) : null,
    ),
    h('span', { class: 'book-tags' },
      statusEl(book.status),
      memory.owned[book.id] ? h('span', { class: 'status is-have', title: `In your collection: ${memory.owned[book.id].formats.join(', ')}` }, 'Have it') : null,
      book.myRating ? h('span', { class: 'book-stars', title: `You rated it ${book.myRating} out of 5` }, stars(book.myRating)) : null,
    ),
    h('span', { class: 'book-extra' }, extra),
    h('span', { class: 'book-date' }, book.added ? day(book.added) : ''),
  ));
}

// --------------------------------------------------------------- the page

const compare = {
  added: (a, b) => (b.added || '').localeCompare(a.added || '') || sortTitle(a.title).localeCompare(sortTitle(b.title)),
  title: (a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)),
  author: (a, b) => surname(a.authors[0]).localeCompare(surname(b.authors[0])) || compare.series(a, b),
  series: (a, b) => {
    // Books of one series sit together in reading order; books without one follow, by title.
    if (!a.series !== !b.series) return a.series ? -1 : 1;
    if (!a.series) return compare.title(a, b);
    return fold(a.series.name).localeCompare(fold(b.series.name))
      || (a.series.position ?? 1e9) - (b.series.position ?? 1e9)
      || compare.title(a, b);
  },
  myRating: (a, b) => (b.myRating || 0) - (a.myRating || 0) || compare.title(a, b),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || compare.title(a, b),
  year: (a, b) => (b.year || 0) - (a.year || 0) || compare.title(a, b),
  finished: (a, b) => (b.finished || '').localeCompare(a.finished || '') || compare.added(a, b),
};

/**
 * Build the Library page inside `container`.
 *
 * @param {HTMLElement} container
 * @param {object} o
 * @param {string} o.shelf         a status to show ("want", "read", ...) or "" for every book
 * @param {string} o.list          the id of a Hardcover list to show, or ""
 * @param {(change: {shelf?: string, list?: string}) => void} o.onChange  the choice changed
 * @param {(book: object) => Promise<void>} o.onOpen  a book was picked
 */
export function mountLibrary(container, o) {
  unmountLibrary();
  const state = { shelf: o.shelf || '', list: o.list || '', alive: true, timer: null };
  // Coming back after picking a book: show the page as it was left.
  const restore = memory.restore;
  memory.restore = false;
  if (!restore) {
    memory.shown = PAGE;
    memory.scrollY = 0;
  }

  const meta = h('p', { class: 'place-meta' });
  const notes = h('div');
  const shelves = h('div', { class: 'shelves', role: 'group', 'aria-label': 'Which books to show' });
  const filter = h('input', {
    type: 'search', class: 'lib-input', placeholder: 'Filter by title, author or series',
    'aria-label': 'Filter the books', spellcheck: 'false', autocomplete: 'off',
  });
  filter.value = memory.filter;
  const listSelect = h('select', { class: 'lib-input', 'aria-label': 'Show one of your lists' });
  const sortSelect = h('select', { class: 'lib-input', 'aria-label': 'Sort the books' });
  const layout = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Layout' },
    h('button', { type: 'button', 'data-layout': 'grid' }, 'Covers'),
    h('button', { type: 'button', 'data-layout': 'rows' }, 'Table'),
  );
  const count = h('p', { class: 'summary lib-count', 'aria-live': 'polite' });
  const bar = h('div', { class: 'lib-bar', hidden: true },
    shelves,
    h('div', { class: 'lib-tools' }, filter, listSelect, sortSelect, layout),
  );
  const grid = h('ul', { class: 'books' });
  const more = h('div', { class: 'more' });
  const body = h('div');

  container.replaceChildren(
    h('div', { class: 'place' }, h('h1', null, 'Library'), meta),
    notes, bar, count, body,
  );

  let matching = [];
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && memory.shown < matching.length) {
      const from = memory.shown;
      memory.shown += PAGE;
      grid.append(...matching.slice(from, memory.shown).map(bookItem));
      if (memory.shown >= matching.length) observer.disconnect();
    }
  }, { rootMargin: '900px 0px' });

  function message(title, text, ...actions) {
    bar.hidden = true;
    count.textContent = '';
    setChildren(body, h('div', { class: 'notice' },
      h('h1', null, title),
      h('p', null, text),
      actions.length ? h('div', { class: 'drop-actions' }, actions) : null,
    ));
  }

  const signInLink = (label) => h('a', { class: 'button is-primary', href: hardcoverSignInUrl('/?v=library') }, label);

  function renderMeta() {
    const data = memory.data;
    const user = data?.user;
    const parts = [];
    if (user) parts.push(`@${user.username} on Hardcover`);
    if (data?.sync.running) {
      parts.push(`${data.sync.phase || 'Syncing'}${data.sync.count ? ` (${n(data.sync.count)})` : ''}…`);
    } else if (data?.syncedAt) {
      parts.push(`synced ${ago(data.syncedAt)}`);
    }
    const syncButton = h('button', {
      type: 'button', class: 'text-button', disabled: Boolean(data?.sync.running), onclick: () => sync(),
    }, data?.sync.running ? 'Syncing…' : 'Sync now');
    setChildren(meta, parts.join(' · '), parts.length ? ' · ' : null, data && !user?.signInAgain ? syncButton : null);

    const out = [];
    if (user?.signInAgain) {
      out.push(h('div', { class: 'callout is-error lib-callout', role: 'alert' },
        h('span', null, 'Hardcover needs you to sign in again before the library can be synced.'),
        h('a', { class: 'button', href: hardcoverSignInUrl('/?v=library') }, 'Sign in with Hardcover'),
      ));
    } else if (data?.sync.error && !data.sync.running) {
      out.push(h('div', { class: 'callout is-error lib-callout', role: 'alert' },
        h('span', null, `The last sync did not work: ${data.sync.error}`),
        h('button', { type: 'button', class: 'button', onclick: () => sync() }, 'Try again'),
      ));
    }
    for (const warning of data?.warnings || []) out.push(h('p', { class: 'callout is-error' }, warning));
    setChildren(notes, out);
  }

  function renderControls() {
    const { books, lists } = memory.data;
    if (state.list && !lists.some((l) => String(l.id) === state.list)) state.list = '';
    // With a list chosen, the tabs count the books of that list.
    const list = state.list ? lists.find((l) => String(l.id) === state.list) : null;
    const inList = list ? new Set(list.bookIds) : null;
    const pool = inList ? books.filter((b) => inList.has(b.id)) : books;
    const counts = Object.fromEntries(SHELVES.map((s) => [s, 0]));
    for (const book of pool) if (book.status) counts[book.status] += 1;
    const inLibrary = inList ? pool.length : pool.filter((b) => b.status && b.status !== 'ignored').length;
    const have = pool.filter((b) => memory.owned[b.id]).length;
    if (state.shelf && !(state.shelf === HAVE ? have : counts[state.shelf])) state.shelf = '';

    const tab = (value, label, total) => h('button', {
      type: 'button', class: 'shelf-tab', 'aria-pressed': String(state.shelf === value),
      onclick: () => choose({ shelf: value }),
    }, label, h('span', { class: 'shelf-tab-count' }, n(total)));
    setChildren(shelves,
      tab('', 'All', inLibrary),
      SHELVES.filter((s) => counts[s]).map((s) => tab(s, STATUS[s], counts[s])),
      have ? tab(HAVE, 'In my collection', have) : null,
    );

    listSelect.hidden = lists.length === 0;
    setChildren(listSelect,
      h('option', { value: '' }, 'All your books'),
      lists.map((l) => h('option', { value: String(l.id) }, `List: ${l.name} (${n(l.bookIds.length)})`)),
    );
    listSelect.value = state.list;

    if (prefs.sort === 'list' && !state.list) prefs.sort = 'added';
    setChildren(sortSelect, SORTS
      .filter(([value]) => value !== 'list' || state.list)
      .map(([value, label]) => h('option', { value }, label)));
    sortSelect.value = prefs.sort;
    if (sortSelect.value !== prefs.sort) sortSelect.value = prefs.sort = 'added';

    for (const button of layout.children) button.setAttribute('aria-pressed', String(button.dataset.layout === prefs.layout));
    bar.hidden = false;
  }

  function renderBooks({ keep = false } = {}) {
    const { books, lists } = memory.data;
    const list = state.list ? lists.find((l) => String(l.id) === state.list) : null;
    const order = list ? new Map(list.bookIds.map((id, i) => [id, i])) : null;
    const needle = fold(memory.filter.trim());
    const terms = needle ? needle.split(/\s+/) : [];

    matching = books.filter((book) => {
      if (list ? !order.has(book.id) : !book.status) return false;
      if (state.shelf === HAVE) {
        if (!memory.owned[book.id]) return false;
      } else if (state.shelf ? book.status !== state.shelf : (!list && book.status === 'ignored')) return false;
      if (!terms.length) return true;
      const hay = fold(`${book.title} ${book.subtitle || ''} ${book.authors.join(' ')} ${book.series?.name || ''} ${(book.genres || []).join(' ')}`);
      return terms.every((t) => hay.includes(t));
    });
    matching.sort(prefs.sort === 'list' && order ? (a, b) => order.get(a.id) - order.get(b.id) : compare[prefs.sort] || compare.added);

    if (!keep) memory.shown = PAGE;
    observer.disconnect();
    grid.className = `books${prefs.layout === 'rows' ? ' is-rows' : ''}`;
    grid.replaceChildren(...matching.slice(0, memory.shown).map(bookItem));

    const where = list ? `in “${list.name}”` : state.shelf === HAVE ? 'in your collection' : state.shelf ? `marked ${STATUS[state.shelf].toLowerCase()}` : 'in your library';
    count.replaceChildren();
    if (matching.length) {
      count.append(h('strong', null, plural(matching.length, 'book')), ` ${where}${terms.length ? ' match the filter' : ''}. Pick one to look for it in the lists.`);
      setChildren(body, grid, more);
      if (memory.shown < matching.length) observer.observe(more);
    } else if (terms.length) {
      setChildren(body, h('div', { class: 'notice' },
        h('h1', null, `No books match “${memory.filter.trim()}”`),
        h('p', null, `Nothing ${where} has those words in its title, author, series or genre.`),
        h('button', {
          type: 'button', class: 'button',
          onclick: () => {
            filter.value = memory.filter = '';
            renderBooks();
            filter.focus();
          },
        }, 'Clear the filter'),
      ));
    } else {
      setChildren(body, h('div', { class: 'notice' },
        h('h1', null, list ? 'This list is empty' : 'No books here yet'),
        h('p', null, list
          ? 'Add books to it on Hardcover, then sync.'
          : 'Books you mark as want to read, reading or read on Hardcover show up here after a sync.'),
      ));
    }
  }

  function render({ keep = false } = {}) {
    renderMeta();
    const data = memory.data;
    if (!data.syncedAt) {
      if (data.sync.running) {
        message('Fetching your library', 'Your books and lists are being read from Hardcover. A big library takes a minute or two; the page continues on its own.');
        body.firstChild.append(h('div', { class: 'progress' },
          h('div', { class: 'progress-track is-unknown' }, h('div', { class: 'progress-bar' }))));
      } else if (!data.user?.signInAgain && !data.sync.error) {
        message('Your library has not been fetched yet', 'Fetch your books and lists from Hardcover to see them here.',
          h('button', { type: 'button', class: 'button is-primary', onclick: () => sync() }, icon('sync'), 'Fetch my library'));
      } else {
        message('Your library could not be fetched', 'See the note above.');
      }
      return;
    }
    renderControls();
    renderBooks({ keep });
  }

  function choose(change) {
    if (change.list !== undefined && change.list !== state.list) {
      prefs.sort = change.list ? 'list' : prefs.sort === 'list' ? 'added' : prefs.sort;
      change.shelf = ''; // a list is shown whole to begin with
    }
    Object.assign(state, change);
    o.onChange({ shelf: state.shelf, list: state.list });
    renderControls();
    renderBooks();
  }

  async function watchSync() {
    clearTimeout(state.timer);
    if (!state.alive || !memory.data?.sync.running) return;
    state.timer = setTimeout(async () => {
      if (!state.alive) return;
      try {
        const s = await getJson('/api/hardcover/sync');
        if (!state.alive) return;
        if (s.sync.running) {
          memory.data.sync = s.sync;
          renderMeta();
          watchSync();
        } else {
          await load({ quiet: true });
        }
      } catch {
        watchSync();
      }
    }, 1200);
  }

  async function sync() {
    try {
      const res = await postJson('/api/hardcover/sync');
      if (!state.alive) return;
      memory.data.sync = res.sync;
      render({ keep: true });
      watchSync();
    } catch (err) {
      toast(err.message);
    }
  }

  async function load({ quiet = false } = {}) {
    if (!quiet && !memory.data) message('Loading your library', 'One moment.');
    try {
      // Which of these books have a file is asked alongside; the page works without the answer.
      const [data, have] = await Promise.all([
        getJson('/api/hardcover/library'),
        getJson('/api/collection/owned').catch(() => null),
      ]);
      if (!state.alive) return;
      memory.data = data;
      if (have) memory.owned = have.owned;
      memory.loadedAt = Date.now();
      render({ keep: quiet });
      watchSync();
    } catch (err) {
      if (!state.alive) return;
      if (err.body?.connect) {
        memory.data = null;
        meta.textContent = '';
        message('Connect your Hardcover account',
          'Sign in with Hardcover to see the books you want to read, are reading and have read, and to look for any of them in the lists.',
          signInLink('Connect Hardcover'));
      } else {
        message('Your library could not be loaded',
          err.status ? err.message : 'The server did not answer. Check that it is running, then try again.',
          h('button', { type: 'button', class: 'button', onclick: () => load() }, 'Try again'));
      }
    }
  }

  let typing = null;
  filter.addEventListener('input', () => {
    memory.filter = filter.value;
    clearTimeout(typing);
    typing = setTimeout(() => renderBooks(), 120);
  });
  listSelect.addEventListener('change', () => choose({ list: listSelect.value }));
  sortSelect.addEventListener('change', () => {
    prefs.sort = sortSelect.value;
    savePrefs();
    renderBooks();
  });
  layout.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-layout]');
    if (!button) return;
    prefs.layout = button.dataset.layout;
    savePrefs();
    renderControls();
    renderBooks({ keep: true });
  });
  grid.addEventListener('click', async (e) => {
    const button = e.target.closest('.book');
    if (!button || button.getAttribute('aria-busy') === 'true') return;
    const book = memory.data.books.find((b) => String(b.id) === button.dataset.id);
    if (!book) return;
    memory.scrollY = window.scrollY;
    memory.restore = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await o.onOpen(book);
    } finally {
      button.removeAttribute('aria-busy');
    }
  });

  view = {
    stop() {
      state.alive = false;
      clearTimeout(state.timer);
      clearTimeout(typing);
      observer.disconnect();
    },
  };

  if (!hardcoverUser()) {
    message('Connect your Hardcover account',
      'Sign in with Hardcover to see the books you want to read, are reading and have read, and to look for any of them in the lists.',
      signInLink('Connect Hardcover'));
    return;
  }
  if (memory.data) {
    render({ keep: restore });
    requestAnimationFrame(() => window.scrollTo({ top: restore ? memory.scrollY : 0 }));
    watchSync();
    if (Date.now() - memory.loadedAt > FRESH_MS) load({ quiet: true });
  } else {
    window.scrollTo({ top: 0 });
    load();
  }
}

export function unmountLibrary() {
  view?.stop();
  view = null;
}

/** Forget what was loaded, such as after signing out or disconnecting. */
export function forgetLibrary() {
  memory.data = null;
  memory.loadedAt = 0;
}

/** The collection changed: the "Have it" marks are fetched again the next time the page is shown. */
export function staleLibrary() {
  memory.loadedAt = 0;
}
