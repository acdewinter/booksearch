// Parsing for the list file formats. Two layouts are in use:
//
//   /audio1/Audio Books/A/Aaron, Rachel
//   ================================================================================
//   !TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip ::INFO:: 306.00MB
//
//   ===============
//   +1New\2024\2024
//   ===============
//   !Bsk Woods, Stuart - Stone Barrington 56 - Hush-Hush.epub ::INFO:: 716.79KB
//
// A line starting with "!" is a command. The command is everything before
// " ::INFO::" and ends with the file extension. A line starting with "/", or
// any other line with a row of "=" right under it, names the folder for the
// commands that follow.

import fs from 'node:fs';

const AUDIO = new Set([
  'mp3', 'flac', 'opus', 'm4b', 'm4a', 'wma', 'wav', 'aac', 'ogg', 'oga',
  'aif', 'aiff', 'ape', 'mka', 'mp2', 'ra', 'aa', 'aax', 'awb', 'amr', 'mpc',
]);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2', 'xz']);
// Books to read: ebook formats, comics, and the document formats books are passed around in.
const EBOOK = new Set([
  'epub', 'kepub', 'mobi', 'azw', 'azw3', 'azw4', 'kfx', 'prc', 'pdb', 'fb2', 'fbz', 'lit', 'lrf', 'lrx',
  'imp', 'tcr', 'ibooks', 'htmlz', 'pdf', 'djvu', 'djv', 'chm',
  'cbz', 'cbr', 'cb7', 'cbt',
  'doc', 'docx', 'rtf', 'odt',
]);

// Everything below KIND_OTHER is shown by default; "other" only under "All files".
export const KIND_AUDIO = 0;
export const KIND_ARCHIVE = 1;
export const KIND_EBOOK = 2;
export const KIND_OTHER = 3;

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

export function parseSize(label) {
  const m = /^([\d.]+)\s*([KMGT]?)I?B$/i.exec(label.trim());
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * UNITS[`${m[2].toUpperCase()}B`]);
}

export function kindOf(ext) {
  if (AUDIO.has(ext)) return KIND_AUDIO;
  if (ARCHIVE.has(ext)) return KIND_ARCHIVE;
  if (EBOOK.has(ext)) return KIND_EBOOK;
  return KIND_OTHER;
}

/**
 * "/a/b/" -> "/a/b"; collapses repeated slashes; keeps everything else as written.
 * Headings written the Windows way ("a\b\c") become "/a/b/c".
 */
export function normalizeFolderPath(line) {
  const text = line.trim();
  const parts = text.split(text.startsWith('/') ? '/' : /[\\/]/).map((s) => s.trim()).filter(Boolean);
  return `/${parts.join('/')}`;
}

/** Some lists put an id between the bot's name and the file name, without a "|". */
const ID_TOKEN = /^(?:[0-9a-f]{8,}|#\d+)$/i;

/**
 * Where the file name starts in a command that has no " | ":
 * "!Bsk Some Book.epub" -> after "!Bsk "; "!Bot 1a2b3c4d5e Some Book.epub" -> after the id.
 */
export function namePosWithoutBar(command) {
  const m = /^!\S+\s+/.exec(command);
  if (!m) return 0;
  const id = /^(\S+)\s+/.exec(command.slice(m[0].length));
  return id && ID_TOKEN.test(id[1]) ? m[0].length + id[0].length : m[0].length;
}

/**
 * Parse one command line. Returns null if the line is not a command.
 * `command` is exactly what gets copied.
 */
export function parseCommandLine(line) {
  if (line.charCodeAt(0) !== 33 /* ! */) return null;

  let command = line;
  let sizeLabel = '';
  const infoAt = line.lastIndexOf(' ::INFO::');
  if (infoAt >= 0) {
    command = line.slice(0, infoAt);
    sizeLabel = line.slice(infoAt + 9).trim();
  }
  command = command.trimEnd();
  if (command.length < 2) return null;

  // File name is whatever follows the first " | ".
  let namePos;
  const bar = command.indexOf(' | ');
  if (bar >= 0) {
    namePos = bar + 3;
  } else {
    namePos = namePosWithoutBar(command);
  }
  const name = command.slice(namePos);

  let ext = '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    const candidate = name.slice(dot + 1).toLowerCase();
    if (candidate.length <= 8 && /^[a-z0-9_]+$/.test(candidate)) ext = candidate;
  }

  return {
    command,
    namePos,
    name,
    ext,
    kind: kindOf(ext),
    sizeLabel,
    sizeBytes: sizeLabel ? parseSize(sizeLabel) : 0,
  };
}

const fallbackDecoder = new TextDecoder('windows-1252');

function decodeLine(buf, start, end) {
  if (end > start && buf[end - 1] === 13) end -= 1; // CRLF
  const text = buf.toString('utf8', start, end);
  // A few lines in real lists are not valid UTF-8 (old Windows-encoded names).
  if (text.includes('�')) return fallbackDecoder.decode(buf.subarray(start, end));
  return text;
}

/**
 * Read a list file line by line without loading it all into memory.
 * Calls onLine(text, bytesReadSoFar) for every line.
 */
export function readLines(filePath, onLine) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let carry = null;
    let total = 0;
    let first = true;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      let buf = chunk.subarray(0, n);
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      let start = 0;
      if (first) {
        first = false;
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
      }
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl === -1) break;
        onLine(decodeLine(buf, start, nl), total);
        start = nl + 1;
      }
      if (start < buf.length) carry = Buffer.from(buf.subarray(start));
    }
    if (carry && carry.length) onLine(decodeLine(carry, 0, carry.length), total);
  } finally {
    fs.closeSync(fd);
  }
}

export function isSeparatorLine(line) {
  return line.charCodeAt(0) === 61 /* = */ && /^=+\s*$/.test(line);
}

/**
 * Walk a list file and report what each line is.
 *   folder(path, bytesRead)   a folder heading, already tidied
 *   command(line, bytesRead)  a line starting with "!"
 *   other(line)               anything else that is not layout (a title, a note)
 */
export function readList(filePath, { folder, command, other = () => {} }) {
  // A plain line is only a folder heading if a row of "=" follows it, so it waits one line.
  let pending = null;
  readLines(filePath, (line, bytes) => {
    if (pending !== null) {
      const heading = pending;
      pending = null;
      if (isSeparatorLine(line)) {
        folder(normalizeFolderPath(heading), bytes);
        return;
      }
      other(heading);
    }
    const c = line.charCodeAt(0);
    if (c === 33 /* ! */) command(line, bytes);
    else if (c === 47 /* / */) folder(normalizeFolderPath(line), bytes);
    else if (line.trim() !== '' && !isSeparatorLine(line)) pending = line;
  });
  if (pending !== null) other(pending);
}
