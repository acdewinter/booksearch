// The IRC side of the page: live connection state, the download queue, the
// message log and the connection settings.

import { $, formatBytes, h, plural, postJson, setChildren, toast } from './dom.js';

/** What the server last told us. Kept current by the event stream. */
export const irc = {
  loaded: false,
  configured: false,
  settings: null,
  conn: null,
  folder: null,
  reverseDcc: false,
  items: new Map(),
  log: [],
};

const ACTIVE = new Set(['queued', 'sent', 'offered', 'connecting', 'downloading']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const MAX_LOG_LINES = 700;

const listeners = new Set();
let byCommand = new Map();

/** Call fn(kind, payload) whenever something changes. Kinds: all, conn, settings, folder, download, remove. */
export function onIrc(fn) {
  listeners.add(fn);
}

function announce(kind, payload) {
  for (const fn of listeners) fn(kind, payload);
  view?.on(kind, payload);
}

function indexCommands() {
  byCommand = new Map();
  for (const item of irc.items.values()) {
    if (item.command) byCommand.set(item.command, item);
  }
}

/** The queue entry for a list command, if it was requested. */
export function itemFor(command) {
  return byCommand.get(command) || null;
}

export const isActive = (item) => Boolean(item) && ACTIVE.has(item.status);

export function activeCount() {
  let count = 0;
  for (const item of irc.items.values()) if (ACTIVE.has(item.status)) count += 1;
  return count;
}

export const ircPost = (name, body) => postJson(`/api/irc/${name}`, body);

/** Open the live connection to the server. The browser reconnects it by itself. */
export function startIrc() {
  const source = new EventSource('/api/irc/events');
  const on = (name, fn) => source.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  on('hello', (snap) => {
    irc.loaded = true;
    irc.configured = snap.configured;
    irc.settings = snap.settings;
    irc.conn = snap.conn;
    irc.folder = snap.folder;
    irc.reverseDcc = snap.reverseDcc;
    irc.items = new Map(snap.items.map((item) => [item.id, item]));
    irc.log = snap.log;
    indexCommands();
    announce('all');
  });
  on('conn', (conn) => {
    irc.conn = conn;
    announce('conn');
  });
  on('settings', (data) => {
    const was = irc.configured;
    irc.settings = data.settings;
    irc.configured = data.configured;
    announce(was === data.configured ? 'settings' : 'all');
  });
  on('folder', (folder) => {
    irc.folder = folder;
    announce('folder');
  });
  on('download', (item) => {
    irc.items.set(item.id, item);
    if (item.command) byCommand.set(item.command, item);
    announce('download', item);
  });
  on('remove', ({ id }) => {
    const item = irc.items.get(id);
    if (!item) return;
    irc.items.delete(id);
    if (item.command && byCommand.get(item.command) === item) {
      byCommand.delete(item.command);
      indexCommands();
    }
    announce('remove', item);
  });
  on('log', (line) => {
    irc.log.push(line);
    if (irc.log.length > MAX_LOG_LINES) irc.log.splice(0, irc.log.length - MAX_LOG_LINES);
    announce('log', line);
  });
}

// ------------------------------------------------------------- wording

/** One-line summary of the connection, for the header and the status card. */
export function connSummary() {
  const c = irc.conn;
  if (!irc.loaded || !c) return { tone: 'off', label: 'Downloads' };
  if (!irc.configured) return { tone: 'off', label: 'Not set up' };
  if (c.status === 'online') {
    return c.channel.joined
      ? { tone: 'on', label: c.channel.name }
      : { tone: c.channel.error ? 'error' : 'busy', label: c.channel.error ? `Not in ${c.channel.name}` : 'Joining' };
  }
  if (c.status === 'connecting' || c.status === 'signing-in') return { tone: 'busy', label: 'Connecting' };
  if (c.status === 'retrying') return { tone: 'busy', label: 'Reconnecting' };
  return { tone: c.error ? 'error' : 'off', label: 'Not connected' };
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} h ${Math.round((seconds % 3600) / 60)} min`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function when(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(ms) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Why a queued request has not been sent yet. */
function waitReason(item) {
  const c = irc.conn;
  if (!c || c.status !== 'online') return { text: 'Waiting for the connection.' };
  if (!c.channel.joined) return { text: `Waiting to join ${c.channel.name}.` };
  if (irc.settings?.holdForBot && !item.force && c.bots?.[item.bot] === false) {
    return { text: `Waiting for ${item.bot} to come back to ${c.channel.name}.`, held: true };
  }
  return { text: 'Waiting for its turn.' };
}

/** Text and buttons for one queue entry. */
function describe(item) {
  const act = (label, action, opts = {}) => ({ label, action, ...opts });
  const size = item.size > 0 ? formatBytes(item.size) : '';
  switch (item.status) {
    case 'queued': {
      const reason = waitReason(item);
      return {
        text: reason.text,
        actions: [reason.held ? act('Send anyway', 'force') : null, act('Cancel', 'cancel')],
      };
    }
    case 'sent':
      return {
        text: `Asked ${item.bot} at ${clock(item.sentAt)}. Waiting for it to send the file.`,
        actions: [act('Cancel', 'cancel', { title: `Stop waiting for this file. ${item.bot} is not told.` })],
      };
    case 'noreply':
      return {
        text: `${item.bot} has not answered since ${clock(item.sentAt)}. The file is still accepted if it arrives.`,
        actions: [act('Ask again', 'retry'), act('Remove', 'cancel')],
      };
    case 'offered':
      return {
        text: `${item.bot} wants to send you this file${size ? ` (${size})` : ''}. You did not ask for it.`,
        actions: [act('Accept', 'accept', { primary: true }), act('Decline', 'cancel')],
      };
    case 'connecting':
      return {
        text: item.received > 0
          ? `Asking ${item.bot} to continue from ${formatBytes(item.received)}.`
          : `Connecting to ${item.bot}.`,
        actions: [act('Cancel', 'cancel')],
        progress: item.size > 0 ? item.received / item.size : 0,
      };
    case 'downloading': {
      const parts = [item.size > 0 ? `${formatBytes(item.received)} of ${size}` : formatBytes(item.received)];
      if (item.rate > 0) {
        parts.push(`${formatBytes(item.rate)}/s`);
        if (item.size > 0) parts.push(`${duration((item.size - item.received) / item.rate)} left`);
      }
      return {
        text: parts.join(' · '),
        actions: [act('Cancel', 'cancel', { title: 'Stop and delete the partial file' })],
        progress: item.size > 0 ? item.received / item.size : null,
      };
    }
    case 'done': {
      const parts = [];
      if (item.note === 'already') parts.push('Already in the download folder');
      else parts.push(`Saved${size ? ` · ${size}` : ''}`);
      if (item.file && item.file !== item.name) parts.push(`as ${item.file}`);
      if (item.finishedAt) parts.push(when(item.finishedAt));
      return { text: parts.join(' · '), actions: [act('Remove', 'remove', { title: 'Remove from this list. The file stays.' })] };
    }
    case 'failed':
      return {
        text: item.error || 'The download failed.',
        actions: [item.command ? act('Try again', 'retry') : null, act('Remove', 'remove')],
      };
    case 'cancelled':
      return {
        text: 'Cancelled.',
        actions: [item.command ? act('Ask again', 'retry') : null, act('Remove', 'remove')],
      };
    default:
      return { text: item.status, actions: [] };
  }
}

async function runAction(item, action, button) {
  if (button) button.disabled = true;
  try {
    await ircPost('act', { id: item.id, action });
  } catch (err) {
    toast(err.message);
  }
  if (button?.isConnected) button.disabled = false;
}

// ------------------------------------------------------- the downloads page

let view = null;

const RANK = { downloading: 0, connecting: 0, offered: 1, sent: 2, queued: 3, noreply: 4 };

function createItemRow(item) {
  const name = h('p', { class: 'dl-name' });
  const text = h('p', { class: 'dl-text' });
  const bar = h('div', { class: 'progress-bar' });
  const track = h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const actions = h('div', { class: 'dl-actions' });
  const el = h('li', { class: 'dl' }, h('div', { class: 'dl-main' }, name, text, track), actions);
  let actionKey = '';

  function update(next) {
    const d = describe(next);
    el.className = `dl is-${next.status}`;
    name.textContent = next.name || next.command;
    name.title = next.command || next.name;
    text.textContent = d.text;

    const showBar = d.progress !== undefined;
    track.hidden = !showBar;
    if (showBar) {
      const known = d.progress !== null;
      track.classList.toggle('is-unknown', !known);
      const pct = known ? Math.round(Math.min(1, Math.max(0, d.progress)) * 100) : 0;
      bar.style.width = known ? `${pct}%` : '';
      if (known) track.setAttribute('aria-valuenow', String(pct));
      else track.removeAttribute('aria-valuenow');
    }

    // Rebuild the buttons only when they change, so a button being clicked is not replaced mid-click.
    const list = d.actions.filter(Boolean);
    const key = list.map((a) => a.action + a.label).join('|');
    if (key !== actionKey) {
      actionKey = key;
      setChildren(actions, list.map((a) => {
        const button = h('button', {
          type: 'button',
          class: `button${a.primary ? '' : ' is-quiet'}`,
          title: a.title,
          onclick: () => runAction(irc.items.get(next.id) || next, a.action, button),
        }, a.label);
        return button;
      }));
    }
  }
  update(item);
  return { el, update };
}

function createLogLine(line) {
  return h('div', { class: `chat-line is-${line.kind}${line.channel ? ' is-chatter' : ''}` },
    h('time', null, clock(line.t)),
    line.from ? h('span', { class: 'chat-from' }, line.from) : null,
    h('span', { class: 'chat-text' }, line.text),
  );
}

/** Build the downloads page inside `container`. It keeps itself up to date until unmounted. */
export function mountDownloads(container) {
  unmountDownloads();

  const folderLine = h('p', { class: 'place-meta' });
  const folderError = h('p', { class: 'callout is-error', role: 'alert', hidden: true });
  const card = h('section', { class: 'conn', 'aria-live': 'polite' });

  const activeList = h('ul', { class: 'dl-list' });
  const activeEmpty = h('p', { class: 'dl-empty' });
  const doneList = h('ul', { class: 'dl-list' });
  const clearButton = h('button', {
    type: 'button',
    class: 'button is-quiet',
    title: 'Remove finished entries from this list. Downloaded files stay.',
    onclick: async () => {
      try {
        await ircPost('clear');
      } catch (err) {
        toast(err.message);
      }
    },
  }, 'Clear list');
  const doneCount = h('span', { class: 'group-count' });
  const doneSection = h('section', { class: 'group', hidden: true },
    h('header', { class: 'group-head' },
      h('h2', { class: 'section-title' }, 'Finished'),
      h('div', { class: 'group-actions' }, doneCount, clearButton),
    ),
    doneList,
  );
  const activeCountEl = h('span', { class: 'group-count' });
  const activeSection = h('section', { class: 'group' },
    h('header', { class: 'group-head' },
      h('h2', { class: 'section-title' }, 'Queue'),
      h('div', { class: 'group-actions' }, activeCountEl),
    ),
    activeList,
    activeEmpty,
  );

  // Messages
  const log = h('div', { class: 'chat-log hide-chatter', role: 'log', 'aria-label': 'IRC messages', tabindex: '0' });
  const input = h('input', {
    type: 'text', class: 'chat-input', autocomplete: 'off', spellcheck: 'false', maxlength: '400', 'aria-label': 'Message',
  });
  const send = h('button', { type: 'submit', class: 'button' }, 'Send');
  const form = h('form', { class: 'chat-form' }, input, send);
  const forMe = h('button', { type: 'button', 'aria-pressed': 'true', title: 'Messages to you, and what the app did' }, 'For you');
  const everything = h('button', { type: 'button', 'aria-pressed': 'false', title: 'Also what everyone says in the channel' }, 'Whole channel');
  const chatSection = h('section', { class: 'group chat' },
    h('header', { class: 'group-head' },
      h('h2', { class: 'section-title' }, 'Messages'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Which messages to show' }, forMe, everything),
    ),
    log,
    form,
  );

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const toBottom = () => {
    log.scrollTop = log.scrollHeight;
  };
  function setFilter(all) {
    log.classList.toggle('hide-chatter', !all);
    forMe.setAttribute('aria-pressed', String(!all));
    everything.setAttribute('aria-pressed', String(all));
    toBottom();
  }
  forMe.addEventListener('click', () => setFilter(false));
  everything.addEventListener('click', () => setFilter(true));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await ircPost('say', { text });
      input.value = '';
    } catch (err) {
      toast(err.message);
    }
    send.disabled = false;
    input.focus();
  });

  function renderLog() {
    setChildren(log, irc.log.length
      ? irc.log.map(createLogLine)
      : h('p', { class: 'chat-empty' }, 'Nothing yet. Messages from the server and from senders show up here.'));
    toBottom();
  }
  function addLogLine(line) {
    const stick = atBottom();
    log.querySelector('.chat-empty')?.remove();
    log.append(createLogLine(line));
    while (log.childElementCount > MAX_LOG_LINES) log.firstElementChild.remove();
    if (stick) toBottom();
  }

  // Queue
  const rows = new Map();
  function placeRows() {
    const active = [];
    const done = [];
    for (const item of irc.items.values()) (FINISHED.has(item.status) ? done : active).push(item);
    active.sort((a, b) => (RANK[a.status] - RANK[b.status]) || (a.queuedAt - b.queuedAt) || (Number(a.id) - Number(b.id)));
    done.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));

    for (const [list, items] of [[activeList, active], [doneList, done]]) {
      items.forEach((item, i) => {
        const { el } = rows.get(item.id);
        if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
      });
    }
    doneSection.hidden = done.length === 0;
    doneCount.textContent = plural(done.length, 'file');
    activeCountEl.textContent = active.length ? plural(active.length, 'file') : '';
    activeEmpty.hidden = active.length > 0;
    activeEmpty.textContent = irc.configured
      ? 'Nothing waiting. Find a book in the search and click it to ask for it here.'
      : 'Nothing here yet.';
  }
  function upsert(item) {
    const row = rows.get(item.id);
    if (row) row.update(item);
    else rows.set(item.id, createItemRow(item));
  }
  function renderItems() {
    for (const [id, row] of rows) {
      if (!irc.items.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    for (const item of irc.items.values()) upsert(item);
    placeRows();
  }

  // Connection card
  function renderCard() {
    const c = irc.conn;
    const s = irc.settings;
    const summary = connSummary();
    const button = (label, onclick, primary) => h('button', { type: 'button', class: `button${primary ? ' is-primary' : ' is-quiet'}`, onclick }, label);
    const call = (name) => async (e) => {
      e.currentTarget.disabled = true;
      try {
        await ircPost(name);
      } catch (err) {
        toast(err.message);
      }
    };
    const settingsButton = button('Settings', () => openSettings());
    let title;
    let lines = [];
    let buttons = [];

    if (!irc.loaded || !c) {
      title = 'Loading…';
    } else if (!irc.configured) {
      title = 'Not set up yet';
      lines = ['Tell Shelfmark which IRC server and channel to use. After that, clicking a file in the search results asks for it in the channel, and the file is saved to the download folder when it is sent.'];
      buttons = [button('Set up the connection', () => openSettings(), true)];
    } else if (c.status === 'online') {
      const where = c.network && c.network.toLowerCase() !== c.host.toLowerCase() ? `${c.network} (${c.host})` : c.host;
      title = `Connected to ${where} as ${c.nick}`;
      if (c.channel.joined) {
        const others = Math.max(0, c.channel.people - 1);
        lines.push(`In ${c.channel.name} with ${plural(others, 'other')}.`);
        for (const [bot, present] of Object.entries(c.bots || {})) {
          if (present === false) {
            lines.push({
              warn: true,
              text: irc.settings.holdForBot
                ? `${bot} is not in the channel right now. Requests wait until it is back.`
                : `${bot} is not in the channel right now.`,
            });
          }
        }
      } else if (c.channel.error) {
        lines.push({ error: true, text: `Not in ${c.channel.name}. ${c.channel.error}` });
        buttons.push(button('Try joining again', call('join'), true));
      } else {
        lines.push(`Joining ${c.channel.name}…`);
      }
      buttons.push(button('Disconnect', call('disconnect')), settingsButton);
    } else if (c.status === 'connecting' || c.status === 'signing-in') {
      title = c.status === 'connecting' ? `Connecting to ${c.host}…` : `Signing in to ${c.host}…`;
      buttons = [button('Cancel', call('disconnect')), settingsButton];
    } else if (c.status === 'retrying') {
      title = 'Connection lost';
      const seconds = Math.max(0, Math.round((c.retryAt - Date.now()) / 1000));
      if (c.error) lines.push({ error: true, text: c.error });
      lines.push(seconds > 0 ? `Trying again in ${duration(seconds)}.` : 'Trying again…');
      buttons = [button('Try now', call('connect'), true), button('Stop trying', call('disconnect')), settingsButton];
    } else {
      title = 'Not connected';
      lines.push(`${s.host}, ${s.channel}, as ${s.nick}.`);
      if (c.error) lines.push({ error: true, text: c.error });
      buttons = [button('Connect', call('connect'), true), settingsButton];
    }

    setChildren(card,
      h('span', { class: `dot is-${summary.tone}`, 'aria-hidden': 'true' }),
      h('div', { class: 'conn-text' },
        h('h2', { class: 'conn-title' }, title),
        lines.map((line) => (typeof line === 'string'
          ? h('p', null, line)
          : h('p', { class: line.error ? 'is-error' : 'is-warn' }, line.text))),
      ),
      h('div', { class: 'conn-actions' }, buttons),
    );

    const online = c?.status === 'online';
    input.disabled = !online;
    send.disabled = !online;
    input.placeholder = online
      ? (c.channel.joined ? `Message ${c.channel.name}, or /msg nickname text` : '/msg nickname text')
      : 'Connect to send messages';
  }

  function renderFolder() {
    const f = irc.folder;
    if (!f) return;
    setChildren(folderLine,
      'Files are saved to ', h('code', null, f.path),
      f.freeBytes != null ? `, which has ${formatBytes(f.freeBytes)} free.` : '.',
    );
    folderError.hidden = f.ok;
    folderError.textContent = f.ok ? '' : `The download folder cannot be used: ${f.error} Nothing can be saved until this is fixed.`;
  }

  function renderAll() {
    renderFolder();
    renderCard();
    renderItems();
    renderLog();
    const blank = !irc.configured && irc.items.size === 0;
    activeSection.hidden = blank;
    chatSection.hidden = blank;
  }

  setChildren(container,
    h('div', { class: 'place' }, h('h1', null, 'Downloads'), folderLine),
    folderError,
    card,
    activeSection,
    doneSection,
    chatSection,
  );
  renderAll();

  const timer = setInterval(() => {
    if (irc.conn?.status === 'retrying') renderCard();
  }, 1000);

  view = {
    container,
    timer,
    on(kind, payload) {
      if (kind === 'all') return renderAll();
      if (kind === 'conn' || kind === 'settings') {
        renderCard();
        // "Waiting for the connection" and similar lines depend on the connection.
        for (const item of irc.items.values()) if (item.status === 'queued') upsert(item);
        return undefined;
      }
      if (kind === 'folder') return renderFolder();
      if (kind === 'download') {
        upsert(payload);
        return placeRows();
      }
      if (kind === 'remove') {
        rows.get(payload.id)?.el.remove();
        rows.delete(payload.id);
        return placeRows();
      }
      if (kind === 'log') return addLogLine(payload);
      return undefined;
    },
  };
}

export function unmountDownloads() {
  if (!view) return;
  clearInterval(view.timer);
  view = null;
}

// ------------------------------------------------------------ settings

/** The connection settings form, in a dialog. */
export function openSettings() {
  const dialog = $('irc-dialog');
  const body = $('irc-body');
  const s = irc.settings || {};
  const errors = {};

  const input = (name, attrs = {}) => h('input', {
    name, id: `irc-${name}`, type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', ...attrs,
  });
  const field = (label, control, hint) => {
    const name = control.getAttribute('name');
    const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
    errors[name] = error;
    return h('div', { class: 'field' },
      h('label', { for: control.id }, label),
      control,
      hint ? h('p', { class: 'field-hint' }, hint) : null,
      error,
    );
  };
  const check = (name, label, checked, hint) => {
    const box = h('input', { type: 'checkbox', name, id: `irc-${name}` });
    box.checked = Boolean(checked);
    return {
      box,
      el: h('div', { class: 'field is-check' },
        h('label', { for: box.id }, box, h('span', null, label)),
        hint ? h('p', { class: 'field-hint' }, hint) : null,
      ),
    };
  };
  const secret = (name, label, saved, hint) => {
    const control = input(name, {
      type: 'password', autocomplete: 'new-password',
      placeholder: saved ? 'Saved. Type to replace it.' : '',
    });
    const wrap = field(label, control, hint);
    let forget = false;
    if (saved) {
      const button = h('button', {
        type: 'button',
        class: 'text-button',
        onclick: () => {
          forget = true;
          control.value = '';
          control.placeholder = 'Will be removed when you save.';
          button.remove();
        },
      }, 'Remove the saved password');
      wrap.append(button);
    }
    // Not typed in = keep what is saved.
    return { el: wrap, value: () => (control.value ? control.value : forget ? '' : undefined) };
  };

  const host = input('host', { placeholder: 'irc.example.net', required: true, inputmode: 'url' });
  host.value = s.host || '';
  const port = input('port', { inputmode: 'numeric', class: 'is-short' });
  port.value = String(s.port || 6697);
  const tlsBox = check('tls', 'Secure connection (TLS)', s.tls !== false);
  // Keep the usual port in step with the TLS box, unless a special one was typed.
  tlsBox.box.addEventListener('change', () => {
    if (tlsBox.box.checked && port.value === '6667') port.value = '6697';
    else if (!tlsBox.box.checked && port.value === '6697') port.value = '6667';
  });
  const nick = input('nick', { required: true, maxlength: '30' });
  nick.value = s.nick || '';
  const channel = input('channel', { placeholder: '#channel', required: true });
  channel.value = s.channel || '';

  const channelKey = input('channelKey');
  channelKey.value = s.channelKey || '';
  const serverPassword = secret('serverPassword', 'Server password', s.hasServerPassword, 'Only for servers that ask for one when connecting.');
  const accountPassword = secret('accountPassword', 'Nickname password', s.hasAccountPassword, 'For a registered nickname. Used to sign in with NickServ.');
  const tlsVerify = check('tlsVerify', 'Check the server\'s security certificate', s.tlsVerify !== false, 'Turn off only for a server you trust that uses a self-signed certificate.');
  const trusted = input('trustedNicks', { placeholder: 'nickname, nickname' });
  trusted.value = (s.trustedNicks || []).join(', ');
  const maxActive = input('maxActive', { inputmode: 'numeric', class: 'is-short' });
  maxActive.value = String(s.maxActive ?? 1);
  const sendInterval = input('sendIntervalSec', { inputmode: 'numeric', class: 'is-short' });
  sendInterval.value = String(s.sendIntervalSec ?? 5);
  const timeout = input('requestTimeoutMin', { inputmode: 'numeric', class: 'is-short' });
  timeout.value = String(s.requestTimeoutMin ?? 20);
  const hold = check('holdForBot', 'Hold requests while the bot is not in the channel', s.holdForBot !== false);
  const allowPrivate = check('allowPrivate', 'Allow senders on a private network', s.allowPrivate, 'Addresses such as 192.168.x.x. Leave off unless the sender is on your own network.');
  const onlyList = check('onlyListSenders', 'Only take files from senders in your lists', s.onlyListSenders !== false,
    'A sender is in your lists when their commands are: !TrainFiles means TrainFiles. A file from anyone else is refused without asking you, unless you asked them for it or their nickname is listed below.');

  const connected = irc.conn && irc.conn.status !== 'offline';
  const formError = h('p', { class: 'callout is-error', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'button is-primary' }, connected ? 'Save' : 'Save and connect');
  const cancel = h('button', { type: 'button', class: 'button is-quiet', onclick: () => dialog.close() }, 'Cancel');

  const form = h('form', { class: 'form', novalidate: true },
    formError,
    h('div', { class: 'field-row' },
      field('Server', host),
      field('Port', port),
    ),
    tlsBox.el,
    field('Nickname', nick, 'The name you are known by on the server.'),
    field('Channel', channel, 'Where requests are sent.'),
    h('details', { class: 'more-options' },
      h('summary', null, 'More options'),
      field('Channel key', channelKey, 'Only for channels protected with a key.'),
      accountPassword.el,
      serverPassword.el,
      tlsVerify.el,
      onlyList.el,
      field('Also accept files from', trusted, 'Files you asked for are accepted from the bot you asked. Files from these nicknames are accepted too, without asking.'),
      h('div', { class: 'field-row' },
        field('Requests at a time', maxActive),
        field('Seconds between requests', sendInterval),
        field('Minutes to wait for a reply', timeout),
      ),
      hold.el,
      allowPrivate.el,
      irc.reverseDcc ? null : h('p', { class: 'field-hint' }, 'Senders behind a firewall need this app to accept the connection. That is off: it needs DCC_PORTS, described in the deployment guide.'),
    ),
    h('div', { class: 'form-actions' }, save, cancel),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const el of Object.values(errors)) el.hidden = true;
    formError.hidden = true;
    const missing = [[host, 'host', 'Fill in the server address.'], [nick, 'nick', 'Choose a nickname.'], [channel, 'channel', 'Fill in the channel.']]
      .filter(([control]) => !control.value.trim());
    if (missing.length) {
      for (const [, name, message] of missing) {
        errors[name].textContent = message;
        errors[name].hidden = false;
      }
      missing[0][0].focus();
      return;
    }
    save.disabled = true;
    try {
      await ircPost('settings', {
        host: host.value,
        port: port.value,
        tls: tlsBox.box.checked,
        tlsVerify: tlsVerify.box.checked,
        nick: nick.value,
        channel: channel.value,
        channelKey: channelKey.value,
        serverPassword: serverPassword.value(),
        accountPassword: accountPassword.value(),
        trustedNicks: trusted.value,
        maxActive: maxActive.value,
        sendIntervalSec: sendInterval.value,
        requestTimeoutMin: timeout.value,
        holdForBot: hold.box.checked,
        allowPrivate: allowPrivate.box.checked,
        onlyListSenders: onlyList.box.checked,
      });
      if (!connected) await ircPost('connect');
      dialog.close();
    } catch (err) {
      let first = null;
      for (const [name, message] of Object.entries(err.fields || {})) {
        if (!errors[name]) continue;
        errors[name].textContent = message;
        errors[name].hidden = false;
        first ??= form.elements[name];
      }
      if (first) {
        first.closest('details')?.setAttribute('open', '');
        first.focus();
      } else {
        formError.textContent = err.message;
        formError.hidden = false;
      }
    }
    save.disabled = false;
  });

  setChildren(body, form);
  dialog.showModal();
  (s.host ? save : host).focus();
}

/** Ask for commands from the list. Returns the queue entries. */
export async function requestCommands(commands) {
  const out = [];
  for (let i = 0; i < commands.length; i += 100) {
    const res = await ircPost('request', { commands: commands.slice(i, i + 100) });
    out.push(...res.items);
  }
  return out;
}
