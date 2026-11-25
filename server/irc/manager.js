// Everything between the web interface and IRC: the saved connection settings,
// the queue of requested files, incoming DCC offers and the running transfers.

import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { IrcClient } from './client.js';
import { DccReceive, describeFsError, listenInRange } from './dcc.js';
import {
  cleanOutgoing, formatDccAddress, isPrivateAddress, lower, namesMatch, parseDcc,
  parseRequestCommand, sanitizeFilename,
} from './protocol.js';

/** An error whose message is meant for the person using the app. */
export class UserError extends Error {
  constructor(message, fields = null) {
    super(message);
    this.fields = fields;
  }
}

const DEFAULT_SETTINGS = {
  host: '',
  port: 6697,
  tls: true,
  tlsVerify: true,
  nick: '',
  serverPassword: '',
  accountPassword: '',
  channel: '',
  channelKey: '',
  trustedNicks: [],
  maxActive: 1,
  sendIntervalSec: 5,
  requestTimeoutMin: 20,
  holdForBot: true,
  allowPrivate: false,
};
const SECRET_FIELDS = ['serverPassword', 'accountPassword'];
// Changing any of these means the connection has to be made again.
const CONNECTION_FIELDS = ['host', 'port', 'tls', 'tlsVerify', 'nick', 'serverPassword', 'accountPassword'];

const NICK_RE = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/;

const SEND_GRACE_MS = 3000;          // a click can be undone for this long before it reaches the channel
const OFFER_TTL_MS = 150_000;        // senders give up on an unanswered offer after a couple of minutes
const RETRY_OFFER_MS = 15 * 60_000;  // a sender may offer a failed file again within this time
const LISTEN_TIMEOUT_MS = 60_000;
const SPACE_RESERVE = 64 * 1024 * 1024;
const RETRY_DELAYS_S = [5, 15, 30, 60, 120, 300];
const MAX_ITEMS = 300;
const MAX_QUEUED = 200;
const MAX_PENDING_OFFERS = 10;
const LOG_ME = 400;
const LOG_CHANNEL = 300;

const BUSY = new Set(['connecting', 'downloading']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "name.zip" -> "name (2).zip" when the first is taken. */
function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

const quoteName = (name) => (/\s/.test(name) ? `"${name.replace(/"/g, '')}"` : name);

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

export class IrcManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir     where settings and the queue are remembered
   * @param {string} o.downloadDir where finished files go
   * @param {{min:number,max:number}|null} o.dccPorts ports to accept reverse DCC on
   * @param {string} o.dccPublicIp this machine's address as seen from the internet
   * @param {string} o.version
   * @param {number} [o.resumeTimeoutMs] how long to wait for a sender to agree to resume
   */
  constructor(o) {
    super();
    this.settingsPath = path.join(o.dataDir, 'irc-settings.json');
    this.statePath = path.join(o.dataDir, 'irc-state.json');
    this.downloadDir = o.downloadDir;
    this.dccPorts = o.dccPorts || null;
    this.dccPublicIp = o.dccPublicIp || '';
    this.version = o.version || '';
    this.resumeTimeoutMs = o.resumeTimeoutMs || 15_000;

    this.settings = { ...DEFAULT_SETTINGS };
    this.items = new Map();   // id -> item, in the order they were queued
    this.live = new Map();    // id -> { offer, transfer, partPath, resume, rate, lastBytes, lastAt }
    this.seq = 0;
    this.logSeq = 0;
    this.logMe = [];
    this.logChannel = [];

    this.client = null;
    this.status = 'offline';  // offline | connecting | signing-in | online | retrying
    this.wantOnline = false;
    this.lastError = '';
    this.retryAt = null;
    this.retryTimer = null;
    this.attempt = 0;
    this.onlineSince = null;
    this.lastSentAt = 0;
    this.rejoins = 0;
    this.folder = { path: this.downloadDir, ok: true, error: '', freeBytes: null };

    this.saveTimer = null;
    this.connTimer = null;
    this.ticks = 0;
    this.ticker = null;
  }

  // ---------------------------------------------------------------- start

  start() {
    const saved = readJson(this.settingsPath);
    if (saved) this.settings = { ...DEFAULT_SETTINGS, ...this.#validate(saved, DEFAULT_SETTINGS).settings };

    const state = readJson(this.statePath);
    if (state) {
      this.seq = Number(state.seq) || 0;
      this.wantOnline = Boolean(state.online);
      for (const item of state.items || []) {
        if (!item || typeof item.id !== 'string') continue;
        if (item.status === 'offered') continue; // the offer is long gone
        if (BUSY.has(item.status)) {
          item.status = 'failed';
          item.error = 'Interrupted when the app restarted.';
          item.finishedAt = Date.now();
        }
        this.items.set(item.id, item);
      }
    }

    this.#refreshFolder();
    this.ticker = setInterval(() => this.#tick(), 1000);
    this.ticker.unref();
    if (this.wantOnline && this.configured) this.#open();
  }

  /** Close everything before the process exits. Partial files stay for resuming. */
  shutdown() {
    clearInterval(this.ticker);
    clearTimeout(this.retryTimer);
    clearTimeout(this.connTimer);
    for (const [id, live] of this.live) {
      clearTimeout(live.resume?.timer);
      const item = this.items.get(id);
      if (live.transfer && item && BUSY.has(item.status)) {
        live.transfer.cancel();
        item.status = 'failed';
        item.error = 'Interrupted when the app restarted.';
        item.finishedAt = Date.now();
      }
    }
    this.live.clear();
    this.#saveNow();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
      this.client.quit('Shelfmark is shutting down');
      this.client = null;
    }
  }

  // ------------------------------------------------------------- snapshot

  get configured() {
    const s = this.settings;
    return Boolean(s.host && s.nick && s.channel);
  }

  #publicSettings() {
    const out = { ...this.settings };
    for (const key of SECRET_FIELDS) {
      out[`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(out[key]);
      delete out[key];
    }
    return out;
  }

  #publicItem(item) {
    const live = this.live.get(item.id);
    return { ...item, rate: live?.rate || 0 };
  }

  #conn() {
    const s = this.settings;
    const c = this.client;
    const entry = c?.channels.get(lower(s.channel));
    const bots = {};
    if (c && entry?.joined) {
      const names = new Set(s.trustedNicks);
      for (const item of this.items.values()) {
        if (item.requested) names.add(item.bot);
      }
      for (const name of names) bots[name] = c.isPresent(entry.name, name);
    }
    return {
      status: this.status,
      host: s.host,
      nick: c?.nick || s.nick,
      network: c?.network || '',
      error: this.lastError,
      retryAt: this.retryAt,
      channel: {
        name: entry?.name || s.channel,
        joined: Boolean(entry?.joined),
        people: entry?.joined ? entry.members.size : 0,
        error: entry?.error || '',
        topic: entry?.topic || '',
      },
      bots,
    };
  }

  snapshot() {
    return {
      version: this.version,
      configured: this.configured,
      settings: this.#publicSettings(),
      conn: this.#conn(),
      folder: this.folder,
      reverseDcc: Boolean(this.dccPorts),
      items: [...this.items.values()].map((item) => this.#publicItem(item)),
      log: [...this.logMe, ...this.logChannel].sort((a, b) => a.id - b.id),
    };
  }

  #emit(name, payload) {
    this.emit('event', name, payload);
  }

  /** Tell the page the connection changed. Bursts (a netsplit) collapse into one update. */
  #connChanged() {
    if (this.connTimer) return;
    this.connTimer = setTimeout(() => {
      this.connTimer = null;
      this.#emit('conn', this.#conn());
    }, 150);
  }

  #touch(item, { save = true } = {}) {
    this.#emit('download', this.#publicItem(item));
    if (save) this.#save();
  }

  #log(kind, text, { from = '', channel = false } = {}) {
    const line = { id: ++this.logSeq, t: Date.now(), kind, from, text, channel };
    const list = channel ? this.logChannel : this.logMe;
    list.push(line);
    const cap = channel ? LOG_CHANNEL : LOG_ME;
    if (list.length > cap) list.splice(0, list.length - cap);
    this.#emit('log', line);
  }

  // ---------------------------------------------------------- persistence

  #save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.#saveNow(), 800);
    this.saveTimer.unref();
  }

  #saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      writeJson(this.statePath, { seq: this.seq, online: this.wantOnline, items: [...this.items.values()] });
    } catch (err) {
      console.error(`Could not save the download queue: ${err.message}`);
    }
  }

  #refreshFolder() {
    const info = { path: this.downloadDir, ok: true, error: '', freeBytes: null };
    try {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      fs.accessSync(this.downloadDir, fs.constants.W_OK);
      const st = fs.statfsSync(this.downloadDir);
      info.freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch (err) {
      info.ok = false;
      info.error = describeFsError(err);
    }
    const changed = JSON.stringify(info) !== JSON.stringify(this.folder);
    this.folder = info;
    if (changed) this.#emit('folder', info);
    return info;
  }

  // ------------------------------------------------------------- settings

  /** Check and tidy settings from the form. Unknown fields are ignored. */
  #validate(input, base) {
    const out = { ...base };
    const errors = {};
    const text = (v) => (typeof v === 'string' ? v.trim() : '');

    if ('host' in input) {
      let host = text(input.host).replace(/^ircs?:\/\//i, '').replace(/\/.*$/, '');
      const withPort = /^([^:]+):(\d{1,5})$/.exec(host);
      if (withPort) {
        host = withPort[1];
        if (!('port' in input) || !input.port) out.port = Number(withPort[2]);
      }
      if (host && (host.length > 253 || !/^[A-Za-z0-9.\-:[\]]+$/.test(host))) errors.host = 'This does not look like a server address.';
      else out.host = host;
    }
    if ('port' in input && input.port !== '' && input.port != null) {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'The port is a number between 1 and 65535.';
      else out.port = port;
    }
    for (const key of ['tls', 'tlsVerify', 'holdForBot', 'allowPrivate']) {
      if (key in input) out[key] = Boolean(input[key]);
    }
    if ('nick' in input) {
      const nick = text(input.nick);
      if (nick && !NICK_RE.test(nick)) errors.nick = 'A nickname uses letters, digits, - and _ (up to 30), and cannot start with a digit.';
      else out.nick = nick;
    }
    if ('channel' in input) {
      let channel = text(input.channel);
      if (channel && !/^[#&]/.test(channel)) channel = `#${channel}`;
      if (channel && (channel.length > 64 || /[\s,\x00-\x1f]/.test(channel))) errors.channel = 'A channel name has no spaces or commas.';
      else out.channel = channel;
    }
    if ('channelKey' in input) {
      const key = text(input.channelKey);
      if (/[\s,]/.test(key) || key.length > 64) errors.channelKey = 'A channel key has no spaces.';
      else out.channelKey = key;
    }
    for (const key of SECRET_FIELDS) {
      // Not sent = keep what is saved. An empty string removes it.
      if (typeof input[key] === 'string') {
        if (/[\r\n\0]/.test(input[key]) || input[key].length > 200) errors[key] = 'This password cannot be used.';
        else out[key] = input[key];
      }
    }
    if ('trustedNicks' in input) {
      const raw = Array.isArray(input.trustedNicks) ? input.trustedNicks : String(input.trustedNicks || '').split(/[\s,]+/);
      const nicks = [...new Set(raw.map((n) => text(n)).filter(Boolean))];
      const bad = nicks.find((n) => !NICK_RE.test(n));
      if (bad) errors.trustedNicks = `"${bad}" is not a valid nickname.`;
      else out.trustedNicks = nicks.slice(0, 30);
    }
    const range = (key, min, max) => {
      if (!(key in input) || input[key] === '' || input[key] == null) return;
      const value = Number(input[key]);
      if (!Number.isFinite(value)) return;
      out[key] = Math.min(max, Math.max(min, Math.round(value)));
    };
    range('maxActive', 1, 10);
    range('sendIntervalSec', 2, 600);
    range('requestTimeoutMin', 1, 1440);

    return { settings: out, errors };
  }

  saveSettings(input) {
    if (!input || typeof input !== 'object') throw new UserError('Nothing to save.');
    const before = this.settings;
    const { settings, errors } = this.#validate(input, before);
    if (Object.keys(errors).length) throw new UserError('Some settings need another look.', errors);

    this.settings = settings;
    try {
      writeJson(this.settingsPath, settings);
    } catch (err) {
      this.settings = before;
      throw new UserError(`The settings could not be saved: ${describeFsError(err)}`);
    }
    this.#emit('settings', { settings: this.#publicSettings(), configured: this.configured });

    const reconnect = CONNECTION_FIELDS.some((key) => before[key] !== settings[key]);
    if (this.client || this.status === 'retrying') {
      if (!this.configured) this.disconnect();
      else if (reconnect) {
        this.attempt = 0;
        this.#open();
      } else if (lower(before.channel) !== lower(settings.channel) || before.channelKey !== settings.channelKey) {
        if (this.client?.ready) {
          if (lower(before.channel) !== lower(settings.channel)) this.client.part(before.channel);
          this.rejoins = 0;
          this.client.join(settings.channel, settings.channelKey);
        }
      }
    }
    this.#connChanged();
    return this.#publicSettings();
  }

  // ----------------------------------------------------------- connection

  connect() {
    if (!this.configured) throw new UserError('Fill in the server, nickname and channel first.');
    this.wantOnline = true;
    this.attempt = 0;
    this.#save();
    this.#open();
  }

  disconnect() {
    this.wantOnline = false;
    clearTimeout(this.retryTimer);
    this.retryAt = null;
    this.#save();
    if (this.client) {
      this.client.quit('Leaving');
    } else {
      this.status = 'offline';
      this.#connChanged();
    }
  }

  #open() {
    clearTimeout(this.retryTimer);
    this.retryAt = null;
    if (this.client) {
      const old = this.client;
      this.client = null;
      old.removeAllListeners();
      old.on('error', () => {});
      old.quit('Reconnecting');
    }

    const s = this.settings;
    const client = new IrcClient({
      host: s.host,
      port: s.port,
      tls: s.tls,
      tlsVerify: s.tlsVerify,
      nick: s.nick,
      username: s.nick.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toLowerCase() || 'shelfmark',
      realname: s.nick,
      serverPassword: s.serverPassword,
      accountPassword: s.accountPassword,
      version: this.version,
    });
    this.client = client;
    this.status = 'connecting';
    this.lastError = '';
    this.onlineSince = null;
    this.rejoins = 0;
    this.#log('status', `Connecting to ${s.host} on port ${s.port}${s.tls ? ' (secure)' : ''}.`);
    this.#connChanged();

    const mine = (fn) => (...args) => {
      if (this.client === client) fn(...args);
    };

    client.on('connected', mine(() => {
      this.status = 'signing-in';
      this.#connChanged();
    }));
    client.on('registered', mine(() => {
      this.#log('status', `Signed in as ${client.nick}.`);
      this.#connChanged();
    }));
    client.on('ready', mine(() => {
      this.status = 'online';
      this.onlineSince = Date.now();
      client.join(this.settings.channel, this.settings.channelKey);
      this.#connChanged();
    }));
    client.on('joined', mine((entry) => {
      this.#log('status', `Joined ${entry.name}.`);
      this.#connChanged();
    }));
    client.on('members', mine((entry, change = {}) => {
      if (lower(entry.name) !== lower(this.settings.channel)) return;
      this.#connChanged();
      if (change.complete || change.joined) this.#pump();
    }));
    client.on('topic', mine((entry) => {
      if (entry.topic) this.#log('server', `Topic of ${entry.name}: ${entry.topic}`);
      this.#connChanged();
    }));
    client.on('left', mine((entry, info) => {
      if (info.kicked) {
        this.#log('problem', `You were removed from ${entry.name} by ${info.by}${info.reason ? `: ${info.reason}` : '.'}`);
        if (this.rejoins < 2 && lower(entry.name) === lower(this.settings.channel)) {
          this.rejoins += 1;
          setTimeout(mine(() => client.join(this.settings.channel, this.settings.channelKey)), 20_000).unref();
        }
      } else {
        this.#log('status', `Left ${entry.name}.`);
      }
      this.#connChanged();
    }));
    client.on('join-failed', mine((entry) => {
      this.#log('problem', `Could not join ${entry.name}. ${entry.error}`);
      this.#connChanged();
    }));
    client.on('nick', mine((nick) => {
      this.#log('status', `You are now known as ${nick}.`);
      this.#connChanged();
    }));
    client.on('info', mine((text) => this.#log('status', text)));
    client.on('problem', mine((text) => this.#log('problem', text)));
    client.on('message', mine((m) => {
      if (m.toChannel) {
        this.#log('channel', m.kind === 'action' ? `* ${m.from} ${m.text}` : m.text, { from: m.kind === 'action' ? '' : m.from, channel: true });
      } else if (m.fromServer) {
        this.#log('server', m.text);
      } else {
        this.#log('in', m.kind === 'action' ? `* ${m.from} ${m.text}` : m.text, { from: m.from });
      }
    }));
    client.on('dcc', mine((d) => this.#onDcc(d.from, d.text)));
    client.on('close', mine((reason) => this.#onClose(client, reason)));

    client.connect();
  }

  #onClose(client, reason) {
    this.client = null;
    const lasted = this.onlineSince ? Date.now() - this.onlineSince : 0;
    this.onlineSince = null;
    if (lasted > 120_000) this.attempt = 0;

    if (!this.wantOnline) {
      this.status = 'offline';
      this.lastError = '';
      this.#log('status', 'Disconnected.');
    } else if (client.fatal) {
      this.status = 'offline';
      this.wantOnline = false;
      this.lastError = reason;
      this.#log('problem', `${reason} Not trying again on its own.`);
      this.#save();
    } else {
      const delay = RETRY_DELAYS_S[Math.min(this.attempt, RETRY_DELAYS_S.length - 1)];
      this.attempt += 1;
      this.status = 'retrying';
      this.lastError = reason;
      this.retryAt = Date.now() + delay * 1000;
      this.#log('problem', `${reason} Trying again in ${delay} seconds.`);
      this.retryTimer = setTimeout(() => this.#open(), delay * 1000);
    }
    this.#connChanged();
  }

  /** Try the channel again after a failed join or a kick. */
  rejoin() {
    if (!this.client?.ready) throw new UserError('Not connected.');
    this.rejoins = 0;
    this.client.join(this.settings.channel, this.settings.channelKey);
  }

  /** A line typed into the message box: plain text goes to the channel, "/..." is a command. */
  say(input) {
    const text = cleanOutgoing(String(input ?? '')).trim();
    if (!text) throw new UserError('Type a message first.');
    const c = this.client;
    if (!c?.ready) throw new UserError('Not connected, so the message was not sent.');
    const channel = this.settings.channel;

    const sendTo = (target, body, how = 'say') => {
      if (!body) throw new UserError('Type a message first.');
      if (!c.fits(target, body)) throw new UserError('That message is too long for IRC.');
      c[how](target, body);
      const toChannel = c.isChannel(target);
      this.#log('out', toChannel ? body : `→ ${target}: ${body}`, { from: c.nick, channel: false });
    };

    if (text[0] !== '/' || text.startsWith('//')) {
      if (!c.channels.get(lower(channel))?.joined) throw new UserError(`You are not in ${channel}, so the message was not sent.`);
      return sendTo(channel, text.startsWith('//') ? text.slice(1) : text);
    }

    const sp = text.indexOf(' ');
    const cmd = (sp < 0 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
    const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
    const [first = '', ...others] = rest.split(' ');
    const tail = others.join(' ').trim();

    switch (cmd) {
      case 'msg': case 'query':
        if (!first) throw new UserError('Use /msg nickname message.');
        return sendTo(first, tail);
      case 'notice':
        if (!first) throw new UserError('Use /notice nickname message.');
        return sendTo(first, tail, 'notice');
      case 'me':
        if (!rest) throw new UserError('Use /me followed by what you do.');
        c.ctcp(channel, `ACTION ${rest}`);
        return this.#log('out', `* ${c.nick} ${rest}`);
      case 'join':
        this.rejoins = 0;
        c.join(first || channel, first ? tail : this.settings.channelKey);
        return undefined;
      case 'part':
        c.part(first || channel);
        return undefined;
      case 'nick':
        if (!NICK_RE.test(first)) throw new UserError('That is not a valid nickname.');
        c.send(`NICK ${first}`);
        return undefined;
      case 'raw': case 'quote':
        if (!rest) throw new UserError('Use /raw followed by the line to send.');
        if (!c.send(rest)) throw new UserError('That line is too long for IRC.');
        return this.#log('out', `→ server: ${rest}`);
      default:
        throw new UserError(`"/${cmd}" is not a command here. There is /msg, /notice, /me, /join, /part, /nick and /raw.`);
    }
  }

  // ------------------------------------------------------------- requests

  #newItem(fields) {
    const item = {
      id: String(++this.seq),
      command: '',
      name: '',
      bot: '',
      requested: false,
      status: 'queued',
      error: '',
      note: '',
      size: 0,
      received: 0,
      file: '',
      force: false,
      createdAt: Date.now(),
      queuedAt: Date.now(),
      sentAt: null,
      startedAt: null,
      finishedAt: null,
      ...fields,
    };
    this.items.set(item.id, item);
    this.#trim();
    return item;
  }

  /** Keep the list from growing forever: the oldest finished entries go first. */
  #trim() {
    if (this.items.size <= MAX_ITEMS) return;
    for (const item of this.items.values()) {
      if (this.items.size <= MAX_ITEMS) break;
      if (FINISHED.has(item.status)) this.#drop(item);
    }
  }

  #drop(item) {
    this.items.delete(item.id);
    this.live.delete(item.id);
    this.#emit('remove', { id: item.id });
    this.#save();
  }

  /** Queue commands from the list. Returns the queue entries, including ones already there. */
  request(commands) {
    if (!Array.isArray(commands) || !commands.length) throw new UserError('Nothing to request.');
    if (commands.length > MAX_QUEUED) throw new UserError(`That is more than ${MAX_QUEUED} files at once. Request them in smaller batches.`);
    if (!this.configured) throw new UserError('Set up the IRC connection first.');

    const parsed = [];
    for (const raw of commands) {
      const command = typeof raw === 'string' ? cleanOutgoing(raw).trim() : '';
      const info = parseRequestCommand(command);
      if (!info || Buffer.byteLength(command) > 400) throw new UserError('That does not look like a command from the list.');
      parsed.push({ command, ...info });
    }

    const open = new Map();
    let queued = 0;
    for (const item of this.items.values()) {
      if (item.requested && !FINISHED.has(item.status) && item.status !== 'noreply') open.set(item.command, item);
      if (item.status === 'queued') queued += 1;
    }
    if (queued + parsed.length > MAX_QUEUED) throw new UserError(`The queue is full (${MAX_QUEUED} waiting). Let some finish first.`);

    const out = [];
    const now = Date.now();
    for (const p of parsed) {
      const existing = open.get(p.command);
      if (existing) {
        out.push({ ...this.#publicItem(existing), already: true });
        continue;
      }
      // Asking again for something that finished or went unanswered replaces the old entry.
      for (const old of [...this.items.values()]) {
        if (old.command === p.command && (FINISHED.has(old.status) || old.status === 'noreply')) this.#drop(old);
      }
      const item = this.#newItem({
        command: p.command,
        name: p.name ? sanitizeFilename(p.name) : '',
        bot: p.bot,
        requested: true,
        notBefore: now + SEND_GRACE_MS,
      });
      open.set(p.command, item);
      this.#touch(item);
      out.push(this.#publicItem(item));
    }
    this.#connChanged();
    return out;
  }

  /** Buttons on a queue entry. */
  act(id, action) {
    const item = this.items.get(String(id));
    if (!item) throw new UserError('That entry is no longer in the list.');
    const live = this.live.get(item.id);

    switch (action) {
      case 'cancel':
        if (BUSY.has(item.status)) {
          clearTimeout(live?.resume?.timer);
          const partPath = live?.partPath;
          const finish = () => {
            if (partPath) fs.rm(partPath, { force: true }, () => {});
          };
          if (live?.transfer) live.transfer.cancel(finish);
          else finish();
          this.live.delete(item.id);
          item.status = 'cancelled';
          item.finishedAt = Date.now();
          this.#log('status', `Cancelled ${item.name}.`);
          this.#touch(item);
          this.#pump();
        } else if (['queued', 'sent', 'noreply', 'offered'].includes(item.status)) {
          this.#drop(item);
          this.#connChanged();
          this.#pump();
        }
        return;

      case 'accept':
        if (item.status !== 'offered') throw new UserError('That offer is no longer open.');
        this.#accept(item);
        return;

      case 'force':
        if (item.status === 'queued') {
          item.force = true;
          this.#pump();
          this.#touch(item);
        }
        return;

      case 'retry': {
        if (!item.command) throw new UserError('This file was not requested with a command, so it cannot be asked for again.');
        if (!FINISHED.has(item.status) && item.status !== 'noreply') return;
        // Back to the end of the line.
        this.items.delete(item.id);
        this.items.set(item.id, item);
        Object.assign(item, {
          status: 'queued', error: '', note: '', received: 0, file: '',
          sentAt: null, startedAt: null, finishedAt: null, notBefore: Date.now(), queuedAt: Date.now(),
        });
        this.#touch(item);
        this.#pump();
        return;
      }

      case 'remove':
        if (!FINISHED.has(item.status)) throw new UserError('Cancel it first.');
        this.#removeFinished(item);
        return;

      default:
        throw new UserError('Unknown action.');
    }
  }

  #removeFinished(item) {
    if (item.status === 'failed' && item.name) this.#deletePart(item.name);
    this.#drop(item);
  }

  /** Remove a leftover partial file, unless a transfer is writing to it. */
  #deletePart(name) {
    const partPath = path.join(this.downloadDir, `${name}.part`);
    for (const live of this.live.values()) if (live.partPath === partPath) return;
    fs.rm(partPath, { force: true }, () => {});
  }

  clearFinished() {
    for (const item of [...this.items.values()]) {
      if (FINISHED.has(item.status)) this.#removeFinished(item);
    }
  }

  /** Send the next waiting command to the channel, if it is its turn. */
  #pump() {
    const c = this.client;
    const s = this.settings;
    if (!c || this.status !== 'online') return;
    const entry = c.channels.get(lower(s.channel));
    if (!entry?.joined) return;

    const now = Date.now();
    let active = 0;
    for (const item of this.items.values()) {
      if (item.requested && (item.status === 'sent' || BUSY.has(item.status))) active += 1;
    }
    if (active >= s.maxActive) return;
    if (now - this.lastSentAt < s.sendIntervalSec * 1000) return;

    for (const item of this.items.values()) {
      if (item.status !== 'queued') continue;
      if ((item.notBefore || 0) > now) continue;
      // The bot is not in the channel: hold the request instead of talking to nobody.
      if (s.holdForBot && !item.force && c.isPresent(entry.name, item.bot) === false) continue;
      if (!c.fits(entry.name, item.command)) {
        this.#fail(item, 'The command is too long to send.');
        continue;
      }
      c.say(entry.name, item.command);
      item.status = 'sent';
      item.sentAt = now;
      this.lastSentAt = now;
      this.#log('out', item.command, { from: c.nick });
      this.#touch(item);
      this.#connChanged();
      return;
    }
  }

  #tick() {
    this.ticks += 1;
    const now = Date.now();
    const timeout = this.settings.requestTimeoutMin * 60_000;

    for (const item of this.items.values()) {
      if (item.status === 'sent' && now - item.sentAt > timeout) {
        item.status = 'noreply';
        this.#touch(item);
      } else if (item.status === 'offered' && now > item.expiresAt) {
        this.#log('status', `The offer of ${item.name} from ${item.bot} ran out.`);
        this.#drop(item);
      } else if (item.status === 'downloading') {
        const live = this.live.get(item.id);
        if (!live?.transfer) continue;
        const bytes = live.transfer.received;
        const seconds = Math.max(0.25, (now - live.lastAt) / 1000);
        const speed = (bytes - live.lastBytes) / seconds;
        live.rate = live.rate ? live.rate * 0.7 + speed * 0.3 : speed;
        live.lastBytes = bytes;
        live.lastAt = now;
        item.received = bytes;
        this.#touch(item, { save: false });
      }
    }
    this.#pump();
    if (this.ticks % 30 === 0) this.#refreshFolder();
  }

  // ------------------------------------------------------------------ DCC

  #onDcc(from, text) {
    const dcc = parseDcc(text);
    if (!dcc) {
      this.#log('status', `${from} sent a DCC request this app does not handle (${text.split(' ')[0]}).`);
      return;
    }
    if (dcc.type === 'send') this.#onOffer(from, dcc);
    else if (dcc.type === 'accept') this.#onResumeAccepted(from, dcc);
  }

  #onOffer(from, offer) {
    const name = sanitizeFilename(offer.filename);
    const fromKey = lower(from);
    const now = Date.now();

    // Is this the answer to something that was requested?
    let item = null;
    let knownBot = false;
    for (const it of this.items.values()) {
      if (!it.requested || lower(it.bot) !== fromKey) continue;
      if (it.status === 'sent' || it.status === 'noreply') {
        knownBot = true;
        if (!item && (namesMatch(name, it.name) || !it.name)) item = it;
      } else if (BUSY.has(it.status)) {
        knownBot = true;
      } else if (it.status === 'failed' && now - it.finishedAt < RETRY_OFFER_MS && namesMatch(name, it.name)) {
        // Senders often try again by themselves after a broken transfer.
        knownBot = true;
        if (!item) item = it;
      }
    }
    const trusted = knownBot || this.settings.trustedNicks.some((n) => lower(n) === fromKey);

    if (!item) {
      let pending = 0;
      for (const it of this.items.values()) {
        if (lower(it.bot) === fromKey && it.name === name && (BUSY.has(it.status) || it.status === 'offered')) {
          this.#log('status', `${from} offered ${name} again while it is already in the list. Ignored.`);
          return;
        }
        if (it.status === 'offered') pending += 1;
      }
      if (!trusted && pending >= MAX_PENDING_OFFERS) return;
      item = this.#newItem({ name, bot: from, requested: false });
    }

    item.name = name;
    item.size = offer.size;
    item.received = 0;
    item.error = '';
    item.note = '';
    this.live.set(item.id, { offer, transfer: null, partPath: null, resume: null, rate: 0, lastBytes: 0, lastAt: Date.now() });
    this.#log('in', `Offers ${name} (${formatBytes(offer.size)}).`, { from });

    if (trusted) {
      this.#accept(item);
    } else {
      item.status = 'offered';
      item.expiresAt = Date.now() + OFFER_TTL_MS;
      this.#touch(item);
    }
  }

  /** Check an offer and start receiving it. */
  #accept(item) {
    const live = this.live.get(item.id);
    if (!live?.offer) return this.#fail(item, 'The offer is no longer open.');
    const { offer } = live;
    const s = this.settings;
    const reverse = offer.port === 0;

    if (reverse) {
      if (!offer.token) return this.#fail(item, `${item.bot} sent an offer this app cannot read.`);
      if (!this.dccPorts) {
        return this.#fail(item, `${item.bot} cannot accept connections and wants this app to accept one instead. That needs DCC_PORTS to be set and forwarded (see the deployment guide).`);
      }
      if (offer.secure) return this.#fail(item, 'Secure transfers in this direction are not supported.');
    } else {
      if (offer.port < 1024) return this.#fail(item, `${item.bot} offered the file on port ${offer.port}, which is not allowed.`);
      if (!s.allowPrivate && isPrivateAddress(offer.host)) {
        return this.#fail(item, `${item.bot} offered the file from ${offer.host}, an address inside a private network that cannot be reached from here.`);
      }
    }

    const folder = this.#refreshFolder();
    if (!folder.ok) return this.#fail(item, `The download folder cannot be used: ${folder.error}`);

    const finalPath = path.join(this.downloadDir, item.name);
    const partPath = `${finalPath}.part`;
    for (const [id, other] of this.live) {
      if (id !== item.id && other.partPath === partPath) return this.#fail(item, 'This file is already being downloaded.');
    }

    const sizeOf = (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return -1;
      }
    };
    if (item.size > 0 && sizeOf(finalPath) === item.size) {
      this.live.delete(item.id);
      Object.assign(item, { status: 'done', note: 'already', file: item.name, received: item.size, finishedAt: Date.now() });
      this.#log('status', `${item.name} is already in the download folder. Not downloading it again.`);
      this.#touch(item);
      this.#pump();
      return undefined;
    }

    const existing = Math.max(0, sizeOf(partPath));
    if (item.size > 0 && folder.freeBytes !== null && item.size - existing > folder.freeBytes - SPACE_RESERVE) {
      return this.#fail(item, `Not enough free space in the download folder: the file is ${formatBytes(item.size)} and ${formatBytes(folder.freeBytes)} is free.`);
    }

    live.partPath = partPath;
    item.status = 'connecting';
    item.startedAt = Date.now();
    delete item.expiresAt;

    if (item.size > 0 && existing === item.size) {
      // The whole file arrived earlier but was never moved into place.
      live.transfer = { received: existing };
      this.#finish(item);
      return undefined;
    }
    if (item.size > 0 && existing > 0 && existing < item.size && this.client) {
      item.received = existing;
      live.resume = {
        position: existing,
        timer: setTimeout(() => {
          live.resume = null;
          this.#log('status', `${item.bot} did not agree to continue ${item.name} where it stopped. Starting over.`);
          this.#begin(item, 0);
        }, this.resumeTimeoutMs),
      };
      this.client.ctcp(item.bot, `DCC RESUME ${quoteName(offer.filename)} ${offer.port} ${existing}${reverse ? ` ${offer.token}` : ''}`);
      this.#touch(item);
      return undefined;
    }
    this.#begin(item, 0);
    return undefined;
  }

  #onResumeAccepted(from, accept) {
    for (const [id, live] of this.live) {
      const item = this.items.get(id);
      if (!item || !live.resume || lower(item.bot) !== lower(from)) continue;
      if (live.offer.port !== accept.port) continue;
      if (live.offer.port === 0 && live.offer.token !== accept.token) continue;

      clearTimeout(live.resume.timer);
      const have = live.resume.position;
      live.resume = null;
      if (accept.position > have) return this.#fail(item, `${from} wants to continue from a point this app has not received yet.`);
      try {
        if (accept.position < have) fs.truncateSync(live.partPath, accept.position);
      } catch (err) {
        return this.#fail(item, `Could not prepare the partial file: ${describeFsError(err)}`);
      }
      this.#log('status', `Continuing ${item.name} from ${formatBytes(accept.position)}.`);
      return this.#begin(item, accept.position);
    }
    return undefined;
  }

  #begin(item, offset) {
    const live = this.live.get(item.id);
    if (!live || item.status !== 'connecting') return;
    const { offer } = live;
    const transfer = new DccReceive({
      partPath: live.partPath, size: item.size, offset, host: offer.host, port: offer.port, secure: offer.secure,
    });
    live.transfer = transfer;
    live.lastBytes = offset;
    live.lastAt = Date.now();
    live.rate = 0;
    item.received = offset;

    const current = (fn) => (...args) => {
      if (this.live.get(item.id)?.transfer === transfer) fn(...args);
    };
    transfer.on('start', current(() => {
      item.status = 'downloading';
      live.lastAt = Date.now();
      this.#touch(item);
    }));
    transfer.on('done', current(() => this.#finish(item)));
    transfer.on('failed', current((message) => this.#fail(item, message)));

    if (offer.port === 0) this.#listenFor(item, live, transfer).catch((err) => this.#fail(item, err.message));
    else transfer.start();
    this.#touch(item);
  }

  /** Reverse DCC: open a port, tell the sender where to connect. */
  async #listenFor(item, live, transfer) {
    const address = await this.#publicAddress();
    if (!address) throw new Error('This machine\'s public address is not known. Set DCC_PUBLIC_IP (see the deployment guide).');
    const { server, port } = await listenInRange(this.dccPorts.min, this.dccPorts.max);
    if (this.live.get(item.id)?.transfer !== transfer || transfer.finished || !this.client) {
      server.close();
      return;
    }
    transfer.startListening(server, LISTEN_TIMEOUT_MS);
    const { offer } = live;
    this.client.ctcp(item.bot, `DCC SEND ${quoteName(offer.filename)} ${formatDccAddress(address)} ${port} ${item.size} ${offer.token}`);
  }

  async #publicAddress() {
    if (this.dccPublicIp) return this.dccPublicIp;
    const host = this.client?.hostmask;
    if (!host) return null;
    if (net.isIP(host)) return isPrivateAddress(host) ? null : host;
    try {
      const { address } = await dns.lookup(host, { family: 4 });
      return isPrivateAddress(address) ? null : address;
    } catch {
      return null;
    }
  }

  #finish(item) {
    const live = this.live.get(item.id);
    let finalName = item.name;
    try {
      finalName = freeName(this.downloadDir, item.name);
      fs.renameSync(live.partPath, path.join(this.downloadDir, finalName));
    } catch (err) {
      return this.#fail(item, `The file arrived but could not be moved into place: ${describeFsError(err)}`);
    }
    const received = live.transfer?.received ?? item.size;
    this.live.delete(item.id);
    Object.assign(item, {
      status: 'done', file: finalName, received: item.size || received, size: item.size || received, finishedAt: Date.now(),
    });
    this.#log('status', `Downloaded ${finalName} (${formatBytes(item.size)}).`);
    this.#touch(item);
    this.#refreshFolder();
    this.#connChanged();
    this.#pump();
    return undefined;
  }

  #fail(item, message) {
    const live = this.live.get(item.id);
    if (live) {
      clearTimeout(live.resume?.timer);
      if (live.transfer?.received !== undefined) item.received = live.transfer.received;
      live.transfer?.cancel?.();
      this.live.delete(item.id);
    }
    item.status = 'failed';
    item.error = message;
    item.finishedAt = Date.now();
    delete item.expiresAt;
    this.#log('problem', `${item.name || item.command}: ${message}`);
    this.#touch(item);
    this.#connChanged();
    this.#pump();
    return undefined;
  }
}
