// Builds a fresh SQLite database from a list file.
//
// The database is written to its own file and only swapped in once it is
// complete, so a bad upload can never damage the list that is already loaded.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  KIND_OTHER,
  parseCommandLine,
  readList,
} from './parse.js';

// Bump when the tables below change. A database with a different version is
// rebuilt from the stored list file on startup.
// 2: ebooks became a kind of their own, and lists in the "!Bot File.ext" layout
//    (with their folder headings) are read properly.
// 3: several lists can be combined; the database records which ones it holds.
export const SCHEMA_VERSION = 3;

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

  -- Folder ids follow a depth-first walk of the tree in A-Z order, so every
  -- folder's descendants are exactly the ids in (id, subtree_end].
  CREATE TABLE folders (
    id           INTEGER PRIMARY KEY,
    parent_id    INTEGER,
    path         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    depth        INTEGER NOT NULL,
    subtree_end  INTEGER NOT NULL,
    direct_files INTEGER NOT NULL DEFAULT 0,  -- files directly in this folder
    direct_main  INTEGER NOT NULL DEFAULT 0,  -- ...that are audio or archives
    total_files  INTEGER NOT NULL DEFAULT 0,  -- files in this folder and below
    total_main   INTEGER NOT NULL DEFAULT 0,
    total_bytes  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX folders_parent ON folders (parent_id);

  -- Files keep the order they have in the list.
  CREATE TABLE files (
    id         INTEGER PRIMARY KEY,
    folder_id  INTEGER NOT NULL,  -- folders.id
    command    TEXT NOT NULL,     -- exactly what gets copied
    name_pos   INTEGER NOT NULL,  -- where the file name starts inside command
    ext        TEXT NOT NULL,
    kind       INTEGER NOT NULL,  -- 0 audio, 1 archive, 2 ebook, 3 other
    size_bytes INTEGER NOT NULL,
    size_label TEXT NOT NULL
  );
  CREATE INDEX files_folder ON files (folder_id);

  CREATE VIRTUAL TABLE files_fts USING fts5 (
    name, path,
    content = '', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE VIRTUAL TABLE folders_fts USING fts5 (
    name, parents,
    content = '', tokenize = 'unicode61 remove_diacritics 2'
  );
`;

function compareSegments(a, b) {
  const n = Math.min(a.segs.length, b.segs.length);
  for (let i = 0; i < n; i += 1) {
    if (a.lower[i] !== b.lower[i]) return a.lower[i] < b.lower[i] ? -1 : 1;
    if (a.segs[i] !== b.segs[i]) return a.segs[i] < b.segs[i] ? -1 : 1;
  }
  return a.segs.length - b.segs.length;
}

/** A list's name as a folder name: it becomes the top folder when several lists are loaded. */
export function listFolderName(name) {
  return String(name ?? '').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim() || 'List';
}

/**
 * @typedef {{path: string, name?: string, id?: string, fileName?: string}} ListSource
 *
 * @param {string | ListSource[]} sources one list file, or several to combine. With
 *        several, each list gets a top folder of its own, named after the list.
 * @param {string} outPath     database file to create (replaced if present)
 * @param {{sourceName?: string, key?: string, onProgress?: (p: {phase: string, progress: number}) => void}} [options]
 * @returns {{files: number, mainFiles: number, folders: number, bytes: number, skippedLines: number, lists: object[]}}
 */
export function buildDatabase(sources, outPath, options = {}) {
  const { onProgress = () => {} } = options;
  const lists = (typeof sources === 'string' ? [{ path: sources, name: options.sourceName }] : sources).map((s) => {
    const fileName = s.fileName || path.basename(s.path);
    return {
      id: s.id || '',
      path: s.path,
      fileName,
      name: s.name || fileName,
      size: Math.max(1, fs.statSync(s.path).size),
      prefix: '',
      commandLines: 0,
      files: 0,
      mainFiles: 0,
      folders: 0,
      bytes: 0,
      skippedLines: 0,
    };
  });
  if (lists.length === 0) throw new Error('There is no list to load.');

  // Several lists: each one sits under a top folder with its own name.
  if (lists.length > 1) {
    const taken = new Set();
    for (const list of lists) {
      const base = listFolderName(list.name);
      let folder = base;
      for (let i = 2; taken.has(folder.toLowerCase()); i += 1) folder = `${base} (${i})`;
      taken.add(folder.toLowerCase());
      list.prefix = `/${folder}`;
    }
  }
  const totalSize = lists.reduce((sum, l) => sum + l.size, 0);

  let lastReport = 0;
  const report = (phase, fraction) => {
    const now = Date.now();
    if (now - lastReport < 100 && fraction < 1) return;
    lastReport = now;
    onProgress({ phase, progress: Math.min(1, fraction) });
  };

  // Pass 1: find every folder (and its parents) so ids can follow tree order.
  const seen = new Set(['/']);
  const addFolder = (folderPath) => {
    let p = folderPath;
    while (p !== '/' && !seen.has(p)) {
      seen.add(p);
      const cut = p.lastIndexOf('/');
      p = cut <= 0 ? '/' : p.slice(0, cut);
    }
  };
  const within = (list, folderPath) => (folderPath === '/' ? list.prefix || '/' : list.prefix + folderPath);

  let doneSize = 0;
  for (const list of lists) {
    if (list.prefix) addFolder(list.prefix);
    const base = doneSize;
    readList(list.path, {
      folder(folderPath, bytes) {
        addFolder(within(list, folderPath));
        report('Reading folders', ((base + bytes) / totalSize) * 0.1);
      },
      command(line, bytes) {
        list.commandLines += 1;
        if ((list.commandLines & 1023) === 0) report('Reading folders', ((base + bytes) / totalSize) * 0.1);
      },
    });
    if (list.commandLines === 0) {
      throw new Error(
        lists.length > 1 || typeof sources !== 'string'
          ? `No command lines found in "${list.fileName}". Each command should be on its own line and start with "!".`
          : 'No command lines found. Each command should be on its own line and start with "!".',
      );
    }
    doneSize += list.size;
  }

  const folders = [...seen].map((p) => {
    const segs = p === '/' ? [] : p.slice(1).split('/');
    return { path: p, segs, lower: segs.map((s) => s.toLowerCase()) };
  });
  folders.sort(compareSegments);

  const idByPath = new Map();
  folders.forEach((f, i) => {
    f.id = i + 1;
    f.directFiles = 0;
    f.directMain = 0;
    f.directBytes = 0;
    idByPath.set(f.path, f.id);
  });
  // parent + subtree_end, using a stack of open ancestors
  const stack = [];
  for (const f of folders) {
    while (stack.length && stack[stack.length - 1].segs.length >= f.segs.length) {
      stack.pop().subtreeEnd = f.id - 1;
    }
    f.parentId = stack.length ? stack[stack.length - 1].id : null;
    stack.push(f);
  }
  while (stack.length) stack.pop().subtreeEnd = folders.length;

  // Pass 2: write everything.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(outPath + suffix, { force: true });
  }
  const db = new DatabaseSync(outPath);
  let files = 0;
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA locking_mode = EXCLUSIVE;');
    db.exec('PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;');
    db.exec(SCHEMA);
    db.exec('BEGIN');

    const insertFile = db.prepare(
      'INSERT INTO files (id, folder_id, command, name_pos, ext, kind, size_bytes, size_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertFileFts = db.prepare('INSERT INTO files_fts (rowid, name, path) VALUES (?, ?, ?)');

    doneSize = 0;
    for (const list of lists) {
      const base = doneSize;
      // Commands before any folder line land in the list's own top folder.
      let current = folders[idByPath.get(list.prefix || '/') - 1];
      readList(list.path, {
        folder(folderPath) {
          current = folders[idByPath.get(within(list, folderPath)) - 1];
        },
        command(line, bytes) {
          const f = parseCommandLine(line);
          if (!f) {
            list.skippedLines += 1;
            return;
          }
          files += 1;
          insertFile.run(files, current.id, f.command, f.namePos, f.ext, f.kind, f.sizeBytes, f.sizeLabel);
          insertFileFts.run(files, f.name, current.path);
          if (current.directFiles === 0) list.folders += 1;
          current.directFiles += 1;
          list.files += 1;
          list.bytes += f.sizeBytes;
          if (f.kind !== KIND_OTHER) {
            current.directMain += 1;
            list.mainFiles += 1;
          }
          current.directBytes += f.sizeBytes;
          if ((files & 1023) === 0) report('Indexing files', 0.1 + ((base + bytes) / totalSize) * 0.75);
        },
        other() {
          list.skippedLines += 1;
        },
      });
      if (list.files === 0) throw new Error(`No commands could be read from "${list.fileName}".`);
      doneSize += list.size;
    }

    report('Finishing', 0.87);

    // Roll totals up the tree. Children always come after their parent.
    for (const f of folders) {
      f.totalFiles = f.directFiles;
      f.totalMain = f.directMain;
      f.totalBytes = f.directBytes;
    }
    for (let i = folders.length - 1; i >= 0; i -= 1) {
      const f = folders[i];
      if (f.parentId) {
        const parent = folders[f.parentId - 1];
        parent.totalFiles += f.totalFiles;
        parent.totalMain += f.totalMain;
        parent.totalBytes += f.totalBytes;
      }
    }

    const insertFolder = db.prepare(
      `INSERT INTO folders (id, parent_id, path, name, depth, subtree_end,
         direct_files, direct_main, total_files, total_main, total_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFolderFts = db.prepare('INSERT INTO folders_fts (rowid, name, parents) VALUES (?, ?, ?)');
    for (const f of folders) {
      const name = f.segs.length ? f.segs[f.segs.length - 1] : '';
      insertFolder.run(
        f.id, f.parentId, f.path, name, f.segs.length, f.subtreeEnd,
        f.directFiles, f.directMain, f.totalFiles, f.totalMain, f.totalBytes,
      );
      if (f.segs.length) insertFolderFts.run(f.id, name, f.segs.slice(0, -1).join(' / '));
    }

    const root = folders[0];
    const stats = {
      files,
      mainFiles: root.totalMain,
      folders: folders.filter((f) => f.directFiles > 0).length,
      bytes: root.totalBytes,
      skippedLines: lists.reduce((sum, l) => sum + l.skippedLines, 0),
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        fileName: l.fileName,
        folder: l.prefix,
        files: l.files,
        mainFiles: l.mainFiles,
        folders: l.folders,
        bytes: l.bytes,
        skippedLines: l.skippedLines,
      })),
    };
    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    setMeta.run('schema_version', String(SCHEMA_VERSION));
    setMeta.run('source_name', lists.length === 1 ? lists[0].fileName : `${lists.length} lists`);
    setMeta.run('source_bytes', String(totalSize));
    setMeta.run('lists_key', options.key ?? '');
    setMeta.run('imported_at', new Date().toISOString());
    setMeta.run('stats', JSON.stringify(stats));

    db.exec('COMMIT');
    report('Finishing', 0.92);
    db.exec("INSERT INTO files_fts (files_fts) VALUES ('optimize')");
    db.exec("INSERT INTO folders_fts (folders_fts) VALUES ('optimize')");
    db.exec('ANALYZE');
    db.exec('PRAGMA locking_mode = NORMAL; PRAGMA journal_mode = DELETE;');
    db.close();
    onProgress({ phase: 'Finishing', progress: 1 });
    return stats;
  } catch (err) {
    try {
      db.close();
    } catch {
      // already closed
    }
    fs.rmSync(outPath, { force: true });
    throw err;
  }
}
