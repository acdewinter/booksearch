// Pure helpers for the IRC and DCC wire formats. No sockets in here.

import net from 'node:net';
import path from 'node:path';
import { namePosWithoutBar } from '../parse.js';

const fallbackDecoder = new TextDecoder('windows-1252');

/** Decode one line from the server. Most networks send UTF-8; old clients do not. */
export function decodeLine(buf) {
  const text = buf.toString('utf8');
  return text.includes('�') ? fallbackDecoder.decode(buf) : text;
}

/**
 * Parse one IRC line into { prefix, nick, user, host, command, params }.
 * Returns null for lines that are not valid messages.
 */
export function parseLine(line) {
  let rest = line.replace(/[\r\n]+$/, '');
  if (rest[0] === '@') {
    // IRCv3 message tags are not used here.
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  let prefix = '';
  if (rest[0] === ':') {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  const params = [];
  while (rest.length) {
    if (rest[0] === ':') {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp < 0) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  const command = (params.shift() || '').toUpperCase();
  if (!command) return null;

  let nick = prefix;
  let user = '';
  let host = '';
  const at = prefix.indexOf('@');
  if (at >= 0) {
    host = prefix.slice(at + 1);
    nick = prefix.slice(0, at);
  }
  const bang = nick.indexOf('!');
  if (bang >= 0) {
    user = nick.slice(bang + 1);
    nick = nick.slice(0, bang);
  }
  return { prefix, nick, user, host, command, params };
}

/** Remove mIRC colours and other formatting codes, and any other control characters. */
export function stripFormatting(text) {
  return text
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
    .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/** Text that is safe to put inside one outgoing line. */
export function cleanOutgoing(text) {
  return String(text).replace(/[\r\n\0]+/g, ' ');
}

/** IRC names compare without case. */
export const lower = (name) => String(name).toLowerCase();

/** "\x01VERSION\x01" -> { command: 'VERSION', args: '' }. Null when not CTCP. */
export function parseCtcp(text) {
  if (text.charCodeAt(0) !== 1) return null;
  let body = text.slice(1);
  const end = body.indexOf('\x01');
  if (end >= 0) body = body.slice(0, end);
  const sp = body.indexOf(' ');
  if (sp < 0) return { command: body.toUpperCase(), args: '' };
  return { command: body.slice(0, sp).toUpperCase(), args: body.slice(sp + 1) };
}

// ---------------------------------------------------------------------- DCC

const isCount = (s) => /^\d{1,15}$/.test(s);
const isPort = (s) => /^\d{1,5}$/.test(s) && Number(s) <= 65535;

/** The address field of a DCC offer: a 32-bit number, or a literal address. */
export function parseDccAddress(field) {
  if (/^\d{1,10}$/.test(field)) {
    const n = Number(field);
    if (n > 0xffffffff) return null;
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return net.isIP(field) ? field : null;
}

/** Dotted IPv4 -> the 32-bit number DCC puts on the wire. Other addresses pass through. */
export function formatDccAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c, d] = address.split('.').map(Number);
    return String(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  }
  return address;
}

/**
 * Parse the text of a CTCP DCC message (without the leading "DCC ").
 *
 *   SEND "file name.zip" 3232235777 5000 12345
 *   SEND file_name.zip 3232235777 0 12345 77      (reverse DCC: port 0 plus a token)
 *   ACCEPT file.zip 5000 4096
 *
 * Returns { type: 'send', filename, host, port, size, token, secure }
 *      or { type: 'accept', filename, port, position, token }
 *      or null.
 */
export function parseDcc(text) {
  const m = /^(\S+) +(.*)$/.exec(text.trim());
  if (!m) return null;
  const verb = m[1].toUpperCase();
  let rest = m[2].trim();

  let filename = null;
  if (rest[0] === '"') {
    const close = rest.lastIndexOf('"');
    if (close > 0) {
      filename = rest.slice(1, close);
      rest = rest.slice(close + 1).trim();
    }
  }
  const words = rest ? rest.split(/ +/) : [];
  // With an unquoted name, the last `count` words are the arguments.
  const take = (count) => {
    if (filename !== null) return words.length === count ? { name: filename, args: words } : null;
    if (words.length <= count) return null;
    return { name: words.slice(0, -count).join(' '), args: words.slice(-count) };
  };

  if (verb === 'SEND' || verb === 'SSEND' || verb === 'TSEND') {
    const build = (t) => {
      if (!t) return null;
      const [addr, port, size, token] = t.args;
      const host = parseDccAddress(addr);
      if (!host || !isPort(port)) return null;
      if (size !== undefined && !isCount(size)) return null;
      return {
        type: 'send',
        filename: t.name,
        host,
        port: Number(port),
        size: size === undefined ? 0 : Number(size),
        token: token ?? null,
        secure: verb === 'SSEND',
      };
    };
    const withToken = build(take(4));
    if (withToken && withToken.port === 0) return withToken;
    // Very old clients leave the size out; only believe that for a name without spaces.
    const sizeless = filename !== null || words.length === 3 ? build(take(2)) : null;
    return build(take(3)) || withToken || sizeless;
  }

  if (verb === 'ACCEPT' || verb === 'RESUME') {
    const build = (t) => {
      if (!t) return null;
      const [port, position, token] = t.args;
      if (!isPort(port) || !isCount(position)) return null;
      return {
        type: verb === 'ACCEPT' ? 'accept' : 'resume',
        filename: t.name,
        port: Number(port),
        position: Number(position),
        token: token ?? null,
      };
    };
    const withToken = build(take(3));
    if (withToken && withToken.port === 0) return withToken;
    return build(take(2)) || withToken;
  }
  return null;
}

/** True for addresses that only exist inside a private network or on this machine. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  return true;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const MAX_NAME_BYTES = 200;

/**
 * Turn whatever name the sender announced into a plain file name that is safe
 * to create inside the download folder on any file system or network share.
 */
export function sanitizeFilename(raw) {
  let name = String(raw ?? '').normalize('NFC');
  name = name.split(/[\\/]/).pop();
  name = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (!name) name = 'download';
  if (RESERVED.test(name)) name = `_${name}`;

  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const ext = path.extname(name);
    const keepExt = Buffer.byteLength(ext) <= 16 ? ext : '';
    let stem = name.slice(0, name.length - keepExt.length);
    while (Buffer.byteLength(stem) + Buffer.byteLength(keepExt) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
    name = stem.trimEnd() + keepExt;
  }
  return name;
}

/**
 * Reduce a file name to letters and digits, so "Some_Book.zip" offered over
 * DCC can be matched with "Some Book.zip" from the list.
 */
export function matchKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Do an offered file name and a requested file name mean the same file? */
export function namesMatch(offered, requested) {
  const a = matchKey(offered);
  const b = matchKey(requested);
  if (!a || !b) return false;
  if (a === b) return true;
  // Some senders shorten long names or add a prefix.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 12 && long.includes(short);
}

/**
 * Split a list command into the parts the downloader needs:
 * "!TrainFiles f77467ded33c | Some Book.zip" -> { bot: 'TrainFiles', name: 'Some Book.zip' }
 * "!Bsk Some Book.epub"                      -> { bot: 'Bsk', name: 'Some Book.epub' }
 * The name is empty when the command does not name a file ("@search tolkien").
 */
export function parseRequestCommand(command) {
  const m = /^[!@]([^\s!@]+)/.exec(command);
  if (!m) return null;
  const bar = command.indexOf(' | ');
  let name = '';
  if (bar >= 0) {
    name = command.slice(bar + 3).trim();
  } else if (command[0] === '!') {
    const rest = command.slice(namePosWithoutBar(command)).trim();
    if (/\.[A-Za-z0-9_]{1,8}$/.test(rest)) name = rest;
  }
  return { bot: m[1], name };
}
