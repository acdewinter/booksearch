// The Collection page: the books you have, each tied to files in the
// download folder, how far each has been read in the reader app, and the
// files that still have to be given a title.

import { $, askConfirm, formatBytes, getJson, h, icon, n, plural, postJson, setChildren, toast } from './dom.js';
import { ago, coverEl, day, seriesLabel } from './library.js';
import { hardcoverSignInUrl, session } from './session.js';

const PREFS_KEY = 'shelfmark.collection';
const SORTS = [
  ['added', 'Recently added'],
  ['read', 'Recently read'],
  ['title', 'Title'],
  ['author', 'Author'],
];

const memory = { data: null, filter: '' };
const prefs = { sort: 'added' };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
} catch {
  // start with the defaults
}

let view = null;

const fold = (text) => String(text || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
const sortTitle = (title) => fold(title).replace(/^(the|a|an)\s+/, '');
const surname = (name) => fold(name).trim().split(/\s+/).pop() || '';

const KIND = { ebook: 'Ebook', audio: 'Audio', archive: 'Archive', other: 'File' };

/** "epub" -> "EPUB" */
const formatLabel = (format) => (format ? format.toUpperCase() : 'FILE');

const coverSrc = (book) => `/api/collection/cover?book=${encodeURIComponent(book.id)}&v=${book.cover}`;

/** "42%", or "Finished". */
function progressLabel(progress) {
  if (!progress) return '';
  if (progress.finished) return 'Finished';
  return `${Math.max(1, Math.round(progress.fraction * 100))}%`;
}

function progressBar(progress) {
  const pct = Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100);
  const bar = h('span', { class: 'read-bar' });
  bar.style.width = `${pct}%`; // set this way because the page's rules forbid style attributes
  return h('span', {
    class: 'read-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
    'aria-label': `Read ${pct}%`,
  }, bar);
}

const readable = (book) => book.files.some((f) => f.format === 'epub' && !f.missing);

// ------------------------------------------------------------- the dialogs

/** Tie a loose file to a title: from the library, from Hardcover, or with the file's own details. */
function openAttach(file, { onDone }) {
  const dialog = $('attach-dialog');
  const body = $('attach-body');
  let alive = true;
  let typing = null;
  let asked = 0;
  let info = null;

  const says = h('p', { class: 'attach-says' });
  const input = h('input', {
    type: 'search', class: 'lib-input attach-input', placeholder: 'Title and author', 'aria-label': 'Look for the book',
    spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search',
  });
  const results = h('div', { class: 'attach-results', 'aria-live': 'polite' });
  const note = h('div', { class: 'attach-note' });
  const ownTitle = h('input', { type: 'text', id: 'attach-title', autocomplete: 'off' });
  const ownAuthors = h('input', { type: 'text', id: 'attach-authors', autocomplete: 'off' });
  const ownSubmit = h('button', { type: 'submit', class: 'button' }, 'Add with these details');
  const own = h('details', { class: 'more-options' },
    h('summary', null, 'Not on Hardcover? Add it by hand'),
    h('form', { class: 'form', onsubmit: (e) => {
      e.preventDefault();
      attach({ title: ownTitle.value, authors: ownAuthors.value }, ownSubmit);
    } },
      h('div', { class: 'field' }, h('label', { for: 'attach-title' }, 'Title'), ownTitle),
      h('div', { class: 'field' }, h('label', { for: 'attach-authors' }, 'Author'), ownAuthors,
        h('p', { class: 'field-hint' }, 'Leave both as they are to use what the file says about itself.')),
      h('div', { class: 'form-actions' }, ownSubmit),
    ),
  );

  setChildren(body,
    h('p', { class: 'dl-name attach-file' }, file.name),
    says,
    h('form', { class: 'attach-search', role: 'search', onsubmit: (e) => {
      e.preventDefault();
      clearTimeout(typing);
      look();
    } }, input, h('button', { type: 'submit', class: 'button' }, 'Look up')),
    results,
    note,
    own,
  );

  async function attach(choice, button) {
    button.disabled = true;
    try {
      const res = await postJson('/api/collection/attach', { path: file.path, ...choice });
      dialog.close();
      toast(`Added to your collection: ${res.book.title}`, { done: true });
      onDone();
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  }

  function choiceButton(book) {
    const src = book.cover === 'library'
      ? `/api/hardcover/cover?book=${book.id}&v=${book.coverStamp}`
      : `/api/collection/lookup-cover?id=${book.id}&v=${book.coverStamp}`;
    const facts = [book.authors.join(', '), book.series ? seriesLabel(book.series) : '', book.year].filter(Boolean).join(' · ');
    const button = h('button', { type: 'button', class: 'choice', onclick: () => attach({ hardcoverId: book.id }, button) },
      coverEl(book, book.cover ? src : ''),
      h('span', { class: 'choice-main' },
        h('span', { class: 'choice-title' }, book.title),
        book.subtitle ? h('span', { class: 'choice-facts' }, book.subtitle) : null,
        h('span', { class: 'choice-facts' }, facts || 'Author unknown'),
        h('span', { class: 'book-tags' },
          h('span', { class: `status${book.inLibrary ? ' is-read' : ''}` }, book.inLibrary ? 'In your library' : 'On Hardcover'),
          book.inCollection ? h('span', { class: 'status is-reading' }, 'Already has a file') : null,
        ),
      ),
    );
    return button;
  }

  function renderResults(found, { looking = false } = {}) {
    const all = [...found.library, ...found.catalog];
    if (all.length) {
      setChildren(results, all.map(choiceButton));
    } else if (looking) {
      setChildren(results, h('p', { class: 'dl-empty' }, 'Looking…'));
    } else if (!found.can.connected) {
      setChildren(results);
    } else {
      setChildren(results, h('p', { class: 'dl-empty' }, found.q
        ? `Nothing ${found.can.catalog ? 'on Hardcover' : 'in your Hardcover library'} matches “${found.q}”.`
        : 'Type a title to look for.'));
    }

    const notes = [];
    if (found.catalogError) notes.push(h('p', { class: 'callout is-error' }, `Hardcover could not be searched: ${found.catalogError}`));
    if (!found.can.hardcover) {
      notes.push(h('p', { class: 'field-hint' }, 'Hardcover is not set up on this server, so titles cannot be looked up. The file can still be added with its own details.'));
    } else if (!found.can.connected) {
      notes.push(h('p', { class: 'field-hint' },
        'Connect your Hardcover account to tie files to its books. ',
        h('a', { class: 'text-button', href: hardcoverSignInUrl('/?v=collection') }, 'Connect Hardcover')));
    } else if (!found.can.catalog) {
      notes.push(h('p', { class: 'field-hint' },
        'Only the books in your Hardcover library are looked in. To find any book, allow the scope ',
        h('code', null, 'read:catalog:search'), ' on your app at hardcover.app, then ',
        h('a', { class: 'text-button', href: '/auth/hardcover?catalog=1&next=%2F%3Fv%3Dcollection' }, 'sign in once more'), '.'));
    }
    setChildren(note, notes);
  }

  async function look() {
    const q = input.value.trim();
    const mine = ++asked;
    if (!q) {
      renderResults({ q: '', library: info?.guesses || [], catalog: [], can: info?.can || { hardcover: true, connected: true, catalog: true } });
      return;
    }
    try {
      const found = await getJson(`/api/collection/lookup?q=${encodeURIComponent(q)}`);
      if (!alive || mine !== asked) return;
      // What the file name itself suggested stays on top when it still fits the search.
      renderResults(found);
    } catch (err) {
      if (alive && mine === asked) setChildren(results, h('p', { class: 'callout is-error' }, err.message));
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(look, 350);
  });

  dialog.addEventListener('close', () => {
    alive = false;
    clearTimeout(typing);
  }, { once: true });

  says.textContent = 'Reading the file…';
  setChildren(results);
  dialog.showModal();

  getJson(`/api/collection/describe?path=${encodeURIComponent(file.path)}`).then((described) => {
    if (!alive) return;
    info = described;
    const e = described.embedded;
    if (e?.title) {
      says.textContent = `The file says it is “${e.title}”${e.authors.length ? ` by ${e.authors.join(', ')}` : ''}.`;
      ownTitle.value = e.title;
      ownAuthors.value = e.authors.join(', ');
    } else {
      says.textContent = described.problem
        || (described.format === 'epub' ? 'The file does not say what it is.' : `${KIND[described.kind]} file, ${formatBytes(described.size)}. Which book is it?`);
      ownTitle.value = described.query;
    }
    input.value = described.query;
    renderResults({ q: described.query, library: described.guesses, catalog: [], can: described.can }, { looking: described.can.connected && Boolean(described.query) });
    if (described.can.connected && described.query) look();
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) input.select();
  }).catch((err) => {
    if (!alive) return;
    says.textContent = err.message;
  });
}

/** One title: what it is, its files, and how far it was read. */
function openBook(book, { onChange, onFind }) {
  const dialog = $('collection-dialog');
  const body = $('collection-body');
  $('collection-title').textContent = book.title;

  const facts = [book.year, book.pages ? `${n(book.pages)} pages` : ''].filter(Boolean);
  const p = book.progress;
  const progressFile = p && book.files.find((f) => f.id === p.file);

  const fileRow = (file) => {
    const untie = h('button', {
      type: 'button', class: 'button is-quiet', title: 'Take this file off this title. The file stays in the download folder.',
      onclick: async () => {
        untie.disabled = true;
        try {
          await postJson('/api/collection/detach', { file: file.id });
          dialog.close();
          toast(`“${file.name}” is waiting to be sorted again.`, { done: true });
          onChange();
        } catch (err) {
          toast(err.message);
          untie.disabled = false;
        }
      },
    }, 'Untie');
    return h('li', { class: `dl${file.missing ? ' is-failed' : ''}` },
      h('div', { class: 'dl-main' },
        h('p', { class: 'dl-name' }, file.name),
        h('p', { class: 'dl-text' }, file.missing
          ? 'This file is no longer in the download folder.'
          : `${formatLabel(file.format)} · ${formatBytes(file.size)}${file.format === 'epub' ? ' · opens in the reader app' : ''}`),
      ),
      h('div', { class: 'dl-actions' },
        file.missing ? null : h('a', { class: 'button is-quiet', href: `/api/collection/file?id=${encodeURIComponent(file.id)}`, download: file.name }, icon('download'), 'Save'),
        untie,
      ),
    );
  };

  const remove = h('button', {
    type: 'button', class: 'button is-quiet',
    onclick: async () => {
      dialog.close();
      const ok = await askConfirm({
        title: `Take “${book.title}” out of your collection?`,
        text: `${book.files.length === 1 ? 'Its file stays' : `Its ${book.files.length} files stay`} in the download folder and can be added again. Where you were in the book is forgotten.`,
        action: 'Take it out',
      });
      if (!ok) return;
      try {
        await postJson('/api/collection/remove', { book: book.id });
        onChange();
      } catch (err) {
        toast(err.message);
      }
    },
  }, 'Take out of the collection');

  setChildren(body,
    h('div', { class: 'own-head' },
      coverEl(book, book.cover ? coverSrc(book) : ''),
      h('div', { class: 'bookcard-main' },
        book.subtitle ? h('p', { class: 'bookcard-sub' }, book.subtitle) : null,
        h('p', { class: 'bookcard-by' },
          book.authors.length ? `by ${book.authors.join(', ')}` : 'Author unknown',
          book.series ? h('span', { class: 'bookcard-series' }, ` · ${seriesLabel(book.series)}`) : null,
        ),
        facts.length ? h('p', { class: 'bookcard-facts' }, facts.join(' · ')) : null,
        h('p', { class: 'bookcard-facts' }, `Added ${day(new Date(book.addedAt).toISOString())}${book.hardcoverId ? '' : ' · not tied to Hardcover'}`),
        p ? h('div', { class: 'own-progress' },
          progressBar(p),
          h('p', { class: 'bookcard-facts' },
            h('strong', null, progressLabel(p)),
            p.locator?.chapter ? ` · ${p.locator.chapter}` : '',
            ` · read ${ago(new Date(p.updatedAt).toISOString())}${p.device ? ` on ${p.device}` : ''}`,
            progressFile && book.files.length > 1 ? ` (${formatLabel(progressFile.format)})` : ''),
        ) : readable(book) ? h('p', { class: 'bookcard-facts' }, 'Not opened in the reader app yet.') : null,
      ),
    ),
    book.description ? h('p', { class: 'bookcard-text own-text' }, book.description) : null,
    h('ul', { class: 'dl-list own-files' }, book.files.map(fileRow)),
    h('div', { class: 'form-actions' },
      book.hardcoverId && onFind ? h('button', {
        type: 'button', class: 'button',
        onclick: () => {
          dialog.close();
          onFind(book);
        },
      }, 'Find more files') : null,
      book.slug ? h('a', { class: 'button is-quiet', href: `https://hardcover.app/books/${encodeURIComponent(book.slug)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open on Hardcover', icon('out')) : null,
      remove,
    ),
  );
  dialog.showModal();
}

/** Pair the reader app on a phone, and see or remove the devices that are paired. */
export function openReaderApp() {
  const dialog = $('devices-dialog');
  const body = $('devices-body');
  let alive = true;
  let timer = null;
  dialog.addEventListener('close', () => {
    alive = false;
    clearTimeout(timer);
  }, { once: true });

  const onPhone = /Android/i.test(navigator.userAgent);
  const address = location.origin;
  const codeEl = h('strong', { class: 'pair-code' }, '····-····');
  const codeNote = h('span', { class: 'field-hint' });
  const openLink = h('a', { class: 'button is-primary', href: '#', hidden: true }, 'Open in the reader app');
  const list = h('ul', { class: 'dl-list' });
  const listTitle = h('h3', { class: 'section-title', hidden: true }, 'Paired devices');
  const apk = h('p', { class: 'field-hint', hidden: true });

  async function newCode() {
    clearTimeout(timer);
    try {
      const made = await postJson('/api/devices/code');
      if (!alive) return;
      codeEl.textContent = made.code;
      const minutes = Math.round((made.expiresAt - Date.now()) / 60000);
      codeNote.textContent = `Works once, for ${minutes} minutes.`;
      openLink.href = `shelfmark://pair?server=${encodeURIComponent(address)}&code=${encodeURIComponent(made.code)}`;
      openLink.hidden = !onPhone;
      // A code that ran out is replaced while the dialog stays open.
      timer = setTimeout(newCode, Math.max(30_000, made.expiresAt - Date.now() - 5000));
    } catch (err) {
      if (alive) codeNote.textContent = err.message;
    }
  }

  function renderDevices(devices) {
    listTitle.hidden = devices.length === 0;
    setChildren(list, devices.map((d) => {
      const remove = h('button', {
        type: 'button', class: 'button is-quiet',
        onclick: async () => {
          remove.disabled = true;
          try {
            const res = await postJson('/api/devices/remove', { id: d.id });
            if (alive) renderDevices(res.devices);
          } catch (err) {
            toast(err.message);
            remove.disabled = false;
          }
        },
      }, 'Remove');
      return h('li', { class: 'dl' },
        h('div', { class: 'dl-main' },
          h('p', { class: 'dl-name' }, d.name),
          h('p', { class: 'dl-text' }, `Paired ${day(new Date(d.createdAt).toISOString())} · last seen ${ago(new Date(d.seenAt).toISOString())}`)),
        h('div', { class: 'dl-actions' }, remove),
      );
    }));
  }

  const steps = session.authRequired
    ? h('ol', { class: 'pair-steps' },
      h('li', null, 'Install Shelfmark Reader on your Android phone and open it.'),
      h('li', null, 'Give it the address of this Shelfmark: ', h('code', null, address)),
      h('li', null, 'And this code: ', codeEl, ' ', codeNote),
    )
    : h('ol', { class: 'pair-steps' },
      h('li', null, 'Install Shelfmark Reader on your Android phone and open it.'),
      h('li', null, 'Give it the address of this Shelfmark: ', h('code', null, address)),
      h('li', null, 'That is all: this Shelfmark has no sign-in, so the app needs no code.'),
    );

  setChildren(body,
    h('p', null, 'Shelfmark Reader is the Android app for the epubs in your collection. It keeps them on the phone for reading anywhere, and tells this page how far you are.'),
    steps,
    apk,
    session.authRequired ? h('div', { class: 'form-actions' },
      openLink,
      h('button', { type: 'button', class: 'button is-quiet', onclick: newCode }, 'New code'),
    ) : null,
    listTitle,
    list,
  );
  dialog.showModal();

  if (session.authRequired) newCode();
  getJson('/api/devices').then((res) => {
    if (!alive) return;
    renderDevices(res.devices);
    if (res.apk) {
      apk.hidden = false;
      setChildren(apk, 'The app is not in any store. ', h('a', { class: 'text-button', href: res.apk, download: '' }, 'Download the APK'), ' and open it on the phone to install it.');
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------- the page

const compare = {
  added: (a, b) => b.addedAt - a.addedAt,
  read: (a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0) || compare.added(a, b),
  title: (a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)),
  author: (a, b) => surname(a.authors[0]).localeCompare(surname(b.authors[0])) || compare.title(a, b),
};

function bookItem(book) {
  const formats = [...new Set(book.files.map((f) => f.format))];
  const p = book.progress;
  return h('li', null, h('button', { type: 'button', class: 'book is-owned', 'data-id': book.id, title: `Show the files of “${book.title}”` },
    coverEl(book, book.cover ? coverSrc(book) : ''),
    p ? progressBar(p) : null,
    h('span', { class: 'book-main' },
      h('span', { class: 'book-title' }, book.title),
      book.authors.length ? h('span', { class: 'book-author' }, book.authors.join(', ')) : null,
      book.series ? h('span', { class: 'book-series' }, seriesLabel(book.series)) : null,
    ),
    h('span', { class: 'book-tags' },
      formats.map((f) => h('span', { class: `status${f === 'epub' ? ' is-read' : ''}` }, formatLabel(f))),
      p ? h('span', { class: 'book-stars' }, progressLabel(p)) : null,
      book.files.some((f) => f.missing) ? h('span', { class: 'status is-dnf' }, 'File missing') : null,
    ),
  ));
}

/**
 * Build the Collection page inside `container`.
 *
 * @param {HTMLElement} container
 * @param {object} o
 * @param {(book: object) => void} [o.onFind] look for more files of a book in the lists
 */
export function mountCollection(container, o = {}) {
  unmountCollection();
  const state = { alive: true };

  const meta = h('p', { class: 'place-meta' });
  const notes = h('div');
  const looseList = h('ul', { class: 'dl-list' });
  const looseCount = h('span', { class: 'group-count' });
  const looseMore = h('div', { class: 'group-foot', hidden: true });
  const looseSection = h('section', { class: 'group', hidden: true },
    h('header', { class: 'group-head' },
      h('h2', { class: 'section-title' }, 'Not sorted yet'),
      h('div', { class: 'group-actions' }, looseCount),
    ),
    looseList,
    looseMore,
  );
  const filter = h('input', {
    type: 'search', class: 'lib-input', placeholder: 'Filter by title, author or series',
    'aria-label': 'Filter the books', spellcheck: 'false', autocomplete: 'off',
  });
  filter.value = memory.filter;
  const sortSelect = h('select', { class: 'lib-input', 'aria-label': 'Sort the books' },
    SORTS.map(([value, label]) => h('option', { value }, label)));
  sortSelect.value = prefs.sort;
  if (sortSelect.value !== prefs.sort) sortSelect.value = prefs.sort = 'added';
  const count = h('p', { class: 'summary lib-count', 'aria-live': 'polite' });
  const bar = h('div', { class: 'lib-bar', hidden: true }, count, h('div', { class: 'lib-tools' }, filter, sortSelect));
  const grid = h('ul', { class: 'books' });
  const body = h('div');
  let showAllLoose = false;

  container.replaceChildren(
    h('div', { class: 'place' },
      h('h1', null, 'Collection'),
      meta,
    ),
    notes, looseSection, bar, body,
  );

  const reload = () => load({ quiet: true });

  function looseRow(file) {
    const add = h('button', {
      type: 'button', class: 'button', onclick: () => openAttach(file, { onDone: reload }),
    }, 'Add to collection');
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    return h('li', { class: 'dl' },
      h('div', { class: 'dl-main' },
        h('p', { class: 'dl-name' }, file.name),
        h('p', { class: 'dl-text' }, [
          KIND[file.kind] === 'File' ? formatLabel(file.format) : `${KIND[file.kind]} · ${formatLabel(file.format)}`,
          formatBytes(file.size),
          `arrived ${ago(new Date(file.modifiedAt).toISOString())}`,
          folder ? `in ${folder}` : '',
        ].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'dl-actions' }, add),
    );
  }

  function render() {
    const { books, loose, folder } = memory.data;
    const reading = books.filter((b) => b.progress && !b.progress.finished).length;
    setChildren(meta,
      books.length ? `${plural(books.length, 'book')}${reading ? `, ${n(reading)} being read` : ''} · ` : null,
      'files in ', h('code', null, folder), ' · ',
      h('button', { type: 'button', class: 'text-button', onclick: openReaderApp }, 'Reader app'),
    );

    // Books and audio first; covers, notes and the like wait behind "Show all".
    const main = loose.filter((f) => f.kind !== 'other');
    const shown = showAllLoose ? loose : main;
    looseSection.hidden = loose.length === 0;
    looseCount.textContent = plural(shown.length, 'file');
    setChildren(looseList, shown.slice(0, 200).map(looseRow));
    const hidden = loose.length - main.length;
    looseMore.hidden = hidden === 0;
    setChildren(looseMore, h('button', {
      type: 'button', class: 'text-button',
      onclick: () => {
        showAllLoose = !showAllLoose;
        render();
      },
    }, showAllLoose ? 'Only show books and audio' : `Also show ${plural(hidden, 'other file')}`));

    bar.hidden = books.length === 0;
    const terms = fold(memory.filter.trim()).split(/\s+/).filter(Boolean);
    const matching = books.filter((book) => {
      if (!terms.length) return true;
      const hay = fold(`${book.title} ${book.subtitle || ''} ${book.authors.join(' ')} ${book.series?.name || ''} ${book.files.map((f) => f.format).join(' ')}`);
      return terms.every((t) => hay.includes(t));
    }).sort(compare[prefs.sort] || compare.added);

    count.replaceChildren();
    if (matching.length) {
      count.append(h('strong', null, plural(matching.length, 'book')), terms.length ? ' match the filter.' : ' in your collection.');
      grid.replaceChildren(...matching.map(bookItem));
      setChildren(body, grid);
    } else if (books.length) {
      setChildren(body, h('div', { class: 'notice' },
        h('h1', null, `No books match “${memory.filter.trim()}”`),
        h('button', {
          type: 'button', class: 'button',
          onclick: () => {
            filter.value = memory.filter = '';
            render();
          },
        }, 'Clear the filter'),
      ));
    } else {
      setChildren(body, h('div', { class: 'notice' },
        h('h1', null, 'Nothing in your collection yet'),
        h('p', null, loose.length
          ? 'The files above are in your download folder but do not belong to a title yet. Add one to start your collection.'
          : 'Your collection is made of the files in your download folder, each tied to a title.'),
        h('ul', null,
          h('li', null, 'Pick a book in your Library and get a file for it: when the download finishes, it is added here under that title.'),
          h('li', null, 'Or get any file from Search: it then waits here to be given its title, with a lookup on Hardcover.'),
        ),
        h('p', null, 'Epubs in your collection can be read on your phone with the ',
          h('button', { type: 'button', class: 'text-button', onclick: openReaderApp }, 'reader app'), '.'),
      ));
    }
  }

  async function load({ quiet = false } = {}) {
    if (!quiet && !memory.data) {
      setChildren(body, h('div', { class: 'notice' }, h('h1', null, 'Loading your collection'), h('p', null, 'One moment.')));
    }
    try {
      const data = await getJson('/api/collection');
      if (!state.alive) return;
      memory.data = data;
      render();
    } catch (err) {
      if (!state.alive) return;
      bar.hidden = true;
      looseSection.hidden = true;
      setChildren(body, h('div', { class: 'notice' },
        h('h1', null, 'Your collection could not be loaded'),
        h('p', null, err.status ? err.message : 'The server did not answer. Check that it is running, then try again.'),
        h('button', { type: 'button', class: 'button', onclick: () => load() }, 'Try again'),
      ));
    }
  }

  let typing = null;
  filter.addEventListener('input', () => {
    memory.filter = filter.value;
    clearTimeout(typing);
    typing = setTimeout(render, 120);
  });
  sortSelect.addEventListener('change', () => {
    prefs.sort = sortSelect.value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // not remembered, that is all
    }
    render();
  });
  grid.addEventListener('click', (e) => {
    const button = e.target.closest('.book');
    const book = button && memory.data.books.find((b) => b.id === button.dataset.id);
    if (book) openBook(book, { onChange: reload, onFind: o.onFind });
  });

  view = {
    stop() {
      state.alive = false;
      clearTimeout(typing);
    },
    reload,
  };

  window.scrollTo({ top: 0 });
  if (memory.data) render();
  load({ quiet: Boolean(memory.data) });
}

export function unmountCollection() {
  view?.stop();
  view = null;
}

/** The collection changed on the server (a download was added, progress came in): show it. */
export function collectionChanged() {
  if (view) view.reload();
  else memory.data = null;
}

/** Forget what was loaded, such as after signing out. */
export function forgetCollection() {
  memory.data = null;
}
