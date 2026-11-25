// One connection to an IRC server, from connect to close.
// Reconnecting is the manager's job: a closed client is thrown away.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { cleanOutgoing, decodeLine, lower, parseCtcp, parseLine, stripFormatting } from './protocol.js';

const CONNECT_TIMEOUT_MS = 30_000;
const REGISTER_TIMEOUT_MS = 60_000;
const PING_AFTER_MS = 90_000;      // quiet for this long: ask the server if it is still there
const DEAD_AFTER_MS = 240_000;     // quiet for this long: give up on the connection
const MAX_LINE_BYTES = 480;        // 512 minus room for the prefix the server adds

// Outgoing lines are spaced out so the server does not drop us for flooding.
const BURST = 5;
const REFILL_MS = 1600;

const JOIN_ERRORS = {
  403: 'That channel does not exist.',
  405: 'You have joined too many channels.',
  471: 'The channel is full.',
  473: 'The channel is invite-only.',
  474: 'You are banned from the channel.',
  475: 'The channel needs a key (password), or the key is wrong.',
  477: 'The channel only lets in registered nicknames.',
  489: 'The channel only allows secure (TLS) connections.',
};

export class IrcClient extends EventEmitter {
  /**
   * @param {object} o host, port, tls, tlsVerify, nick, username, realname,
   *                   serverPassword, accountPassword, version
   */
  constructor(o) {
    super();
    this.options = o;
    this.nick = o.nick;
    this.registered = false;
    this.ready = false;
    this.closed = false;
    this.network = '';
    this.hostmask = '';
    this.channels = new Map(); // lower-case name -> { name, joined, members:Set, namesKnown, error, topic }
    this.closeReason = '';
    this.fatal = false; // true when retrying would be pointless (banned)

    this.socket = null;
    this.buffer = null;
    this.queue = [];
    this.tokens = BURST;
    this.lastRefill = Date.now();
    this.sendTimer = null;
    this.lastData = Date.now();
    this.timers = new Set();
    this.nickTries = 0;
    this.caps = [];
    this.sasl = { wanted: Boolean(o.accountPassword), done: false, ok: false };
    this.lastCtcpReply = 0;
    this.prefixChars = '~&@%+';
  }

  // ------------------------------------------------------------ lifecycle

  connect() {
    const { host, port } = this.options;
    const socket = this.options.tls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.options.tlsVerify !== false })
      : net.connect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);

    const connectTimer = this.#after(CONNECT_TIMEOUT_MS, () => this.#close('The server did not answer.'));
    socket.once(this.options.tls ? 'secureConnect' : 'connect', () => {
      this.#cancel(connectTimer);
      this.#register();
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => {
      if (!this.closeReason) this.closeReason = describeSocketError(err, this.options);
    });
    socket.on('close', () => this.#close(this.closeReason || 'The connection was closed.'));
  }

  /** Say goodbye and close. */
  quit(message = 'Leaving') {
    if (this.closed) return;
    this.closeReason = 'Disconnected.';
    if (this.socket?.writable) {
      this.#raw(`QUIT :${cleanOutgoing(message)}`);
      this.socket.end();
      this.#after(1500, () => this.#close('Disconnected.'));
    } else {
      this.#close('Disconnected.');
    }
  }

  #close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (!this.closeReason) this.closeReason = reason;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.sendTimer);
    clearInterval(this.keepalive);
    this.socket?.destroy();
    this.emit('close', this.closeReason);
  }

  #after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  #cancel(t) {
    clearTimeout(t);
    this.timers.delete(t);
  }

  // -------------------------------------------------------------- sending

  #raw(line) {
    if (this.closed || !this.socket?.writable) return;
    this.socket.write(`${line}\r\n`);
  }

  /** Queue a line; lines go out in order, spaced to respect flood limits. */
  send(line) {
    if (this.closed) return false;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return false;
    this.queue.push(line);
    this.#drain();
    return true;
  }

  #drain() {
    if (this.sendTimer || this.closed) return;
    const now = Date.now();
    this.tokens = Math.min(BURST, this.tokens + (now - this.lastRefill) / REFILL_MS);
    this.lastRefill = now;
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.#raw(this.queue.shift());
    }
    if (this.queue.length) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = null;
        this.#drain();
      }, Math.ceil((1 - this.tokens) * REFILL_MS) + 5);
    }
  }

  /** Would this text fit in one message to this target? */
  fits(target, text) {
    return Buffer.byteLength(`PRIVMSG ${target} :${text}`) <= MAX_LINE_BYTES;
  }

  say(target, text) {
    return this.send(`PRIVMSG ${cleanOutgoing(target)} :${cleanOutgoing(text)}`);
  }

  notice(target, text) {
    return this.send(`NOTICE ${cleanOutgoing(target)} :${cleanOutgoing(text)}`);
  }

  ctcp(target, text) {
    return this.send(`PRIVMSG ${cleanOutgoing(target)} :\x01${cleanOutgoing(text)}\x01`);
  }

  join(channel, key) {
    const name = cleanOutgoing(channel).replace(/[ ,]/g, '');
    const entry = this.#channel(name);
    entry.error = '';
    return this.send(key ? `JOIN ${name} ${cleanOutgoing(key).replace(/ /g, '')}` : `JOIN ${name}`);
  }

  part(channel) {
    return this.send(`PART ${cleanOutgoing(channel).replace(/[ ,]/g, '')}`);
  }

  // --------------------------------------------------------- registration

  #register() {
    const o = this.options;
    this.lastData = Date.now();
    this.keepalive = setInterval(() => this.#checkAlive(), 30_000);
    this.registerTimer = this.#after(REGISTER_TIMEOUT_MS, () => this.#close('The server did not finish signing in.'));
    this.emit('connected');
    if (o.serverPassword) this.#raw(`PASS ${cleanOutgoing(o.serverPassword)}`);
    this.#raw('CAP LS 302');
    this.#raw(`NICK ${o.nick}`);
    this.#raw(`USER ${o.username || o.nick} 0 * :${cleanOutgoing(o.realname || o.nick)}`);
  }

  #checkAlive() {
    const quiet = Date.now() - this.lastData;
    if (quiet > DEAD_AFTER_MS) this.#close('The connection went silent.');
    else if (quiet > PING_AFTER_MS) this.#raw('PING :shelfmark');
  }

  #nextNick() {
    this.nickTries += 1;
    const base = this.options.nick.slice(0, 24);
    if (this.nickTries <= 2) return base + '_'.repeat(this.nickTries);
    return `${base.slice(0, 20)}${Math.floor(100 + Math.random() * 900)}`;
  }

  // ------------------------------------------------------------- receiving

  #onData(chunk) {
    this.lastData = Date.now();
    let buf = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.buffer = null;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && buf[end - 1] === 13) end -= 1;
      if (end > start) this.#onLine(decodeLine(buf.subarray(start, end)));
      start = nl + 1;
      if (this.closed) return;
    }
    if (start < buf.length) {
      buf = buf.subarray(start);
      // A server that sends endless data without a line break is not speaking IRC.
      if (buf.length > 16_384) return this.#close('The server sent something that is not IRC.');
      this.buffer = Buffer.from(buf);
    }
  }

  #channel(name) {
    const key = lower(name);
    let entry = this.channels.get(key);
    if (!entry) {
      entry = { name, joined: false, members: new Set(), namesKnown: false, error: '', topic: '' };
      this.channels.set(key, entry);
    }
    return entry;
  }

  isChannel(target) {
    return /^[#&!+]/.test(target);
  }

  /** Is this nick in the channel right now? Null when the member list is not known yet. */
  isPresent(channel, nick) {
    const entry = this.channels.get(lower(channel));
    if (!entry || !entry.joined || !entry.namesKnown) return null;
    return entry.members.has(lower(nick));
  }

  #onLine(line) {
    const msg = parseLine(line);
    if (!msg) return;
    const p = msg.params;
    const isMe = (nick) => lower(nick) === lower(this.nick);

    switch (msg.command) {
      case 'PING':
        this.#raw(`PONG :${p[p.length - 1] ?? ''}`);
        return;
      case 'PONG':
        return;
      case 'ERROR': {
        const text = stripFormatting(p.join(' '));
        if (!this.closeReason) this.closeReason = `The server closed the connection: ${text}`;
        if (/\b[KGZ]-?lined?\b|banned/i.test(text)) this.fatal = true;
        return;
      }

      case 'CAP':
        this.#onCap(p);
        return;
      case 'AUTHENTICATE':
        if (p[0] === '+') {
          const o = this.options;
          const account = o.accountName || o.nick;
          this.#raw(`AUTHENTICATE ${Buffer.from(`${account}\0${account}\0${o.accountPassword}`).toString('base64')}`);
        }
        return;
      case '900':
        return;
      case '903':
        this.sasl.ok = true;
        this.sasl.done = true;
        this.emit('info', 'Signed in to your account.');
        this.#raw('CAP END');
        return;
      case '902': case '904': case '905': case '906': case '908':
        if (!this.sasl.done) {
          this.sasl.done = true;
          this.#raw('CAP END');
        }
        return;

      case '001':
        this.registered = true;
        this.nick = p[0] || this.nick;
        this.#cancel(this.registerTimer);
        this.emit('registered');
        // Some servers send no MOTD end; do not wait for it forever.
        this.readyTimer = this.#after(8000, () => this.#becomeReady());
        return;
      case '005':
        for (const token of p.slice(1, -1)) {
          const [key, value = ''] = token.split('=');
          if (key === 'NETWORK') this.network = value;
          if (key === 'PREFIX') {
            const m = /^\(.*\)(.*)$/.exec(value);
            if (m && m[1]) this.prefixChars = m[1];
          }
        }
        return;
      case '376': case '422':
        this.#becomeReady();
        return;

      case '432':
        if (!this.registered) return this.#close(`The server does not accept the nickname "${this.options.nick}".`);
        this.emit('problem', `The server does not accept that nickname.`);
        return;
      case '433': case '436': case '437':
        if (!this.registered) {
          const next = this.#nextNick();
          this.emit('info', `The nickname ${p[1] || this.options.nick} is taken. Trying ${next}.`);
          this.#raw(`NICK ${next}`);
        } else {
          this.emit('problem', `The nickname ${p[1] || ''} is already in use.`);
        }
        return;
      case '464':
        this.emit('problem', 'The server password is wrong.');
        return;
      case '465':
        this.fatal = true;
        this.closeReason = `You are banned from this server. ${stripFormatting(p[p.length - 1] || '')}`.trim();
        return;

      case 'NICK': {
        const next = p[0];
        if (isMe(msg.nick)) {
          this.nick = next;
          this.emit('nick', next);
        }
        for (const entry of this.channels.values()) {
          if (entry.members.delete(lower(msg.nick))) {
            entry.members.add(lower(next));
            this.emit('members', entry);
          }
        }
        return;
      }
      case 'JOIN': {
        const entry = this.#channel(p[0]);
        if (isMe(msg.nick)) {
          entry.name = p[0];
          entry.joined = true;
          entry.namesKnown = false;
          entry.error = '';
          entry.members = new Set([lower(this.nick)]);
          if (msg.host) this.hostmask = msg.host;
          this.emit('joined', entry);
        } else {
          entry.members.add(lower(msg.nick));
          this.emit('members', entry, { joined: msg.nick });
        }
        return;
      }
      case 'PART': case 'KICK': {
        const entry = this.channels.get(lower(p[0]));
        if (!entry) return;
        const who = msg.command === 'KICK' ? p[1] : msg.nick;
        if (isMe(who)) {
          entry.joined = false;
          entry.namesKnown = false;
          entry.members.clear();
          const reason = stripFormatting(p[msg.command === 'KICK' ? 2 : 1] || '');
          if (msg.command === 'KICK') {
            entry.error = `You were removed from the channel by ${msg.nick}${reason ? `: ${reason}` : '.'}`;
          }
          this.emit('left', entry, { kicked: msg.command === 'KICK', by: msg.nick, reason });
        } else if (entry.members.delete(lower(who))) {
          this.emit('members', entry, { left: who });
        }
        return;
      }
      case 'QUIT':
        for (const entry of this.channels.values()) {
          if (entry.members.delete(lower(msg.nick))) this.emit('members', entry, { left: msg.nick });
        }
        return;

      case '353': {
        const entry = this.channels.get(lower(p[2] || ''));
        if (!entry) return;
        if (entry.namesKnown) {
          // A fresh list replaces the old one.
          entry.members = new Set([lower(this.nick)]);
          entry.namesKnown = false;
        }
        for (let name of (p[3] || '').split(' ')) {
          while (name && this.prefixChars.includes(name[0])) name = name.slice(1);
          const bang = name.indexOf('!');
          if (bang > 0) name = name.slice(0, bang);
          if (name) entry.members.add(lower(name));
        }
        return;
      }
      case '366': {
        const entry = this.channels.get(lower(p[1] || ''));
        if (!entry) return;
        entry.namesKnown = true;
        this.emit('members', entry, { complete: true });
        return;
      }
      case '332': {
        const entry = this.channels.get(lower(p[1] || ''));
        if (entry) {
          entry.topic = stripFormatting(p[2] || '');
          this.emit('topic', entry);
        }
        return;
      }
      case 'TOPIC': {
        const entry = this.channels.get(lower(p[0] || ''));
        if (entry) {
          entry.topic = stripFormatting(p[1] || '');
          this.emit('topic', entry);
        }
        return;
      }
      case '470': {
        // Forwarded to another channel: the JOIN that follows names the new one.
        this.emit('info', `${p[1]} forwards to ${p[2]}.`);
        return;
      }
      case '403': case '405': case '471': case '473': case '474': case '475': case '477': case '489': {
        const entry = this.channels.get(lower(p[1] || ''));
        if (entry && !entry.joined) {
          entry.error = JOIN_ERRORS[msg.command];
          this.emit('join-failed', entry);
        } else {
          this.emit('problem', stripFormatting(p.slice(1).join(' ')));
        }
        return;
      }
      case '404':
        this.emit('problem', `Your message to ${p[1]} was not delivered: ${stripFormatting(p[2] || 'the channel refused it')}`);
        return;
      case '401':
        this.emit('problem', `There is nobody called ${p[1]} online.`);
        return;

      case 'PRIVMSG': case 'NOTICE':
        this.#onMessage(msg);
        return;

      default:
        // Other numbered replies: only errors are worth showing.
        if (/^[45]\d\d$/.test(msg.command) && this.registered) {
          this.emit('problem', stripFormatting(p.slice(1).join(' ')));
        }
    }
  }

  #onCap(p) {
    const sub = (p[1] || '').toUpperCase();
    if (sub === 'LS') {
      const more = p[2] === '*';
      this.caps.push(...(p[more ? 3 : 2] || '').split(' ').map((c) => c.split('=')[0]));
      if (more) return;
      if (this.sasl.wanted && this.caps.includes('sasl')) this.#raw('CAP REQ :sasl');
      else this.#raw('CAP END');
    } else if (sub === 'ACK') {
      if ((p[2] || '').split(' ').includes('sasl')) this.#raw('AUTHENTICATE PLAIN');
      else this.#raw('CAP END');
    } else if (sub === 'NAK') {
      this.sasl.done = true;
      this.#raw('CAP END');
    }
  }

  #becomeReady() {
    if (this.ready || this.closed) return;
    this.ready = true;
    this.#cancel(this.readyTimer);
    const o = this.options;
    if (o.accountPassword && !this.sasl.ok) {
      // No SASL on this server: identify to NickServ the old way, then give it a moment.
      this.#raw(`PRIVMSG NickServ :IDENTIFY ${cleanOutgoing(o.accountPassword)}`);
      this.#after(2500, () => this.emit('ready'));
    } else {
      this.emit('ready');
    }
  }

  #onMessage(msg) {
    const [target = '', raw = ''] = msg.params;
    const notice = msg.command === 'NOTICE';
    const fromServer = !msg.nick || msg.nick.includes('.');
    const ctcp = parseCtcp(raw);

    if (ctcp) {
      if (ctcp.command === 'ACTION') {
        this.emit('message', {
          kind: 'action', from: msg.nick, target, text: stripFormatting(ctcp.args), toChannel: this.isChannel(target),
        });
        return;
      }
      if (ctcp.command === 'DCC' && !notice && !this.isChannel(target)) {
        this.emit('dcc', { from: msg.nick, host: msg.host, text: ctcp.args });
        return;
      }
      if (notice) return; // a reply to something; nothing asks for these
      // Answer the few polite questions other clients and servers ask.
      const now = Date.now();
      if (now - this.lastCtcpReply < 2500) return;
      let reply = null;
      if (ctcp.command === 'VERSION') reply = `VERSION Shelfmark ${this.options.version || ''}`.trim();
      else if (ctcp.command === 'PING') reply = `PING ${ctcp.args.slice(0, 64)}`;
      else if (ctcp.command === 'TIME') reply = `TIME ${new Date().toUTCString()}`;
      if (reply) {
        this.lastCtcpReply = now;
        this.send(`NOTICE ${msg.nick} :\x01${cleanOutgoing(reply)}\x01`);
      }
      return;
    }

    // Before sign-in finishes the server talks to "*" or "AUTH"; skip that noise.
    if (!this.registered) return;
    this.emit('message', {
      kind: notice ? 'notice' : 'message',
      from: fromServer ? '' : msg.nick,
      target,
      text: stripFormatting(raw),
      toChannel: this.isChannel(target),
      fromServer,
    });
  }
}

function describeSocketError(err, { host, port }) {
  switch (err.code) {
    case 'ENOTFOUND': case 'EAI_AGAIN':
      return `The server address "${host}" could not be found.`;
    case 'ECONNREFUSED':
      return `${host} refused the connection on port ${port}.`;
    case 'ETIMEDOUT': case 'EHOSTUNREACH': case 'ENETUNREACH':
      return `${host} could not be reached.`;
    case 'ECONNRESET': case 'EPIPE':
      return 'The connection was lost.';
    case 'ERR_SSL_WRONG_VERSION_NUMBER': case 'EPROTO':
      return `Port ${port} does not speak TLS. Turn off the secure connection or use the TLS port (usually 6697).`;
    default:
      if (/certificate|CERT_|self.signed/i.test(`${err.code} ${err.message}`)) {
        return `The server's security certificate could not be verified (${err.message}).`;
      }
      return `Connection error: ${err.message}`;
  }
}
