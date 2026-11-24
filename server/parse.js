// Parsing for the list file format:
//
//   /audio1/Audio Books/A/Aaron, Rachel
//   ================================================================================
//   !TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip ::INFO:: 306.00MB
//
// A line starting with "/" names the folder for the command lines that follow.
// A line starting with "!" is a command. The command is everything before
// " ::INFO::" and ends with the file extension.

import fs from 'node:fs';

const AUDIO = new Set([
  'mp3', 'flac', 'opus', 'm4b', 'm4a', 'wma', 'wav', 'aac', 'ogg', 'oga',
  'aif', 'aiff', 'ape', 'mka', 'mp2', 'ra', 'aa', 'aax', 'awb', 'amr', 'mpc',
]);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2', 'xz']);

export const KIND_AUDIO = 0;
export const KIND_ARCHIVE = 1;
export const KIND_OTHER = 2;

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
  return KIND_OTHER;
}

/** "/a/b/" -> "/a/b"; collapses repeated slashes; keeps everything else as written. */
export function normalizeFolderPath(line) {
  const parts = line.trim().split('/').filter(Boolean);
  return `/${parts.join('/')}`;
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
    const m = /^!\S+\s+\S+\s+/.exec(command);
    namePos = m ? m[0].length : 0;
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
