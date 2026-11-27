// Reading a zip archive, which is what an .epub is. Node has no zip reader of
// its own, and the format is small enough to read by hand: a table of
// contents at the end of the file says where each entry starts.
//
// Only what an ebook needs: stored and deflated entries, no encryption, no
// zip64 (files of 4 GB and up).

import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;       // "end of central directory"
const CENTRAL = 0x02014b50;    // one line of the table of contents
const LOCAL = 0x04034b50;      // the header in front of an entry's bytes
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 20000;
const MAX_DIRECTORY = 16 * 1024 * 1024;

export class ZipError extends Error {}

export class Zip {
  /** @param {string} file @returns {Zip} Throws ZipError when the file is not a readable zip. */
  static open(file) {
    const fd = fs.openSync(file, 'r');
    try {
      return new Zip(fd, fs.fstatSync(fd).size);
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.entries = new Map(); // name -> { name, method, compressedSize, size, offset }
    this.#readDirectory();
  }

  #read(position, length) {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(this.fd, buf, 0, length, position);
    if (got !== length) throw new ZipError('The file ends too early.');
    return buf;
  }

  #readDirectory() {
    if (this.size < 22) throw new ZipError('This is not a zip file.');
    const tailSize = Math.min(this.size, 22 + MAX_COMMENT);
    const tail = this.#read(this.size - tailSize, tailSize);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new ZipError('This is not a zip file.');
    const count = tail.readUInt16LE(at + 10);
    const dirSize = tail.readUInt32LE(at + 12);
    const dirOffset = tail.readUInt32LE(at + 16);
    if (count > MAX_ENTRIES || dirSize > MAX_DIRECTORY || dirOffset + dirSize > this.size) {
      throw new ZipError('This zip file is too large or damaged.');
    }

    const dir = this.#read(dirOffset, dirSize);
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw new ZipError('This zip file is damaged.');
      const flags = dir.readUInt16LE(p + 8);
      const method = dir.readUInt16LE(p + 10);
      const compressedSize = dir.readUInt32LE(p + 20);
      const size = dir.readUInt32LE(p + 24);
      const nameLength = dir.readUInt16LE(p + 28);
      const extraLength = dir.readUInt16LE(p + 30);
      const commentLength = dir.readUInt16LE(p + 32);
      const offset = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLength);
      p += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue;
      this.entries.set(name, { name, method, compressedSize, size, offset, encrypted: Boolean(flags & 1) });
    }
  }

  has(name) {
    return this.entries.has(name);
  }

  /** The name as it is written in the archive, whatever its case. */
  find(name) {
    if (this.entries.has(name)) return name;
    const wanted = name.toLowerCase();
    for (const key of this.entries.keys()) if (key.toLowerCase() === wanted) return key;
    return null;
  }

  /**
   * The bytes of one entry.
   * @param {string} name
   * @param {number} [maxBytes] refuse anything that unpacks to more than this
   * @returns {Buffer}
   */
  read(name, maxBytes = 32 * 1024 * 1024) {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipError(`"${name}" is not in this file.`);
    if (entry.encrypted) throw new ZipError('This file is protected (DRM), so it cannot be read.');
    if (entry.size > maxBytes) throw new ZipError(`"${name}" is too large.`);
    const head = this.#read(entry.offset, 30);
    if (head.readUInt32LE(0) !== LOCAL) throw new ZipError('This zip file is damaged.');
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (start + entry.compressedSize > this.size) throw new ZipError('This zip file is damaged.');
    const raw = entry.compressedSize ? this.#read(start, entry.compressedSize) : Buffer.alloc(0);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new ZipError(`"${name}" is packed in a way this app cannot read.`);
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch {
      throw new ZipError(`"${name}" could not be unpacked.`);
    }
  }

  close() {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

// ----------------------------------------------------------------- writing
//
// Only used to make small archives in the tests and the practice data.

/**
 * @param {Array<{name: string, data: Buffer | string, store?: boolean}>} files
 * @returns {Buffer}
 */
export function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const name = Buffer.from(file.name, 'utf8');
    const packed = file.store ? data : zlib.deflateRawSync(data);
    const method = file.store ? 0 : 8;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const line = Buffer.alloc(46);
    line.writeUInt32LE(CENTRAL, 0);
    line.writeUInt16LE(20, 4);
    line.writeUInt16LE(20, 6);
    line.writeUInt16LE(0x0800, 8);
    line.writeUInt16LE(method, 10);
    line.writeUInt32LE(crc, 16);
    line.writeUInt32LE(packed.length, 20);
    line.writeUInt32LE(data.length, 24);
    line.writeUInt16LE(name.length, 28);
    line.writeUInt32LE(offset, 42);
    central.push(line, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
