// Shelfmark: search a command list, copy the command for any file.

import { $, askConfirm, formatBytes, getJson, h, icon, n, plural, postJson, setChildren, toast } from './dom.js';
import {
  activeCount, connSummary, irc, ircPost, isActive, itemFor, mountDownloads, onIrc,
  requestCommands, startIrc, unmountDownloads,
} from './downloads.js';
import {
  audioLength, coverEl, day, forgetLibrary, mountLibrary, seriesLabel, statusEl, unmountLibrary,
} from './library.js';
import { hardcoverSignInUrl, hardcoverUser, loadSession, session, signInProblem } from './session.js';

// ------------------------------------------------------------------ state

// `book` is the Hardcover book being looked for (its panel sits above the results);
// `shelf` and `list` are what the Library page shows.
const state = { q: '', path: '/', all: false, view: 'search', book: 0, shelf: '', list: '' };
let request = null; // AbortController for the view being loaded
let search = { page: 0, hasMore: false, loading: false, terms: [] };
let status = null;
let drawnMode = false; // whether the rows on screen were built for asking (true) or copying

const els = {
  main: $('results'),
  searchbar: $('searchbar'),
  input: $('q'),
  clear: $('clear-q'),
  key: $('search-key'),
  chip: $('scope-chip'),
  chipText: $('scope-chip-text'),
  summary: $('summary'),
  showMain: $('show-main'),
  showAll: $('show-all'),
  listButton: $('open-update'),
  listSummary: $('list-summary'),
  foot: $('foot'),
  marksNote: $('marks-note'),
  tray: $('tray'),
  trayLabel: $('tray-label'),
  trayCommand: $('tray-command'),
  trayAction: $('tray-action'),
  views: $('views'),
  navSearch: $('nav-search'),
  navLibrary: $('nav-library'),
  navDownloads: $('nav-downloads'),
  accountButton: $('account-button'),
  accountName: $('account-name'),
  accountDialog: $('account-dialog'),
  accountBody: $('account-body'),
  navDot: $('nav-dot'),
  navCount: $('nav-count'),
  keyAction: $('key-action'),
  updateDialog: $('update-dialog'),
  updateBody: $('update-body'),
  manualDialog: $('manual-copy'),
  manualText: $('manual-text'),
};

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.path = p.get('in') || '/';
  state.all = p.get('all') === '1';
  const v = p.get('v');
  state.view = v === 'downloads' || v === 'library' ? v : 'search';
  state.book = Number.parseInt(p.get('book') || '', 10) || 0;
  state.shelf = p.get('shelf') || '';
  state.list = p.get('list') || '';
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (state.view !== 'search') p.set('v', state.view);
  if (state.view === 'library') {
    if (state.shelf) p.set('shelf', state.shelf);
    if (state.list) p.set('list', state.list);
  }
  if (state.view === 'search' && state.book) p.set('book', String(state.book));
  if (state.view !== 'library') {
    if (state.q) p.set('q', state.q);
    if (state.path !== '/') p.set('in', state.path);
    if (state.all) p.set('all', '1');
  }
  const qs = p.toString();
  const url = qs ? `?${qs}` : location.pathname;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

async function api(endpoint, params = {}, signal) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== false) p.set(key, value === true ? '1' : value);
  }
  return getJson(`/api/${endpoint}?${p}`, signal);
}

// -------------------------------------------------------------- highlight

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lower-case and strip accents while keeping every character at the same index. */
function fold(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch < '\u0080') {
      out += ch.toLowerCase();
    } else {
      const base = ch.normalize('NFD')[0].toLowerCase();
      out += base.length === 1 ? base : ch;
    }
  }
  return out;
}

function prepareTerms(terms) {
  return [...new Set(terms.map((t) => fold(t.trim())).filter(Boolean))];
}

/** Returns text with matching word starts wrapped in <mark>. */
function highlight(text, terms) {
  if (!terms.length) return [text];
  const folded = fold(text);
  const ranges = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      if (at === 0 || !WORD_CHAR.test(folded[at - 1])) ranges.push([at, at + term.length]);
      from = at + 1;
    }
  }
  if (!ranges.length) return [text];
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (end <= pos) continue;
    const s = Math.max(start, pos);
    if (s > pos) out.push(text.slice(pos, s));
    out.push(h('mark', null, text.slice(s, end)));
    pos = end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

// ------------------------------------------------------------- clipboard

const MARKS_KEY = 'shelfmark.copied';
const MAX_MARKS = 5000;
let marks = new Set();
try {
  marks = new Set(JSON.parse(localStorage.getItem(MARKS_KEY) || '[]'));
} catch {
  // start without marks
}

const markKey = (command) => command.split(' ', 2)[1] || command;

function saveMarks() {
  if (marks.size > MAX_MARKS) marks = new Set([...marks].slice(marks.size - MAX_MARKS));
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify([...marks]));
  } catch {
    // storage unavailable; marks last until the page closes
  }
  renderMarksNote();
}

function renderMarksNote() {
  els.marksNote.replaceChildren();
  if (!marks.size) return;
  els.marksNote.append(
    `${plural(marks.size, 'file')} marked as copied in this browser. `,
    h('button', {
      type: 'button',
      class: 'text-button',
      onclick: () => {
        marks.clear();
        saveMarks();
        for (const row of document.querySelectorAll('.row.was-copied')) setRowState(row, false);
      },
    }, 'Clear marks'),
  );
}

function legacyCopy(text) {
  const area = h('textarea', { readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.append(area);
  const active = document.activeElement;
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

/** Copies text. Falls back to an older method on plain-http addresses, then to a manual dialog. */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  if (legacyCopy(text)) return true;
  els.manualText.value = text;
  els.manualDialog.showModal();
  els.manualText.focus();
  els.manualText.select();
  return false;
}

let trayAction = null;

/** The bar at the bottom. `action` is an optional { label, run } button. */
function showTray(label, detail, action = null) {
  undoable = null;
  els.trayLabel.textContent = label;
  els.trayCommand.textContent = detail;
  trayAction = action;
  els.trayAction.hidden = !action;
  els.trayAction.textContent = action?.label || '';
  els.tray.hidden = false;
}
els.trayAction.addEventListener('click', () => trayAction?.run());

/** With IRC set up, clicking a file asks for it; without, it copies the command. */
const getMode = () => irc.configured;

const ROW_LABELS = {
  queued: 'Queued', sent: 'Asked', noreply: 'No reply', connecting: 'Starting', done: 'Saved', failed: 'Failed',
};

/** Set the label at the end of a row: copy state, or how the download is going. */
function paintRow(row) {
  const stateEl = row.querySelector('.row-state');
  if (!getMode()) {
    const copied = marks.has(markKey(row.dataset.command));
    row.classList.toggle('was-copied', copied);
    row.classList.remove('has-status');
    delete row.dataset.status;
    row.title = 'Copy this command';
    stateEl.replaceChildren(icon(copied ? 'check' : 'copy'), copied ? 'Copied' : 'Copy');
    return;
  }
  const item = itemFor(row.dataset.command);
  const status = item && item.status !== 'cancelled' ? item.status : '';
  row.classList.remove('was-copied');
  row.classList.toggle('has-status', Boolean(status));
  row.dataset.status = status;
  row.title = status ? 'Show this file in Downloads' : 'Ask for this file in the channel';
  let label = ROW_LABELS[status] || 'Get';
  if (status === 'downloading') {
    label = item.size > 0 ? `${Math.floor((item.received / item.size) * 100)}%` : 'Getting';
  }
  stateEl.replaceChildren(icon(status === 'done' ? 'check' : status === 'failed' ? 'close' : 'download'), label);
}

function setRowState(row, copied) {
  if (getMode()) {
    paintRow(row);
    return;
  }
  row.classList.toggle('was-copied', copied);
  const stateEl = row.querySelector('.row-state');
  stateEl.replaceChildren(icon(copied ? 'check' : 'copy'), copied ? 'Copied' : 'Copy');
}

function flashRows(rows) {
  for (const row of rows) {
    setRowState(row, true);
    row.classList.remove('just-copied');
  }
  void document.body.offsetWidth; // restart the animation when copying the same row twice
  for (const row of rows) row.classList.add('just-copied');
  setTimeout(() => {
    for (const row of rows) row.classList.remove('just-copied');
  }, 1200);
}

async function copyRow(row) {
  const command = row.dataset.command;
  if (!(await copyText(command))) return;
  marks.delete(markKey(command));
  marks.add(markKey(command));
  saveMarks();
  flashRows([row]);
  showTray('Copied', command);
}

const showDownloads = { label: 'Show downloads', run: () => navigate({ view: 'downloads' }) };

// The request the bar at the bottom offers to undo, until it has been sent.
let undoable = null;

/** A short note about where a fresh request stands, for the bar at the bottom. */
function requestNote() {
  const c = irc.conn;
  if (!c || c.status !== 'online' || !c.channel.joined) return 'Queued until connected';
  return 'Requested';
}

/** Ask for one file in the channel. */
async function requestRow(row) {
  const command = row.dataset.command;
  const name = row.querySelector('.row-name').textContent;
  try {
    const [item] = await requestCommands([command]);
    flashRows([row]);
    if (item.already) {
      showTray('Already in the queue', name, showDownloads);
      return;
    }
    showTray(requestNote(), name, {
      label: 'Undo',
      run: async () => {
        try {
          await ircPost('act', { id: item.id, action: 'cancel' });
          showTray('Request removed', name);
        } catch (err) {
          toast(err.message);
        }
      },
    });
    undoable = { id: item.id, name };
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------ rows

function createRow(file, terms) {
  const prefix = file.c.slice(0, file.p);
  const name = file.c.slice(file.p);
  const kindClass = ['', ' is-archive', ' is-ebook', ' is-other'][file.k] ?? ' is-other';
  const row = h('button', {
    type: 'button',
    class: 'row',
    'data-command': file.c,
  },
    h('span', { class: 'row-command' },
      h('span', { class: 'row-prefix' }, prefix),
      h('span', { class: 'row-name' }, highlight(name, terms)),
    ),
    h('span', { class: 'row-size' }, formatSize(file.s)),
    h('span', { class: `row-ext${kindClass}` }, file.e || 'file'),
    h('span', { class: 'row-state' }),
  );
  paintRow(row);
  if (!getMode()) return h('li', null, row);
  // Asking for the file is the main action; copying the command stays one click away.
  return h('li', { class: 'has-copy' }, row, h('button', {
    type: 'button',
    class: 'icon-button row-copy',
    title: 'Copy the command instead',
    'aria-label': 'Copy the command',
  }, icon('copy')));
}

/** "306.00MB" -> "306 MB", "1.25GB" -> "1.25 GB" */
function formatSize(label) {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(label || '');
  if (!m) return label || '';
  const value = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const digits = unit === 'GB' || unit === 'TB' ? 2 : value < 10 && unit !== 'B' ? 1 : 0;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: unit === 'GB' ? 2 : 0 })} ${unit}`;
}

function pathCrumbs(path) {
  const parts = path === '/' ? [] : path.slice(1).split('/');
  let acc = '';
  return parts.map((name) => {
    acc += `/${name}`;
    return { name, path: acc };
  });
}

function crumbsEl(crumbs, { terms = [], linkLast = true, withRoot = false } = {}) {
  const el = h('nav', { class: 'crumbs', 'aria-label': 'Folder path' });
  const items = withRoot ? [{ name: 'All folders', path: '/' }, ...crumbs] : crumbs;
  items.forEach((crumb, i) => {
    if (i > 0) el.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    const isLast = i === items.length - 1;
    if (isLast && !linkLast) {
      el.append(h('span', { class: 'crumb' }, highlight(crumb.name, terms)));
    } else {
      el.append(h('button', {
        type: 'button',
        class: 'crumb',
        title: `Open ${crumb.name}`,
        onclick: () => navigate({ path: crumb.path, q: '' }),
      }, highlight(crumb.name, terms)));
    }
  });
  return el;
}

/**
 * A block of files from one folder, with "show all" and "copy all".
 * `total` is how many files belong here; `files` are the ones already loaded.
 */
function createGroup({ path, head, total, files, q, terms }) {
  const list = h('ul', { class: 'rows' }, files.map((f) => createRow(f, terms)));
  let loaded = files;
  const foot = h('div', { class: 'group-foot' });
  const group = h('section', { class: 'group' });

  async function fetchAll() {
    if (loaded.length >= total) return loaded;
    const all = [];
    while (all.length < total) {
      const res = await api('files', { path, q, all: state.all, offset: all.length });
      if (!res.items.length) break;
      all.push(...res.items);
    }
    loaded = all;
    return loaded;
  }

  function renderFoot() {
    foot.replaceChildren();
    if (loaded.length >= total) {
      foot.hidden = true;
      return;
    }
    foot.hidden = false;
    const button = h('button', {
      type: 'button',
      class: 'text-button',
      onclick: async () => {
        button.disabled = true;
        button.textContent = 'Loading…';
        try {
          const all = await fetchAll();
          list.replaceChildren(...all.map((f) => createRow(f, terms)));
          renderFoot();
        } catch (err) {
          toast(err.message);
          renderFoot();
        }
      },
    }, `Show all ${n(total)}`);
    foot.append(`Showing the first ${n(loaded.length)}.`, button);
  }
  renderFoot();

  const actions = h('div', { class: 'group-actions' },
    h('span', { class: 'group-count' }, q ? plural(total, 'match', 'matches') : plural(total, 'file')),
  );
  if (total > 1 && getMode()) {
    const getAll = h('button', {
      type: 'button',
      class: 'button',
      title: 'Ask for every file in this block, one after the other',
      onclick: async () => {
        const where = irc.conn?.channel?.name || 'the channel';
        const ok = total <= 3 || await askConfirm({
          title: `Get all ${n(total)} files?`,
          text: `Each file is asked for in ${where}, one after the other. That can take a while, and the sender may limit how many you can have waiting.`,
          action: `Get ${n(total)} files`,
        });
        if (!ok) return;
        getAll.disabled = true;
        try {
          const all = await fetchAll();
          const items = await requestCommands(all.map((f) => f.c));
          const added = items.filter((item) => !item.already).length;
          flashRows([...list.querySelectorAll('.row')]);
          const from = path === '/' ? '' : `from ${path.slice(path.lastIndexOf('/') + 1)}`;
          showTray(added ? `Queued ${plural(added, 'file')}` : 'Already in the queue', from, showDownloads);
        } catch (err) {
          toast(err.message);
        }
        getAll.disabled = false;
      },
    }, icon('download'), `Get all ${n(total)}`);
    actions.append(getAll);
  }
  if (total > 1) {
    const label = `Copy all ${n(total)}`;
    const copyAll = h('button', {
      type: 'button',
      class: `button${getMode() ? ' is-quiet' : ''}`,
      title: 'Copy every command in this block, one per line',
      onclick: async () => {
        copyAll.disabled = true;
        try {
          const all = await fetchAll();
          const ok = await copyText(all.map((f) => f.c).join('\n'));
          if (ok) {
            for (const f of all) {
              marks.delete(markKey(f.c));
              marks.add(markKey(f.c));
            }
            saveMarks();
            flashRows([...list.querySelectorAll('.row')]);
            const name = path === '/' ? 'the list' : path.slice(path.lastIndexOf('/') + 1);
            showTray(`Copied ${plural(all.length, 'command')}`, `from ${name}`);
          }
        } catch (err) {
          toast(err.message);
        }
        copyAll.disabled = false;
      },
    }, icon('copy'), label);
    actions.append(copyAll);
  }

  group.append(h('header', { class: 'group-head' }, head, actions), list, foot);
  return group;
}

// ---------------------------------------------------------------- browse

function letterOf(name) {
  const ch = fold(name.trim().replace(/^[^\p{L}\p{N}]+/u, '')).charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : '#';
}

function folderLink(child) {
  return h('button', {
    type: 'button',
    class: 'folder-link',
    onclick: () => navigate({ path: child.path, q: '' }),
  },
    icon('folder'),
    h('span', { class: 'folder-name' }, child.name),
    h('span', { class: 'folder-count' }, n(child.files)),
  );
}

/**
 * A long folder list is split into blocks so each block reads left to right
 * across its columns: by first letter when the names span the alphabet,
 * otherwise in plain runs.
 */
function folderBlocks(children) {
  if (children.length <= 8) return [h('div', { class: 'folders is-short' }, children.map(folderLink))];
  const blocks = [];
  const byLetter = children.length > 30 && new Set(children.map((c) => letterOf(c.name))).size >= 5;
  if (byLetter) {
    let current = null;
    for (const child of children) {
      const letter = letterOf(child.name);
      if (!current || current.letter !== letter) {
        current = { letter, items: [] };
        blocks.push(current);
      }
      current.items.push(child);
    }
  } else {
    for (let i = 0; i < children.length; i += 60) blocks.push({ letter: null, items: children.slice(i, i + 60) });
  }
  return blocks.flatMap((block) => [
    block.letter ? h('h2', { class: 'folder-letter' }, block.letter) : null,
    h('div', { class: 'folders' }, block.items.map(folderLink)),
  ]).filter(Boolean);
}

/** One shelf on the start page: a folder heading with the folders inside it. */
function sectionEl(section) {
  const open = () => navigate({ path: section.path, q: '' });
  const el = h('section', { class: 'shelf' },
    h('h2', { class: 'shelf-head' },
      h('button', { type: 'button', class: 'shelf-title', onclick: open }, section.name),
      h('span', { class: 'shelf-count' }, plural(section.files, 'file')),
    ),
  );
  if (!section.children.length) return el;
  const lengths = section.children.map((c) => c.name.length).sort((a, b) => a - b);
  const short = lengths[Math.floor(lengths.length / 2)] <= 3; // mostly A, B, C…
  if (short) {
    el.append(h('div', { class: 'tiles' }, section.children.map((c) => h('button', {
      type: 'button',
      class: 'tile',
      title: `${c.name}: ${plural(c.files, 'file')}`,
      onclick: () => navigate({ path: c.path, q: '' }),
    }, c.name))));
  } else {
    el.append(h('div', { class: 'folders' }, section.children.slice(0, 30).map(folderLink)));
  }
  const shown = short ? section.children.length : Math.min(30, section.children.length);
  if (section.folderCount > shown) {
    el.append(h('button', { type: 'button', class: 'text-button', onclick: open },
      `Show all ${plural(section.folderCount, 'folder')}`));
  }
  return el;
}

function renderBrowse(data) {
  const { folder, children, files } = data;
  const atRoot = folder.path === '/';
  const out = [];

  const meta = h('p', { class: 'place-meta' }, plural(folder.files, 'file'));
  if (children.length && !data.sections) meta.append(` in ${plural(children.length, 'folder')}`);
  if (!state.all && folder.otherFiles > 0) {
    meta.append(
      `. ${plural(folder.otherFiles, 'extra')} such as covers and logs ${folder.otherFiles === 1 ? 'is' : 'are'} hidden. `,
      h('button', { type: 'button', class: 'text-button', onclick: () => setAll(true) }, 'Show all files'),
    );
  }

  out.push(h('div', { class: 'place' },
    atRoot ? null : crumbsEl(folder.crumbs.slice(0, -1), { withRoot: true }),
    h('h1', null, atRoot ? ((status?.lists?.length || 1) > 1 ? 'Browse the lists' : 'Browse the list') : folder.name),
    meta,
  ));

  if (data.sections) {
    for (const section of data.sections) out.push(sectionEl(section));
  } else if (children.length) {
    out.push(...folderBlocks(children));
  }

  if (files.total > 0) {
    out.push(createGroup({
      path: folder.path,
      head: h('h2', { class: 'section-title' }, children.length ? 'Files directly in this folder' : 'Files in this folder'),
      total: files.total,
      files: files.items,
      q: '',
      terms: [],
    }));
  }

  if (!children.length && files.total === 0) {
    out.push(h('div', { class: 'notice' },
      h('p', null, state.all
        ? 'This folder is empty in the current list.'
        : 'Nothing here is a book, an audio file or an archive.'),
      state.all ? null : h('button', { type: 'button', class: 'button', onclick: () => setAll(true) }, 'Show all files'),
    ));
  }

  els.summary.textContent = '';
  els.main.replaceChildren(...out);
}

// ---------------------------------------------------------------- search

function renderSearch(data, append) {
  const terms = prepareTerms(data.terms);
  search.terms = terms;
  search.hasMore = data.hasMore;

  if (!append) {
    els.summary.replaceChildren();
    if (data.total.files > 0) {
      els.summary.append(
        h('strong', null, plural(data.total.files, 'file')),
        ` in ${plural(data.total.folders, 'folder')}`,
      );
    }
  }

  const out = [];

  if (!append && data.folderMatches.length) {
    out.push(h('section', { class: 'folder-hits' },
      h('h2', null, 'Folders'),
      h('div', { class: 'folder-hits-list' }, data.folderMatches.map((f) => {
        const parent = f.path.split('/').slice(-3, -1).filter(Boolean).join(' / ');
        return h('button', {
          type: 'button',
          class: 'folder-hit',
          title: f.path,
          onclick: () => navigate({ path: f.path, q: '' }),
        },
          icon('folder'),
          h('span', { class: 'folder-hit-name' },
            highlight(f.name, terms),
            parent ? h('span', { class: 'folder-hit-in' }, ` in ${parent}`) : null,
          ),
          h('span', { class: 'folder-count' }, n(f.files)),
        );
      })),
    ));
  }

  if (!append && data.groups.length === 0) {
    const scoped = state.path !== '/';
    out.push(h('div', { class: 'notice' },
      h('h1', null, `No files match “${state.q.trim()}”`),
      h('p', null, scoped
        ? `Nothing in ${data.scope.name} matches. Every word you type has to appear in the file name or its folder.`
        : 'Every word you type has to appear in the file name or its folder. Try fewer words, or just the surname.'),
      h('div', { class: 'drop-actions' },
        scoped ? h('button', { type: 'button', class: 'button', onclick: () => navigate({ path: '/' }) }, 'Search the whole list') : null,
        state.all ? null : h('button', { type: 'button', class: 'button is-quiet', onclick: () => setAll(true) }, 'Include covers, logs and other extras'),
      ),
    ));
  }

  for (const g of data.groups) {
    out.push(createGroup({
      path: g.path,
      head: crumbsEl(pathCrumbs(g.path), { terms }),
      total: g.matches,
      files: g.files,
      q: state.q,
      terms,
    }));
  }

  const more = h('div', { class: 'more', id: 'more' }, data.hasMore ? 'Loading more…' : null);

  if (append) {
    $('more')?.remove();
    els.main.append(...out, more);
  } else {
    els.main.replaceChildren(...out, more);
  }
  if (data.hasMore) moreObserver.observe(more);
}

const moreObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { rootMargin: '600px 0px' });

async function loadMore() {
  if (search.loading || !search.hasMore || !state.q.trim()) return;
  search.loading = true;
  const signal = request?.signal;
  try {
    const data = await api('search', { q: state.q, path: state.path, all: state.all, page: search.page + 1 }, signal);
    search.page += 1;
    moreObserver.disconnect();
    renderSearch(data, true);
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message);
  } finally {
    search.loading = false;
  }
}

// ------------------------------------------------------------ navigation

function syncControls() {
  if (els.input.value !== state.q) els.input.value = state.q;
  els.clear.hidden = !state.q;
  els.key.hidden = Boolean(state.q);
  els.showMain.setAttribute('aria-pressed', String(!state.all));
  els.showAll.setAttribute('aria-pressed', String(state.all));
  const scoped = state.path !== '/';
  els.chip.hidden = !scoped;
  if (scoped) {
    const name = state.path.slice(state.path.lastIndexOf('/') + 1);
    els.chipText.textContent = `in ${name}`;
    els.chip.title = `Searching inside ${state.path}. Click to search the whole list.`;
    els.chip.setAttribute('aria-label', `Searching inside ${name}. Search the whole list instead.`);
    els.input.placeholder = `Search inside ${name}`;
  } else {
    els.input.placeholder = 'Search by author, title or show';
  }
}

/** Show or hide the parts of the page that belong to one view. */
function syncChrome() {
  const searching = state.view === 'search';
  const ready = status?.state === 'ready';
  els.searchbar.hidden = !(searching && ready);
  els.foot.hidden = !(searching && ready);
  for (const [name, button] of [['search', els.navSearch], ['library', els.navLibrary], ['downloads', els.navDownloads]]) {
    if (state.view === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  els.keyAction.textContent = getMode() ? 'get' : 'copy';
  document.title = { search: 'Shelfmark', library: 'Library · Shelfmark', downloads: 'Downloads · Shelfmark' }[state.view];
}

/** The connection light and the count next to "Downloads" in the header. */
function renderNav() {
  const summary = connSummary();
  els.navDot.className = `dot is-${summary.tone}`;
  els.navDot.hidden = !irc.configured;
  els.navDownloads.title = irc.configured ? `IRC: ${summary.label}` : 'Set up IRC to download files from here';
  const count = activeCount();
  els.navCount.hidden = count === 0;
  els.navCount.textContent = n(count);
}

/** Draw whatever the address bar says. */
function show() {
  syncChrome();
  if (state.view !== 'search') {
    request?.abort();
    moreObserver.disconnect();
    els.summary.textContent = '';
    els.tray.hidden = true; // a leftover note from the search page would cover what is below
  }
  if (state.view === 'downloads') {
    unmountLibrary();
    mountDownloads(els.main);
    return;
  }
  unmountDownloads();
  if (state.view === 'library') {
    mountLibrary(els.main, {
      shelf: state.shelf,
      list: state.list,
      onChange: (change) => {
        Object.assign(state, change);
        writeUrl(false);
      },
      onOpen: openBook,
    });
    return;
  }
  unmountLibrary();
  if (status?.state === 'ready') load();
  else init();
}

async function load() {
  drawnMode = getMode();
  request?.abort();
  request = new AbortController();
  const { signal } = request;
  moreObserver.disconnect();
  search = { page: 0, hasMore: false, loading: false, terms: [] };
  syncControls();

  try {
    // Asked for alongside the results, so the panel and the files appear together.
    const looking = state.book ? findBook(state.book, state.all).catch((err) => {
      if (err.name !== 'AbortError') state.book = 0;
      return null;
    }) : null;
    if (state.q.trim()) {
      const data = await api('search', { q: state.q, path: state.path, all: state.all }, signal);
      const match = await looking;
      if (signal.aborted) return;
      renderSearch(data, false);
      if (match) els.main.prepend(bookPanel(match, data.total.files));
    } else {
      const data = await api('browse', { path: state.path, all: state.all }, signal);
      const match = await looking;
      if (signal.aborted) return;
      renderBrowse(data);
      if (match) els.main.prepend(bookPanel(match, null));
    }
    if (looking && !state.book) writeUrl(false); // the book is gone from the library: drop it from the address
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err.status === 404 && state.path !== '/') {
      toast('That folder is not in the loaded lists. Showing everything instead.');
      state.path = '/';
      writeUrl(false);
      load();
      return;
    }
    if (err.status === 503) {
      init();
      return;
    }
    els.summary.textContent = '';
    els.main.replaceChildren(h('div', { class: 'notice' },
      h('h1', null, 'The list could not be loaded'),
      h('p', null, err.status ? err.message : 'The server did not answer. Check that it is running, then try again.'),
      h('button', { type: 'button', class: 'button', onclick: () => load() }, 'Try again'),
    ));
  }
}

function navigate(change, { push = true } = {}) {
  Object.assign(state, { view: 'search' }, change);
  writeUrl(push);
  if (state.view !== 'library') window.scrollTo({ top: 0 }); // the Library page goes back to where you were
  show();
}

// ------------------------------------------------- a book from the library

const found = new Map(); // "book id|all" -> what the server found for it

/** Ask the server which searches find this book in the lists. */
function findBook(id, all) {
  const key = `${id}|${all ? 1 : 0}`;
  if (!found.has(key)) {
    const asked = api('hardcover/match', { book: id, all });
    asked.catch(() => found.delete(key));
    found.set(key, asked);
  }
  return found.get(key);
}

/** A book was picked on the Library page: show the search that finds it. */
async function openBook(book) {
  try {
    const match = await findBook(book.id, state.all);
    navigate({ book: book.id, q: match.best || match.queries[0]?.q || '', path: '/' });
  } catch (err) {
    toast(err.message);
  }
}

/** Run one of the searches offered for the book, in place. */
function trySearch(q) {
  clearTimeout(typing);
  state.q = q;
  state.path = '/';
  writeUrl(false);
  load();
}

/**
 * The panel above the results while a book is being looked for: what the book
 * is, and the searches that find it (or come close).
 * `shownFiles` is how many files the search on screen found; null while browsing.
 */
function bookPanel(match, shownFiles) {
  const { book } = match;
  const facts = [
    book.year,
    book.pages ? `${n(book.pages)} pages` : '',
    book.audioSeconds ? `${audioLength(book.audioSeconds)} of audio` : '',
    book.rating ? `★ ${book.rating.toLocaleString(undefined, { maximumFractionDigits: 2 })} on Hardcover${book.ratings ? ` (${plural(book.ratings, 'rating')})` : ''}` : '',
  ].filter(Boolean);
  const mine = [
    book.myRating ? `You rated it ★ ${book.myRating}` : '',
    book.finished ? `Finished ${day(book.finished)}` : book.started ? `Started ${day(book.started)}` : '',
    book.added ? `Added ${day(book.added)}` : '',
    book.format ? `Your edition: ${book.format}` : '',
    book.owned ? 'Owned' : '',
    book.lists?.length ? `In ${book.lists.length === 1 ? 'your list' : 'your lists'} ${book.lists.map((l) => `“${l}”`).join(', ')}` : '',
  ].filter(Boolean);
  const others = (book.contributors || []).map((c) => `${c.name} (${c.role.toLowerCase()})`);

  const description = book.description ? h('p', { class: 'bookcard-text' }, book.description) : null;
  const moreButton = description ? h('button', {
    type: 'button', class: 'text-button', hidden: true,
    onclick: () => {
      const open = description.classList.toggle('is-open');
      moreButton.textContent = open ? 'Show less' : 'Show more';
    },
  }, 'Show more') : null;
  // Only offer "Show more" when the text really is cut off.
  if (description) requestAnimationFrame(() => {
    moreButton.hidden = description.scrollHeight <= description.clientHeight + 2;
  });

  const current = state.q.trim();
  const tries = match.queries.filter((t) => t.files > 0).map((t) => h('button', {
    type: 'button',
    class: 'try',
    'aria-pressed': String(t.q === current),
    title: `Search for: ${t.q}`,
    onclick: () => trySearch(t.q),
  }, t.label, h('span', { class: 'try-count' }, n(t.files))));

  let verdict;
  if (!match.listLoaded) {
    verdict = 'No list is loaded yet, so there is nothing to look in.';
  } else if (!match.best) {
    verdict = tries.length
      ? 'Nothing in the lists has this title. These come close:'
      : `Nothing in the lists matches this book or its author${state.all ? '' : ' (covers and other extras are not counted)'}.`;
  } else if (shownFiles === 0 && current) {
    verdict = 'Your search finds nothing. These do:';
  } else {
    verdict = 'Looked for in the lists as:';
  }

  return h('section', { class: 'bookcard', 'aria-label': `Looking for ${book.title}` },
    coverEl(book),
    h('div', { class: 'bookcard-main' },
      h('p', { class: 'bookcard-kicker' },
        h('button', { type: 'button', class: 'text-button', onclick: () => navigate({ view: 'library' }) }, 'Library'),
        h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
        statusEl(book.status) || 'On one of your lists',
      ),
      h('h1', null, book.title),
      book.subtitle ? h('p', { class: 'bookcard-sub' }, book.subtitle) : null,
      h('p', { class: 'bookcard-by' },
        book.authors.length ? `by ${book.authors.join(', ')}` : 'Author unknown',
        book.series ? h('span', { class: 'bookcard-series' }, ` · ${seriesLabel(book.series)}`) : null,
      ),
      facts.length ? h('p', { class: 'bookcard-facts' }, facts.join(' · ')) : null,
      mine.length ? h('p', { class: 'bookcard-facts' }, mine.join(' · ')) : null,
      others.length ? h('p', { class: 'bookcard-facts' }, `With ${others.join(', ')}`) : null,
      book.genres?.length ? h('p', { class: 'bookcard-facts' }, book.genres.join(', ')) : null,
      description,
      h('p', { class: 'bookcard-links' },
        moreButton,
        book.url ? h('a', { class: 'text-button', href: book.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on Hardcover', icon('out')) : null,
      ),
    ),
    h('button', {
      type: 'button', class: 'icon-button bookcard-close', 'aria-label': 'Stop looking for this book', title: 'Stop looking for this book',
      onclick: () => {
        state.book = 0;
        writeUrl(false);
        load();
      },
    }, icon('close')),
    h('div', { class: 'bookcard-tries' }, h('span', { class: 'bookcard-verdict' }, verdict), tries),
  );
}


function setAll(all) {
  state.all = all;
  writeUrl(false);
  load();
}

let typing = null;
els.input.addEventListener('input', () => {
  state.q = els.input.value;
  els.clear.hidden = !state.q;
  els.key.hidden = Boolean(state.q);
  clearTimeout(typing);
  typing = setTimeout(() => {
    writeUrl(false);
    window.scrollTo({ top: 0 });
    load();
  }, 130);
});

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(typing);
  writeUrl(false);
  load();
});

function clearQuery() {
  clearTimeout(typing);
  state.q = '';
  writeUrl(false);
  load();
  els.input.focus();
}
els.clear.addEventListener('click', clearQuery);
els.chip.addEventListener('click', () => {
  navigate({ path: '/' });
  els.input.focus();
});
els.showMain.addEventListener('click', () => setAll(false));
els.showAll.addEventListener('click', () => setAll(true));
$('home-link').addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate({ q: '', path: '/', book: 0 });
});
$('tray-close').addEventListener('click', () => {
  els.tray.hidden = true;
});

window.addEventListener('popstate', () => {
  if (!started) return;
  readUrl();
  show();
});

els.navSearch.addEventListener('click', () => navigate({ view: 'search' }));
els.navLibrary.addEventListener('click', () => navigate({ view: 'library' }));
els.navDownloads.addEventListener('click', () => navigate({ view: 'downloads' }));

els.main.addEventListener('click', (e) => {
  const copy = e.target.closest('.row-copy');
  if (copy) {
    copyRow(copy.previousElementSibling);
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  if (!getMode()) copyRow(row);
  else if (isActive(itemFor(row.dataset.command))) navigate({ view: 'downloads' });
  else requestRow(row);
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  const active = document.activeElement;
  const inInput = active === els.input;

  if (e.key === '/' && !inInput && !/^(INPUT|TEXTAREA)$/.test(active?.tagName || '')) {
    e.preventDefault();
    els.input.focus();
    els.input.select();
    return;
  }
  if (state.view !== 'search') return;
  if (e.key === 'Escape') {
    if (state.q) clearQuery();
    else els.input.focus();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

  const onRow = active?.classList?.contains('row');
  if (!inInput && !onRow) return;
  const rows = [...els.main.querySelectorAll('.row')];
  if (!rows.length) return;
  const index = onRow ? rows.indexOf(active) : -1;
  const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
  e.preventDefault();
  if (next < 0) {
    els.input.focus();
  } else if (next < rows.length) {
    rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView({ block: 'nearest' });
  }
});

window.addEventListener('scroll', () => {
  els.searchbar.classList.toggle('is-stuck', window.scrollY > 70);
}, { passive: true });

// ---------------------------------------------------------- list updates

const formatDate = (iso) => new Date(iso).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

function progressEl() {
  const label = h('span', null, '');
  const percent = h('span', null, '');
  const bar = h('div', { class: 'progress-bar' });
  const el = h('div', { class: 'progress' },
    h('div', { class: 'progress-label' }, label, percent),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar),
  );
  return {
    el,
    set(text, fraction) {
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      label.textContent = text;
      percent.textContent = `${pct}%`;
      bar.style.width = `${pct}%`;
      bar.parentElement.setAttribute('aria-valuenow', String(pct));
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the server until the running import ends. Returns the final status. */
async function watchImport(progress) {
  for (;;) {
    const s = await api('status');
    if (!s.import.running) return s;
    progress.set(`${s.import.phase}…`, s.import.progress);
    await sleep(350);
  }
}

/** Send one list file to the server. It only becomes a list once applyLists() says what it is. */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/lists/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.token) return resolve(body.token);
      return reject(new Error(body?.error || `Uploading ${file.name} failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.send(file);
  });
}

/** Tell the server what to do with uploaded files (or which lists to remove), then wait for it. */
async function applyLists(changes, progress) {
  await postJson('/api/lists/apply', changes);
  progress.set('Reading folders…', 0);
  const final = await watchImport(progress);
  if (final.import.error) throw new Error(final.import.error);
  return final;
}

/** "TrainFiles_audio_2026-11-21.txt" -> "TrainFiles audio" */
function suggestListName(fileName) {
  const name = fileName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/\d{4}[-_.]?\d{2}[-_.]?\d{2}/g, ' ')
    .replace(/[_\s]+/g, ' ')
    .replace(/^[\s\-.,]+|[\s\-.,]+$/g, '')
    .trim();
  return name || 'List';
}

/** Letters only, so a newer file ("…_2026-12-01.txt") is recognised as the same list. */
const listKey = (text) => text.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '').replace(/[^\p{L}]+/gu, '');

function similarList(fileName, lists) {
  const key = listKey(fileName);
  if (!key) return null;
  return lists.find((l) => listKey(l.fileName || '') === key || listKey(l.name) === key) || null;
}

/**
 * The file picker + progress used both on the first-run screen and in the
 * lists dialog. Several files can be chosen at once; each one is either a new
 * list or a newer copy of a list that is already loaded.
 */
function createUploader({ onDone }) {
  const root = h('div', { class: 'uploader' });
  const fileInput = h('input', { type: 'file', accept: '.txt,text/plain', multiple: true, class: 'visually-hidden', tabindex: '-1' });
  const existing = () => status?.lists || [];

  function idle(error) {
    const drop = h('div', { class: 'drop' },
      h('p', null, existing().length
        ? 'Drop list files here, or choose them from your computer. You can add several at once.'
        : 'Drop your list files here, or choose them from your computer. You can add several at once.'),
      h('div', { class: 'drop-actions' },
        h('button', { type: 'button', class: 'button is-primary', onclick: () => fileInput.click() }, icon('upload'), 'Choose files'),
      ),
    );
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) chosen(files);
    });
    setChildren(root,
      error ? h('p', { class: 'callout is-error', role: 'alert' }, error) : null,
      drop,
      fileInput,
    );
  }

  function chosen(files) {
    const limit = status?.maxUploadBytes;
    const tooBig = limit && files.find((f) => f.size > limit);
    if (tooBig) {
      idle(`${tooBig.name} is ${formatBytes(tooBig.size)}, which is over the ${formatBytes(limit)} upload limit.`);
      return;
    }
    const lists = existing();
    const claimed = new Set();
    const picks = files.map((file, i) => {
      // A file that looks like a newer copy of a loaded list replaces it, unless you say otherwise.
      const match = similarList(file.name, lists);
      const target = match && !claimed.has(match.id) ? match.id : '';
      if (target) claimed.add(target);

      const nameInput = h('input', {
        type: 'text', id: `pick-name-${i}`, maxlength: '60', autocomplete: 'off', spellcheck: 'false',
      });
      nameInput.value = suggestListName(file.name);
      const nameField = h('div', { class: 'field' }, h('label', { for: nameInput.id }, 'Name of the list'), nameInput);
      const select = lists.length
        ? h('select', { id: `pick-target-${i}`, 'aria-label': `What to do with ${file.name}` },
          h('option', { value: '' }, 'Add as a new list'),
          lists.map((l) => h('option', { value: l.id }, `Replace “${l.name}”`)))
        : null;
      if (select) {
        select.value = target;
        select.addEventListener('change', () => {
          nameField.hidden = select.value !== '';
        });
      }
      nameField.hidden = Boolean(target);
      return {
        file,
        target: () => (select ? select.value : ''),
        name: () => nameInput.value.trim(),
        el: h('li', { class: 'pick' },
          h('p', { class: 'drop-file' }, `${file.name} (${formatBytes(file.size)})`),
          select ? h('div', { class: 'field' }, select) : null,
          nameField,
        ),
      };
    });

    const error = h('p', { class: 'callout is-error', role: 'alert', hidden: true });
    const verb = files.length === 1 ? 'Load list' : `Load ${n(files.length)} lists`;
    root.replaceChildren(h('div', { class: 'drop' },
      h('ul', { class: 'picks' }, picks.map((p) => p.el)),
      error,
      h('div', { class: 'drop-actions' },
        h('button', {
          type: 'button',
          class: 'button is-primary',
          onclick: () => {
            const targets = picks.map((p) => p.target()).filter(Boolean);
            if (new Set(targets).size !== targets.length) {
              error.textContent = 'Two files are set to replace the same list. Change one of them.';
              error.hidden = false;
              return;
            }
            run(picks);
          },
        }, verb),
        h('button', { type: 'button', class: 'button is-quiet', onclick: () => idle() }, 'Choose different files'),
      ),
    ));
  }

  async function run(picks) {
    const progress = progressEl();
    const label = h('p', { class: 'drop-file' });
    root.replaceChildren(h('div', { class: 'drop' }, label, progress.el));
    const totalBytes = picks.reduce((sum, p) => sum + p.file.size, 0) || 1;
    try {
      const changes = { add: [], replace: [] };
      let sent = 0;
      for (const [i, pick] of picks.entries()) {
        label.textContent = picks.length > 1 ? `${pick.file.name} (${i + 1} of ${picks.length})` : pick.file.name;
        const base = sent;
        progress.set('Uploading…', base / totalBytes);
        const token = await uploadFile(pick.file, (f) => progress.set('Uploading…', (base + f * pick.file.size) / totalBytes));
        sent += pick.file.size;
        const target = pick.target();
        if (target) changes.replace.push({ token, id: target, fileName: pick.file.name });
        else changes.add.push({ token, name: pick.name(), fileName: pick.file.name });
      }
      label.textContent = picks.length > 1 ? `Putting ${n(picks.length)} lists together` : picks[0].file.name;
      const final = await applyLists(changes, progress);
      status = final;
      const info = final.library;
      const what = [
        changes.add.length ? `${plural(changes.add.length, 'list')} added` : '',
        changes.replace.length ? `${plural(changes.replace.length, 'list')} replaced` : '',
      ].filter(Boolean).join(', ');
      root.replaceChildren(
        h('p', { class: 'callout is-done', role: 'status' },
          `${what}. ${plural(info.files, 'file')} in ${plural(final.lists.length, 'list')} can now be searched.`,
          info.skippedLines ? ` ${plural(info.skippedLines, 'line')} could not be read and ${info.skippedLines === 1 ? 'was' : 'were'} skipped.` : '',
        ),
      );
      onDone(final);
    } catch (err) {
      idle(existing().length ? `${err.message} The lists that were loaded have not been changed.` : err.message);
    }
  }

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) chosen(files);
  });

  idle();
  return root;
}

/** The dialog that shows the loaded lists, and lets you add, replace and remove them. */
function renderListsDialog() {
  const lists = status?.lists || [];
  const folders = new Map((status?.library?.lists || []).map((l) => [l.id, l.folder]));
  const body = els.updateBody;

  async function remove(list) {
    const last = lists.length === 1;
    const ok = await askConfirm({
      title: `Remove “${list.name}”?`,
      text: last
        ? 'This is the only list. After removing it there is nothing to search until you load a list again.'
        : `Its ${plural(list.files ?? 0, 'file')} will no longer show up in the search. The other lists stay as they are.`,
      action: 'Remove list',
    });
    if (!ok) return;
    const progress = progressEl();
    progress.set('Removing…', 0);
    setChildren(body, h('div', { class: 'drop' }, h('p', { class: 'drop-file' }, `Removing ${list.name}`), progress.el));
    try {
      const final = await applyLists({ remove: [list.id] }, progress);
      applyStatus(final);
      renderListsDialog();
      readUrl();
      show();
    } catch (err) {
      toast(err.message);
      renderListsDialog();
    }
  }

  const uploader = createUploader({
    onDone: (final) => {
      applyStatus(final);
      uploader.append(h('div', { class: 'drop-actions' },
        h('button', { type: 'button', class: 'button is-primary', onclick: () => els.updateDialog.close() }, 'Done'),
        h('button', { type: 'button', class: 'button is-quiet', onclick: () => renderListsDialog() }, 'Add more'),
      ));
      uploader.lastChild.style.marginTop = '14px';
      listEl.replaceWith(listEl = listRows());
      readUrl();
      show();
    },
  });

  function listRows() {
    const current = status?.lists || [];
    if (!current.length) return h('p', null, 'No list is loaded yet.');
    const currentFolders = new Map((status?.library?.lists || []).map((l) => [l.id, l.folder]));
    return h('ul', { class: 'list-rows' }, current.map((list) => {
      const folder = currentFolders.get(list.id) ?? folders.get(list.id);
      const facts = [
        list.files != null ? plural(list.files, 'file') : null,
        list.fileName,
        list.addedAt ? `loaded ${formatDate(list.addedAt)}` : null,
      ].filter(Boolean).join(' · ');
      return h('li', { class: 'list-row' },
        h('div', { class: 'list-row-text' },
          folder
            ? h('button', {
              type: 'button',
              class: 'list-row-name text-button',
              title: 'Browse and search only this list',
              onclick: () => {
                els.updateDialog.close();
                navigate({ path: folder, q: '' });
              },
            }, list.name)
            : h('p', { class: 'list-row-name' }, list.name),
          h('p', { class: 'list-row-facts' }, facts),
        ),
        h('button', { type: 'button', class: 'button is-quiet', onclick: () => remove(list) }, 'Remove'),
      );
    }));
  }

  let listEl = listRows();
  setChildren(body,
    listEl,
    h('p', null, lists.length
      ? 'Add more lists to search them all together, or load a newer copy of one to replace it. If a file cannot be read, nothing changes.'
      : 'Load one or more list files to get started.'),
    uploader,
  );
}

function openListsDialog() {
  renderListsDialog();
  els.updateDialog.showModal();
}
els.listButton.addEventListener('click', openListsDialog);

// Close dialogs when the backdrop is clicked.
for (const dialog of [els.updateDialog, els.manualDialog, els.accountDialog, $('confirm-dialog')]) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ------------------------------------------------------------------ boot

function applyStatus(s) {
  status = s;
  found.clear(); // the lists may have changed, and with them what each book finds
  const info = s.library;
  const ready = s.state === 'ready';
  els.listButton.hidden = !ready;
  syncChrome();
  if (info) {
    const count = s.lists?.length || 1;
    const day = new Date(info.importedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    els.listSummary.textContent = count > 1
      ? `${plural(info.files, 'file')} in ${n(count)} lists`
      : `${plural(info.files, 'file')}, loaded ${day}`;
  }
}

async function init() {
  let s;
  try {
    s = await api('status');
  } catch (err) {
    els.main.replaceChildren(h('div', { class: 'notice' },
      h('h1', null, 'The server did not answer'),
      h('p', null, err.status ? err.message : 'Check that the app is running, then try again.'),
      h('button', { type: 'button', class: 'button', onclick: () => init() }, 'Try again'),
    ));
    return;
  }
  applyStatus(s);
  if (state.view !== 'search') return;

  if (s.import.running && s.state !== 'ready') {
    const progress = progressEl();
    progress.set(`${s.import.phase}…`, s.import.progress);
    els.main.replaceChildren(h('div', { class: 'notice' },
      h('h1', null, 'Loading the list'),
      h('p', null, 'This takes a few seconds, a little longer for very large lists. The page continues on its own when it is done.'),
      progress.el,
    ));
    try {
      await watchImport(progress);
    } catch {
      // fall through to a fresh status check
    }
    init();
    return;
  }

  if (s.state !== 'ready') {
    els.main.replaceChildren(h('div', { class: 'notice' },
      h('h1', null, 'No list loaded yet'),
      h('p', null, 'Upload the text files that list your commands. Each command sits on its own line and starts with “!”. Lists from different sources can be loaded side by side and are searched together.'),
      s.import.error ? h('p', { class: 'callout is-error' }, `The last upload failed: ${s.import.error}`) : null,
      createUploader({ onDone: () => setTimeout(init, 900) }),
    ));
    return;
  }

  renderMarksNote();
  await load();
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) els.input.focus({ preventScroll: true });
}

// Keep the page in step with the IRC side: the header light, and the label on every file row.
onIrc((kind, payload) => {
  renderNav();
  if (kind === 'all') {
    syncChrome();
    if (state.view !== 'search' || status?.state !== 'ready') return;
    if (drawnMode !== getMode()) {
      // Rows are built differently with and without IRC, so draw the results again.
      drawnMode = getMode();
      load();
    } else {
      for (const row of els.main.querySelectorAll('.row')) paintRow(row);
    }
    return;
  }
  if (kind !== 'download' && kind !== 'remove') return;
  if (undoable?.id === payload.id && (kind === 'remove' || payload.status !== 'queued')) {
    const { name } = undoable;
    if (kind === 'remove') {
      undoable = null;
      els.tray.hidden = true;
    } else {
      showTray('Sent to the channel', name, showDownloads);
    }
  }
  if (payload.command && state.view === 'search') {
    for (const row of els.main.querySelectorAll('.row')) {
      if (row.dataset.command === payload.command) paintRow(row);
    }
  }
});

// ---------------------------------------------------------------- account

function accountLabel() {
  const user = hardcoverUser();
  if (user) return user.username ? `@${user.username}` : user.name || 'Account';
  return 'Account';
}

function renderAccountDialog() {
  const user = hardcoverUser();
  const out = [];
  if (user) {
    out.push(h('p', null, 'Signed in with Hardcover as ', h('strong', null, user.name || `@${user.username}`), user.name ? ` (@${user.username})` : '', '.'));
  } else if (session.authRequired) {
    out.push(h('p', null, 'Signed in with the app password.'));
  }
  if (session.methods.hardcover && !user) {
    out.push(h('p', null, 'Connect your Hardcover account to see your library here and look for its books in the lists.'));
  }
  const actions = h('div', { class: 'form-actions' });
  if (session.methods.hardcover && !user) {
    actions.append(h('a', { class: 'button is-primary', href: hardcoverSignInUrl('/?v=library') }, 'Connect Hardcover'));
  }
  if (session.authRequired) {
    actions.append(h('button', {
      type: 'button', class: `button${user || !session.methods.hardcover ? ' is-primary' : ' is-quiet'}`,
      onclick: async () => {
        try {
          await postJson('/api/logout');
          location.assign('/');
        } catch (err) {
          toast(err.message);
        }
      },
    }, 'Sign out'));
  }
  if (user) {
    actions.append(h('button', {
      type: 'button', class: 'button is-quiet',
      onclick: async () => {
        els.accountDialog.close();
        const ok = await askConfirm({
          title: 'Disconnect Hardcover?',
          text: 'The copy of your library kept here is deleted and this app loses its access to your Hardcover account. Nothing changes on Hardcover itself. You can connect again at any time.',
          action: 'Disconnect',
        });
        if (!ok) return;
        try {
          await postJson('/api/hardcover/disconnect');
          forgetLibrary();
          location.assign('/');
        } catch (err) {
          toast(err.message);
        }
      },
    }, 'Disconnect Hardcover'));
  }
  out.push(actions);
  setChildren(els.accountBody, out);
}

els.accountButton.addEventListener('click', () => {
  renderAccountDialog();
  els.accountDialog.showModal();
});

/** The page someone sees before they are let in. */
function renderSignIn(problem) {
  document.title = 'Sign in · Shelfmark';
  const error = h('p', { class: 'callout is-error', role: 'alert', hidden: !problem }, problem || '');
  const out = [
    h('h1', null, 'Sign in'),
    h('p', null, 'This Shelfmark is private. Sign in to search the lists, ask for files and see your library.'),
    error,
  ];
  if (session.methods.hardcover) {
    out.push(h('div', { class: 'drop-actions' },
      h('a', { class: 'button is-primary', href: hardcoverSignInUrl() }, 'Sign in with Hardcover')));
  }
  if (session.methods.password) {
    const user = session.methods.username
      ? h('input', { type: 'text', id: 'signin-user', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true })
      : null;
    const pass = h('input', { type: 'password', id: 'signin-pass', autocomplete: 'current-password', required: true });
    const submit = h('button', { type: 'submit', class: `button${session.methods.hardcover ? '' : ' is-primary'}` }, 'Sign in');
    const form = h('form', { class: 'form signin-form' },
      session.methods.hardcover ? h('p', { class: 'signin-or' }, 'Or use the app password:') : null,
      user ? h('div', { class: 'field' }, h('label', { for: 'signin-user' }, 'Username'), user) : null,
      h('div', { class: 'field' }, h('label', { for: 'signin-pass' }, 'Password'), pass),
      h('div', { class: 'form-actions' }, submit),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        await postJson('/api/login', { username: user?.value || '', password: pass.value });
        location.reload();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
        pass.select();
      }
    });
    out.push(form);
    if (!session.methods.hardcover) requestAnimationFrame(() => (user || pass).focus());
  }
  els.main.replaceChildren(h('div', { class: 'notice signin' }, out));
}

// ------------------------------------------------------------------ start

let started = false;

async function start() {
  readUrl();
  const params = new URLSearchParams(location.search);
  const problem = signInProblem(params.get('signin'));
  if (params.has('signin')) {
    params.delete('signin');
    history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
  }

  try {
    await loadSession();
  } catch (err) {
    els.main.replaceChildren(h('div', { class: 'notice' },
      h('h1', null, 'The server did not answer'),
      h('p', null, err.status ? err.message : 'Check that the app is running, then try again.'),
      h('button', { type: 'button', class: 'button', onclick: () => start() }, 'Try again'),
    ));
    return;
  }
  if (session.authRequired && !session.signedIn) {
    renderSignIn(problem);
    return;
  }

  started = true;
  els.views.hidden = false;
  els.navLibrary.hidden = !session.methods.hardcover;
  els.accountButton.hidden = !session.authRequired;
  els.accountName.textContent = accountLabel();
  if (state.view === 'library' && !session.methods.hardcover) state.view = 'search';
  if (problem) toast(problem);

  renderNav();
  renderMarksNote();
  startIrc();
  if (state.view !== 'search') show();
  init();
}

// The session ran out while the page was open: start over at the sign-in page.
window.addEventListener('shelfmark:signed-out', () => {
  if (started) location.reload();
});

start();
