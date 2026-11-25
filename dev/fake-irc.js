// A tiny IRC server with one file-serving bot in it, for tests and for trying
// the app without touching a real network:
//
//   node dev/fake-irc.js            (listens on 127.0.0.1:6667, sends slowly)
//
// Then in the app: server 127.0.0.1, port 6667, secure connection off, any
// nickname, channel #books, and tick "Allow senders on a private network".

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/** The bot's files are generated: byte N of every file is N modulo 251. */
export function fileBytes(start, length) {
  const buf = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) buf[i] = (start + i) % 251;
  return buf;
}

const LOOPBACK = '2130706433'; // 127.0.0.1 as DCC writes it

/**
 * @param {object} [o]
 * @param {number} [o.port]            0 picks a free one
 * @param {string} [o.bot]             the bot's nickname (and its command)
 * @param {boolean} [o.botPresent]     is the bot in the channel at the start
 * @param {(name:string)=>number} [o.sizeOf] size of the file with this name
 * @param {number} [o.chunkSize]
 * @param {number} [o.chunkDelayMs]    pause between chunks, to slow a transfer down
 * @param {number} [o.replyDelayMs]    how long the bot waits before offering
 * @param {boolean} [o.reverse]        offer with port 0 and connect to the client instead
 * @param {boolean} [o.resume]         honour DCC RESUME
 * @param {boolean} [o.underscores]    announce file names with _ instead of spaces
 * @param {boolean} [o.sasl]           advertise SASL
 * @param {string[]} [o.takenNicks]
 * @param {number|null} [o.joinError]  numeric to answer JOIN with
 */
export function startFakeIrc(o = {}) {
  const opt = {
    port: 0, bot: 'TrainFiles', botPresent: true, sizeOf: () => 300_000, chunkSize: 16_384, chunkDelayMs: 0,
    replyDelayMs: 20, reverse: false, resume: true, underscores: false, sasl: false, takenNicks: [], joinError: null,
    ...o,
  };
  const events = new EventEmitter();
  const clients = new Set();
  const lines = [];            // every line received, as text
  const sends = new Map();     // key -> pending send (waiting for the client)
  const sockets = new Set();
  let dropAfter = null;        // bytes after which the next transfer is cut off
  let botPresent = opt.botPresent;
  let tokenSeq = 100;

  const api = {
    events,
    lines,
    options: opt,
    host: '127.0.0.1',
    port: 0,
    /** Cut the next transfer off after this many bytes. */
    dropNextAfter(bytes) {
      dropAfter = bytes;
    },
    botJoin() {
      botPresent = true;
      for (const c of clients) for (const ch of c.channels) c.write(`:${opt.bot}!bot@files.example JOIN ${ch}`);
    },
    botQuit() {
      botPresent = false;
      for (const c of clients) c.write(`:${opt.bot}!bot@files.example QUIT :gone`);
    },
    /** Someone sends the first connected client a file it did not ask for. */
    offer(fromNick, name, size) {
      for (const c of clients) offerFile(c, fromNick, name, size);
    },
    say(fromNick, target, text) {
      for (const c of clients) c.write(`:${fromNick}!u@h.example PRIVMSG ${target === 'you' ? c.nick : target} :${text}`);
    },
    kick(channel, reason = 'bye') {
      for (const c of clients) c.write(`:op!o@h.example KICK ${channel} ${c.nick} :${reason}`);
    },
    dropClients() {
      for (const c of clients) c.socket.destroy();
    },
    close() {
      for (const s of sockets) s.destroy();
      for (const p of sends.values()) p.server?.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };

  /** Stream a generated file down an open socket, honouring the throttle and a planned cut-off. */
  function pump(socket, size, offset) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pos = offset;
    const cut = dropAfter;
    dropAfter = null;
    let acked = 0;
    socket.on('data', (d) => {
      if (d.length >= 4) acked = d.readUInt32BE(d.length - 4);
      if (acked === size % 0x1_0000_0000 && pos >= size) socket.end();
    });
    const step = () => {
      if (socket.destroyed) return;
      if (cut !== null && pos >= cut) return socket.destroy();
      if (pos >= size) return undefined;
      const n = Math.min(opt.chunkSize, size - pos, cut !== null ? cut - pos : Infinity);
      const ok = socket.write(fileBytes(pos, n));
      pos += n;
      events.emit('progress', pos);
      const next = () => (opt.chunkDelayMs ? setTimeout(step, opt.chunkDelayMs) : setImmediate(step));
      if (ok) next();
      else socket.once('drain', next);
      return undefined;
    };
    step();
  }

  function offerFile(client, fromNick, name, size) {
    const announced = opt.underscores ? name.replace(/ /g, '_') : name;
    const quoted = /\s/.test(announced) ? `"${announced}"` : announced;
    const from = `${fromNick}!bot@files.example`;

    if (opt.reverse) {
      const token = String(++tokenSeq);
      sends.set(`token:${token}`, { size, offset: 0, name: announced });
      client.write(`:${from} PRIVMSG ${client.nick} :\x01DCC SEND ${quoted} ${LOOPBACK} 0 ${size} ${token}\x01`);
      return;
    }
    const sender = net.createServer();
    sender.listen(0, '127.0.0.1', () => {
      const { port } = sender.address();
      const pending = { size, offset: 0, name: announced, server: sender };
      sends.set(`port:${port}`, pending);
      sender.once('connection', (socket) => {
        sender.close();
        sends.delete(`port:${port}`);
        pump(socket, size, pending.offset);
      });
      client.write(`:${from} PRIVMSG ${client.nick} :\x01DCC SEND ${quoted} ${LOOPBACK} ${port} ${size}\x01`);
    });
  }

  function onDcc(client, text) {
    // DCC RESUME <name> <port> <position> [token]
    let m = /^DCC RESUME (?:"[^"]*"|\S+) (\d+) (\d+)(?: (\S+))?$/.exec(text);
    if (m) {
      const key = m[1] === '0' ? `token:${m[3]}` : `port:${m[1]}`;
      const pending = sends.get(key);
      events.emit('resume', Number(m[2]));
      if (!pending || !opt.resume) return;
      pending.offset = Number(m[2]);
      client.write(`:${opt.bot}!bot@files.example PRIVMSG ${client.nick} :\x01DCC ACCEPT file.ext ${m[1]} ${m[2]}${m[3] ? ` ${m[3]}` : ''}\x01`);
      return;
    }
    // The client's answer to a reverse offer: DCC SEND <name> <ip> <port> <size> <token>
    m = /^DCC SEND (?:"[^"]*"|\S+) (\d+) (\d+) (\d+) (\S+)$/.exec(text);
    if (m) {
      const pending = sends.get(`token:${m[4]}`);
      if (!pending) return;
      sends.delete(`token:${m[4]}`);
      const socket = net.connect({ host: '127.0.0.1', port: Number(m[2]) }, () => pump(socket, pending.size, pending.offset));
      socket.on('error', () => {});
    }
  }

  function onLine(client, line) {
    lines.push(line);
    events.emit('line', line, client);
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1);
    const me = () => `${client.nick}!user@127.0.0.1`;
    const num = (n, text) => client.write(`:fake.example ${n} ${client.nick || '*'} ${text}`);

    const welcome = () => {
      if (client.welcomed || !client.nick || !client.user || client.capPending) return;
      client.welcomed = true;
      num('001', `:Welcome to the fake network ${client.nick}`);
      num('005', 'NETWORK=FakeNet PREFIX=(ov)@+ CHANTYPES=# :are supported by this server');
      num('422', ':MOTD File is missing');
    };

    switch (cmd) {
      case 'CAP': {
        const [sub, arg = ''] = rest.split(' ');
        if (sub === 'LS') {
          client.capPending = true;
          client.write(`:fake.example CAP * LS :${opt.sasl ? 'sasl multi-prefix' : 'multi-prefix'}`);
        } else if (sub === 'REQ') {
          client.write(`:fake.example CAP * ACK ${arg.startsWith(':') ? arg : `:${arg}`}`);
        } else if (sub === 'END') {
          client.capPending = false;
          welcome();
        }
        return;
      }
      case 'AUTHENTICATE':
        if (rest === 'PLAIN') client.write('AUTHENTICATE +');
        else {
          client.account = Buffer.from(rest, 'base64').toString('utf8').split('\0');
          num('900', `${client.nick}!u@h ${client.account[1]} :You are now logged in`);
          num('903', ':SASL authentication successful');
        }
        return;
      case 'PASS':
        client.pass = rest.replace(/^:/, '');
        return;
      case 'NICK': {
        const nick = rest.replace(/^:/, '');
        if (opt.takenNicks.includes(nick)) return num('433', `${nick} :Nickname is already in use`);
        if (client.welcomed) client.write(`:${me()} NICK :${nick}`);
        client.nick = nick;
        return welcome();
      }
      case 'USER':
        client.user = rest;
        return welcome();
      case 'PING':
        return client.write(`:fake.example PONG fake.example ${rest}`);
      case 'JOIN': {
        const [channel] = rest.split(' ');
        if (opt.joinError) return num(String(opt.joinError), `${channel} :Cannot join channel`);
        client.channels.add(channel);
        client.write(`:${me()} JOIN ${channel}`);
        num('332', `${channel} :Be nice. One request at a time.`);
        num('353', `= ${channel} :${client.nick} @op +reader${botPresent ? ` +${opt.bot}` : ''}`);
        num('366', `${channel} :End of /NAMES list.`);
        return undefined;
      }
      case 'PART': {
        const [channel] = rest.split(' ');
        client.channels.delete(channel);
        return client.write(`:${me()} PART ${channel}`);
      }
      case 'PRIVMSG': {
        const m = /^(\S+) :?(.*)$/.exec(rest);
        if (!m) return undefined;
        const [, target, text] = m;
        events.emit('message', target, text, client);
        if (text.startsWith('\x01DCC ')) return onDcc(client, text.slice(1).replace(/\x01$/, ''));
        const trigger = `!${opt.bot} `;
        if (target.startsWith('#') && botPresent && text.toLowerCase().startsWith(trigger.toLowerCase())) {
          const bar = text.indexOf(' | ');
          const name = bar >= 0 ? text.slice(bar + 3) : 'file.bin';
          client.write(`:${opt.bot}!bot@files.example NOTICE ${client.nick} :Request accepted. Sending ${name}.`);
          setTimeout(() => offerFile(client, opt.bot, name, opt.sizeOf(name)), opt.replyDelayMs);
        }
        return undefined;
      }
      case 'QUIT':
        return client.socket.end();
      default:
        return undefined;
    }
  }

  const server = net.createServer((socket) => {
    const client = {
      socket, nick: '', user: '', welcomed: false, capPending: false, channels: new Set(),
      write: (line) => socket.writable && socket.write(`${line}\r\n`),
    };
    clients.add(client);
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buffer += data;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line) onLine(client, line);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clients.delete(client);
      sockets.delete(socket);
      events.emit('disconnect', client);
    });
  });

  return new Promise((resolve) => {
    server.listen(opt.port, '127.0.0.1', () => {
      api.port = server.address().port;
      resolve(api);
    });
  });
}

// Run directly: a slow server to click around against.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 6667;
  const megabytes = Number(process.argv[3]) || 40;
  const fake = await startFakeIrc({
    port,
    sizeOf: () => megabytes * 1024 * 1024,
    chunkSize: 64 * 1024,
    chunkDelayMs: 20, // about 3 MB/s
    replyDelayMs: 1500,
  });
  fake.events.on('message', (target, text) => console.log(`<- ${target}: ${text.replace(/\x01/g, '^A')}`));
  console.log(`Fake IRC server on 127.0.0.1:${fake.port}. The bot is called ${fake.options.bot}; every file is ${megabytes} MB.`);
}
