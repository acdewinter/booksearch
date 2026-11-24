// Shelfmark: search a command list, copy the command for any file.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();
const n = (value) => fmt.format(value);
const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

/** Tiny element builder. Strings become text nodes, so data is never parsed as HTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

/** replaceChildren that ignores null/false, so optional parts can be written inline. */
function setChildren(el, ...nodes) {
  el.replaceChildren(...nodes.flat(Infinity).filter((node) => node != null && node !== false));
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ------------------------------------------------------------------ state

const state = { q: '', path: '/', all: false };
let request = null; // AbortController for the view being loaded
let search = { page: 0, hasMore: false, loading: false, terms: [] };
let status = null;

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
  toasts: $('toasts'),
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
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.path !== '/') p.set('in', state.path);
  if (state.all) p.set('all', '1');
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
  const res = await fetch(`/api/${endpoint}?${p}`, { signal, headers: { Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const err = new Error(body?.error || `The server answered with an error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  els.toasts.append(el);
  setTimeout(() => el.remove(), 5000);
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

function showTray(label, detail) {
  els.trayLabel.textContent = label;
  els.trayCommand.textContent = detail;
  els.tray.hidden = false;
}

function setRowState(row, copied) {
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

// ------------------------------------------------------------------ rows

function createRow(file, terms) {
  const prefix = file.c.slice(0, file.p);
  const name = file.c.slice(file.p);
  const copied = marks.has(markKey(file.c));
  const kindClass = file.k === 1 ? ' is-archive' : file.k === 2 ? ' is-other' : '';
  const row = h('button', {
    type: 'button',
    class: `row${copied ? ' was-copied' : ''}`,
    title: 'Copy this command',
    'data-command': file.c,
  },
    h('span', { class: 'row-command' },
      h('span', { class: 'row-prefix' }, prefix),
      h('span', { class: 'row-name' }, highlight(name, terms)),
    ),
    h('span', { class: 'row-size' }, formatSize(file.s)),
    h('span', { class: `row-ext${kindClass}` }, file.e || 'file'),
    h('span', { class: 'row-state' }, icon(copied ? 'check' : 'copy'), copied ? 'Copied' : 'Copy'),
  );
  return h('li', null, row);
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
  if (total > 1) {
    const label = `Copy all ${n(total)}`;
    const copyAll = h('button', {
      type: 'button',
      class: 'button',
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
    h('h1', null, atRoot ? 'Browse the list' : folder.name),
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
        : 'Nothing here is an audio file or archive.'),
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

async function load() {
  request?.abort();
  request = new AbortController();
  const { signal } = request;
  moreObserver.disconnect();
  search = { page: 0, hasMore: false, loading: false, terms: [] };
  syncControls();

  try {
    if (state.q.trim()) {
      const data = await api('search', { q: state.q, path: state.path, all: state.all }, signal);
      renderSearch(data, false);
    } else {
      const data = await api('browse', { path: state.path, all: state.all }, signal);
      renderBrowse(data);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err.status === 404 && state.path !== '/') {
      toast('That folder is not in the current list. Showing everything instead.');
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
  Object.assign(state, change);
  writeUrl(push);
  window.scrollTo({ top: 0 });
  load();
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
  navigate({ q: '', path: '/' });
});
$('tray-close').addEventListener('click', () => {
  els.tray.hidden = true;
});

window.addEventListener('popstate', () => {
  readUrl();
  load();
});

els.main.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) copyRow(row);
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

const formatBytes = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

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

function sendFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `The upload failed (${xhr.status}).`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // keep the generic message
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.send(file);
  });
}

/**
 * The file picker + progress used both on the first-run screen and in the
 * "Update the list" dialog.
 */
function createUploader({ replacing, onDone }) {
  const root = h('div', { class: 'uploader' });
  const fileInput = h('input', { type: 'file', accept: '.txt,text/plain', class: 'visually-hidden', tabindex: '-1' });
  const verb = replacing ? 'Replace list' : 'Load list';

  function idle(error) {
    const drop = h('div', { class: 'drop' },
      h('p', null, replacing
        ? 'Drop the new list file here, or choose it from your computer.'
        : 'Drop your list file here, or choose it from your computer.'),
      h('div', { class: 'drop-actions' },
        h('button', { type: 'button', class: 'button is-primary', onclick: () => fileInput.click() }, icon('upload'), 'Choose file'),
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
      const file = e.dataTransfer?.files?.[0];
      if (file) chosen(file);
    });
    setChildren(root,
      error ? h('p', { class: 'callout is-error', role: 'alert' }, error) : null,
      drop,
      fileInput,
    );
  }

  function chosen(file) {
    const tooBig = status?.maxUploadBytes && file.size > status.maxUploadBytes;
    if (tooBig) {
      idle(`${file.name} is ${formatBytes(file.size)}, which is over the ${formatBytes(status.maxUploadBytes)} upload limit.`);
      return;
    }
    root.replaceChildren(h('div', { class: 'drop' },
      h('p', { class: 'drop-file' }, `${file.name} (${formatBytes(file.size)})`),
      replacing ? h('p', null, 'Everything in the current list will be replaced by this file.') : null,
      h('div', { class: 'drop-actions' },
        h('button', { type: 'button', class: 'button is-primary', onclick: () => run(file) }, verb),
        h('button', { type: 'button', class: 'button is-quiet', onclick: () => idle() }, 'Choose a different file'),
      ),
    ));
  }

  async function run(file) {
    const progress = progressEl();
    root.replaceChildren(h('div', { class: 'drop' },
      h('p', { class: 'drop-file' }, file.name),
      progress.el,
    ));
    try {
      progress.set('Uploading…', 0);
      await sendFile(file, (f) => progress.set('Uploading…', f));
      progress.set('Reading folders…', 0);
      const final = await watchImport(progress);
      if (final.import.error) throw new Error(final.import.error);
      status = final;
      const info = final.library;
      root.replaceChildren(
        h('p', { class: 'callout is-done', role: 'status' },
          `${replacing ? 'List replaced' : 'List loaded'}: ${plural(info.files, 'file')} in ${plural(info.folders, 'folder')}.`,
          info.skippedLines ? ` ${plural(info.skippedLines, 'line')} could not be read and ${info.skippedLines === 1 ? 'was' : 'were'} skipped.` : '',
        ),
      );
      onDone(final);
    } catch (err) {
      idle(replacing ? `${err.message} The current list has not been changed.` : err.message);
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) chosen(file);
  });

  idle();
  return root;
}

function openUpdateDialog() {
  const info = status?.library;
  const uploader = createUploader({
    replacing: true,
    onDone: (final) => {
      applyStatus(final);
      uploader.append(h('div', { class: 'drop-actions' },
        h('button', { type: 'button', class: 'button is-primary', onclick: () => els.updateDialog.close() }, 'Done'),
      ));
      uploader.lastChild.style.marginTop = '14px';
      readUrl();
      load();
    },
  });
  setChildren(els.updateBody,
    info ? h('dl', { class: 'facts' },
      h('dt', null, 'Current list'), h('dd', null, info.sourceName),
      h('dt', null, 'Loaded'), h('dd', null, formatDate(info.importedAt)),
      h('dt', null, 'Contains'), h('dd', null, `${plural(info.files, 'file')} in ${plural(info.folders, 'folder')}`),
    ) : null,
    h('p', null, 'Upload a newer copy of the list to replace the current one. If the new file cannot be read, the current list stays as it is.'),
    uploader,
  );
  els.updateDialog.showModal();
}
els.listButton.addEventListener('click', openUpdateDialog);

// Close dialogs when the backdrop is clicked.
for (const dialog of [els.updateDialog, els.manualDialog]) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ------------------------------------------------------------------ boot

function applyStatus(s) {
  status = s;
  const info = s.library;
  const ready = s.state === 'ready';
  els.searchbar.hidden = !ready;
  els.listButton.hidden = !ready;
  els.foot.hidden = !ready;
  if (info) {
    const day = new Date(info.importedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    els.listSummary.textContent = `${plural(info.files, 'file')}, loaded ${day}`;
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

  if (s.import.running && s.state !== 'ready') {
    const progress = progressEl();
    progress.set(`${s.import.phase}…`, s.import.progress);
    els.main.replaceChildren(h('div', { class: 'notice' },
      h('h1', null, 'Loading the list'),
      h('p', null, 'This takes a few seconds. The page continues on its own when it is done.'),
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
      h('p', null, 'Upload the text file that lists your commands. Each command sits on its own line and starts with “!”.'),
      s.import.error ? h('p', { class: 'callout is-error' }, `The last upload failed: ${s.import.error}`) : null,
      createUploader({ replacing: false, onDone: () => setTimeout(init, 900) }),
    ));
    return;
  }

  readUrl();
  renderMarksNote();
  await load();
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) els.input.focus({ preventScroll: true });
}

init();
