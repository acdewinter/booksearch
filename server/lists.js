// The set of list files that are loaded side by side.
//
// Each list is kept as its own text file in <data>/lists, with a small
// manifest next to it. The search database is always built from all of them,
// so adding, replacing or removing a list means building it again.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_RE = /^[a-f0-9]{16}$/;
const STAGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const MAX_LISTS = 40;

const newId = () => crypto.randomBytes(8).toString('hex');

/** "TrainFiles_audio_2026-11-21.txt" -> "TrainFiles audio" */
export function nameFromFile(fileName) {
  const name = String(fileName ?? '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/\d{4}[-_.]?\d{2}[-_.]?\d{2}/g, ' ')
    .replace(/[_\s]+/g, ' ')
    .replace(/[\s\-.,]+$/, '')
    .replace(/^[\s\-.,]+/, '')
    .trim();
  return name || 'List';
}

function cleanName(name) {
  return String(name ?? '').replace(/[\\/]+/g, '-').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function cleanFileName(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim();
  return base.slice(0, 200) || 'list.txt';
}

/** An error whose message is meant for the person using the app. */
export class ListError extends Error {}

export class ListStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'lists');
    this.stagingDir = path.join(dataDir, 'staging');
    this.manifestPath = path.join(dataDir, 'lists.json');
    this.lists = [];
  }

  /** Read the manifest, take over a list stored the old way, and clear out unfinished uploads. */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });

    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')).lists || [];
    } catch {
      // no manifest yet
    }
    this.lists = saved.filter((l) => l && typeof l.id === 'string' && fs.existsSync(this.pathOf(l.id)));

    // Before several lists were possible there was one, stored as source.txt.
    const legacy = path.join(this.dataDir, 'source.txt');
    const legacyName = path.join(this.dataDir, 'source.name');
    if (this.lists.length === 0 && fs.existsSync(legacy)) {
      let fileName = 'list.txt';
      try {
        fileName = cleanFileName(fs.readFileSync(legacyName, 'utf8'));
      } catch {
        // no stored name
      }
      const id = newId();
      fs.renameSync(legacy, this.pathOf(id));
      fs.rmSync(legacyName, { force: true });
      this.lists = [{ id, name: nameFromFile(fileName), fileName, addedAt: new Date().toISOString() }];
      this.#write();
    }

    for (const entry of fs.readdirSync(this.stagingDir)) fs.rmSync(path.join(this.stagingDir, entry), { force: true });
    return this.lists;
  }

  pathOf(id) {
    return path.join(this.dir, `${id}.txt`);
  }

  /** Changes whenever the set of lists does; stored in the database to notice a stale one. */
  key(lists = this.lists) {
    return lists.map((l) => `${l.id}@${l.addedAt}`).join(',');
  }

  #write() {
    const tmp = `${this.manifestPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lists: this.lists }, null, 2));
    fs.renameSync(tmp, this.manifestPath);
  }

  // ---------------------------------------------------------------- uploads

  /** A place to receive an upload. The file only becomes a list through plan(). */
  stage() {
    const now = Date.now();
    for (const entry of fs.readdirSync(this.stagingDir)) {
      const file = path.join(this.stagingDir, entry);
      try {
        if (now - fs.statSync(file).mtimeMs > STAGE_MAX_AGE_MS) fs.rmSync(file, { force: true });
      } catch {
        // gone already
      }
    }
    const token = newId();
    return { token, path: path.join(this.stagingDir, `${token}.txt`) };
  }

  #staged(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ListError('That upload is not known. Choose the file again.');
    const file = path.join(this.stagingDir, `${token}.txt`);
    if (!fs.existsSync(file)) throw new ListError('That upload is no longer there. Choose the file again.');
    return file;
  }

  discard(tokens) {
    for (const token of tokens) {
      if (typeof token === 'string' && TOKEN_RE.test(token)) fs.rmSync(path.join(this.stagingDir, `${token}.txt`), { force: true });
    }
  }

  // ---------------------------------------------------------------- changes

  /**
   * Work out what the set of lists looks like after some changes, without
   * touching anything yet.
   *
   * @param {object} changes
   * @param {{token: string, name?: string, fileName?: string}[]} [changes.add]
   * @param {{token: string, id: string, fileName?: string}[]} [changes.replace]
   * @param {string[]} [changes.remove]
   * @returns {{lists: object[], sources: object[], commit: (stats?: object[]) => void, discard: () => void}}
   *          `sources` is what to build the database from; commit() makes the change real.
   */
  plan(changes) {
    const add = Array.isArray(changes?.add) ? changes.add : [];
    const replace = Array.isArray(changes?.replace) ? changes.replace : [];
    const remove = new Set(Array.isArray(changes?.remove) ? changes.remove.map(String) : []);
    if (!add.length && !replace.length && !remove.size) throw new ListError('Nothing to change.');

    const tokens = [...add, ...replace].map((c) => c?.token);
    const fail = (message) => {
      this.discard(tokens);
      throw new ListError(message);
    };
    if (new Set(tokens).size !== tokens.length) fail('The same upload was used twice.');

    const now = new Date().toISOString();
    const moves = []; // staged file -> list id
    const replacing = new Map();
    for (const r of replace) {
      const id = String(r?.id ?? '');
      if (!this.lists.some((l) => l.id === id)) fail('The list to replace is no longer there.');
      if (remove.has(id) || replacing.has(id)) fail('A list cannot be replaced twice, or replaced and removed, in one go.');
      let staged;
      try {
        staged = this.#staged(r.token);
      } catch (err) {
        fail(err.message);
      }
      replacing.set(id, { staged, fileName: cleanFileName(r.fileName) });
    }
    for (const id of remove) {
      if (!this.lists.some((l) => l.id === id)) fail('The list to remove is no longer there.');
    }

    const next = [];
    for (const list of this.lists) {
      if (remove.has(list.id)) continue;
      const r = replacing.get(list.id);
      if (r) {
        moves.push({ from: r.staged, id: list.id });
        next.push({ ...list, fileName: r.fileName, addedAt: now, source: r.staged });
      } else {
        next.push({ ...list, source: this.pathOf(list.id) });
      }
    }

    const taken = new Set(next.map((l) => l.name.toLowerCase()));
    for (const a of add) {
      let staged;
      try {
        staged = this.#staged(a?.token);
      } catch (err) {
        fail(err.message);
      }
      const fileName = cleanFileName(a.fileName);
      const base = cleanName(a.name) || nameFromFile(fileName);
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${base} ${i}`;
      taken.add(name.toLowerCase());
      const id = newId();
      moves.push({ from: staged, id });
      next.push({ id, name, fileName, addedAt: now, source: staged });
    }
    if (next.length > MAX_LISTS) fail(`That would be more than ${MAX_LISTS} lists.`);

    const lists = next.map(({ source, ...entry }) => entry);
    return {
      lists,
      key: this.key(lists),
      sources: next.map((l) => ({ id: l.id, name: l.name, fileName: l.fileName, path: l.source })),
      commit: (stats = []) => {
        for (const move of moves) fs.renameSync(move.from, this.pathOf(move.id));
        for (const id of remove) fs.rmSync(this.pathOf(id), { force: true });
        const byId = new Map(stats.map((s) => [s.id, s]));
        this.lists = lists.map((l) => {
          const s = byId.get(l.id);
          return s ? { ...l, files: s.files, mainFiles: s.mainFiles, folders: s.folders, bytes: s.bytes, skippedLines: s.skippedLines } : l;
        });
        this.#write();
      },
      discard: () => this.discard(tokens),
    };
  }

  /** Remember the numbers from a build that did not change the set (a rebuild at startup). */
  setStats(stats = []) {
    const byId = new Map(stats.map((s) => [s.id, s]));
    this.lists = this.lists.map((l) => {
      const s = byId.get(l.id);
      return s ? { ...l, files: s.files, mainFiles: s.mainFiles, folders: s.folders, bytes: s.bytes, skippedLines: s.skippedLines } : l;
    });
    this.#write();
  }

  /** What the build needs for the lists as they are now. */
  sources() {
    return this.lists.map((l) => ({ id: l.id, name: l.name, fileName: l.fileName, path: this.pathOf(l.id) }));
  }
}
