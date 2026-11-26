// Read-only access to the built database: search, browse, and file listings.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './build.js';
import { KIND_OTHER } from './parse.js';
import { parseQuery } from './query.js';

const GROUPS_PER_PAGE = 20;
const PREVIEW_FILES = 10;
const BROWSE_FILES = 200;
const MAX_FILES_PER_REQUEST = 5000;
const FOLDER_MATCHES = 8;
const SECTION_SPLIT = 6;    // a folder with this few sub-folders is opened up on the start page
const SECTION_PREVIEW = 60;  // sub-folders listed per section on the start page

/** The highest file kind to include: everything, or everything except extras. */
const maxKindFor = (all) => (all ? KIND_OTHER : KIND_OTHER - 1);

const FILE_COLUMNS = 'f.id, f.command, f.name_pos, f.ext, f.kind, f.size_label';

const toFile = (r) => ({ c: r.command, p: r.name_pos, e: r.ext, k: r.kind, s: r.size_label });

const SEARCH_SQL = `
  WITH m AS MATERIALIZED (
    SELECT f.id, f.folder_id AS fid, bm25(files_fts, 2.0, 1.0) AS r
    FROM files_fts JOIN files f ON f.id = files_fts.rowid
    WHERE files_fts MATCH ? AND f.kind <= ? AND f.folder_id BETWEEN ? AND ?
  ),
  g AS (SELECT fid, count(*) AS n, min(r) AS best FROM m GROUP BY fid),
  top AS (
    SELECT fid, n, best, count(*) OVER () AS folders, sum(n) OVER () AS files
    FROM g ORDER BY best, fid LIMIT ? OFFSET ?
  ),
  pick AS (
    SELECT m.id, m.fid, row_number() OVER (PARTITION BY m.fid ORDER BY m.id) AS rn
    FROM m WHERE m.fid IN (SELECT fid FROM top)
  )
  SELECT top.fid, top.n, top.folders, top.files, fo.path, ${FILE_COLUMNS}
  FROM top
  JOIN pick ON pick.fid = top.fid AND pick.rn <= ?
  JOIN files f ON f.id = pick.id
  JOIN folders fo ON fo.id = top.fid
  ORDER BY top.best, top.fid, f.id`;

export class Library {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.info = null;
  }

  get ready() {
    return this.db !== null;
  }

  /** Opens the database if there is a usable one. Returns true when ready. */
  open() {
    this.close();
    if (!fs.existsSync(this.dbPath)) return false;
    let db;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const meta = Object.fromEntries(
        db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]),
      );
      if (Number(meta.schema_version) !== SCHEMA_VERSION) {
        db.close();
        return false;
      }
      db.exec('PRAGMA cache_size = -32768; PRAGMA temp_store = MEMORY; PRAGMA query_only = ON;');
      this.db = db;
      this.info = {
        ...JSON.parse(meta.stats),
        sourceName: meta.source_name,
        importedAt: meta.imported_at,
        listsKey: meta.lists_key ?? '',
      };
      this.#prepare();
      return true;
    } catch (err) {
      try {
        db?.close();
      } catch {
        // ignore
      }
      this.db = null;
      this.info = null;
      console.error(`Could not open ${this.dbPath}: ${err.message}`);
      return false;
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.info = null;
      this.st = null;
    }
  }

  /** Replace the live database with a freshly built one. */
  swap(newDbPath) {
    this.close();
    fs.renameSync(newDbPath, this.dbPath);
    if (!this.open()) throw new Error('The new database could not be opened.');
  }

  #prepare() {
    const db = this.db;
    const folderCols = 'id, parent_id, path, name, depth, subtree_end, direct_files, direct_main, total_files, total_main';
    this.st = {
      folderByPath: db.prepare(`SELECT ${folderCols} FROM folders WHERE path = ?`),
      folderById: db.prepare(`SELECT ${folderCols} FROM folders WHERE id = ?`),
      children: db.prepare(`SELECT ${folderCols} FROM folders WHERE parent_id = ? ORDER BY id`),
      search: db.prepare(SEARCH_SQL),
      folderNameMatches: db.prepare(
        `SELECT fo.id, fo.path, fo.name, fo.total_files, fo.total_main
         FROM folders_fts JOIN folders fo ON fo.id = folders_fts.rowid
         WHERE folders_fts MATCH ? AND fo.id BETWEEN ? AND ?
           AND (CASE WHEN ? THEN fo.total_files ELSE fo.total_main END) > 0
         ORDER BY (CASE WHEN ? THEN fo.total_files ELSE fo.total_main END) DESC, fo.id
         LIMIT ?`,
      ),
      folderPathMatches: db.prepare(
        `SELECT fo.id, fo.path, fo.name, fo.total_files, fo.total_main
         FROM folders_fts JOIN folders fo ON fo.id = folders_fts.rowid
         WHERE folders_fts MATCH ? AND fo.id BETWEEN ? AND ?
           AND (CASE WHEN ? THEN fo.total_files ELSE fo.total_main END) > 0
         ORDER BY bm25(folders_fts, 4.0, 1.0), fo.depth, fo.id
         LIMIT ?`,
      ),
      filesInFolder: db.prepare(
        `SELECT ${FILE_COLUMNS} FROM files f WHERE f.folder_id = ? AND f.kind <= ? ORDER BY f.id LIMIT ? OFFSET ?`,
      ),
      matchesInFolder: db.prepare(
        `SELECT ${FILE_COLUMNS} FROM files_fts JOIN files f ON f.id = files_fts.rowid
         WHERE files_fts MATCH ? AND f.folder_id = ? AND f.kind <= ? ORDER BY f.id LIMIT ? OFFSET ?`,
      ),
      countMatches: db.prepare(
        `SELECT count(*) AS files, count(DISTINCT f.folder_id) AS folders
         FROM files_fts JOIN files f ON f.id = files_fts.rowid
         WHERE files_fts MATCH ? AND f.kind <= ?`,
      ),
      countMatchesInFolder: db.prepare(
        `SELECT count(*) AS n FROM files_fts JOIN files f ON f.id = files_fts.rowid
         WHERE files_fts MATCH ? AND f.folder_id = ? AND f.kind <= ?`,
      ),
    };
  }

  #folder(path) {
    return this.st.folderByPath.get(path || '/') ?? null;
  }

  #crumbs(folder) {
    const crumbs = [];
    let f = folder;
    while (f && f.parent_id) {
      crumbs.unshift({ name: f.name, path: f.path });
      f = this.st.folderById.get(f.parent_id);
    }
    return crumbs;
  }

  /**
   * Search inside `path` (default: everything). Results are grouped by folder.
   */
  search({ q, path = '/', all = false, page = 0 }) {
    const scope = this.#folder(path);
    if (!scope) return { notFound: true };
    const parsed = parseQuery(q);
    const base = {
      scope: { path: scope.path, name: scope.name, crumbs: this.#crumbs(scope) },
      terms: parsed?.highlight ?? [],
      page,
    };
    if (!parsed) return { ...base, total: { files: 0, folders: 0 }, groups: [], folderMatches: [], hasMore: false };

    const maxKind = maxKindFor(all);
    let rows;
    try {
      rows = this.st.search.all(
        parsed.match, maxKind, scope.id, scope.subtree_end,
        GROUPS_PER_PAGE, page * GROUPS_PER_PAGE, PREVIEW_FILES,
      );
    } catch (err) {
      if (err.code !== 'ERR_SQLITE_ERROR') throw err;
      rows = []; // a query the full-text engine cannot parse simply matches nothing
    }

    const groups = [];
    let current = null;
    for (const r of rows) {
      if (!current || current.id !== r.fid) {
        current = { id: r.fid, path: r.path, matches: r.n, files: [] };
        groups.push(current);
      }
      current.files.push(toFile(r));
    }
    const total = rows.length ? { files: rows[0].files, folders: rows[0].folders } : { files: 0, folders: 0 };

    return {
      ...base,
      total,
      groups,
      hasMore: (page + 1) * GROUPS_PER_PAGE < total.folders,
      folderMatches: page === 0 ? this.#folderMatches(parsed, scope, all) : [],
    };
  }

  /** How many files, in how many folders, a search would find. Nothing is fetched. */
  count({ q, all = false }) {
    const parsed = parseQuery(q);
    if (!parsed || !this.ready) return { files: 0, folders: 0 };
    try {
      const row = this.st.countMatches.get(parsed.match, maxKindFor(all));
      return { files: row.files, folders: row.folders };
    } catch (err) {
      if (err.code !== 'ERR_SQLITE_ERROR') throw err;
      return { files: 0, folders: 0 };
    }
  }

  /** Folders whose own name matches come first; then folders matched through a parent. */
  #folderMatches(parsed, scope, all) {
    const flag = all ? 1 : 0;
    const from = scope.id + 1;
    const to = scope.subtree_end;
    const out = [];
    const seen = new Set();
    const add = (rows) => {
      for (const r of rows) {
        if (seen.has(r.id) || out.length >= FOLDER_MATCHES) continue;
        seen.add(r.id);
        out.push({ path: r.path, name: r.name, files: all ? r.total_files : r.total_main });
      }
    };
    try {
      add(this.st.folderNameMatches.all(`name : (${parsed.match})`, from, to, flag, flag, FOLDER_MATCHES));
      if (out.length < FOLDER_MATCHES) {
        add(this.st.folderPathMatches.all(parsed.match, from, to, flag, FOLDER_MATCHES * 2));
      }
    } catch (err) {
      if (err.code !== 'ERR_SQLITE_ERROR') throw err;
    }
    return out;
  }

  /**
   * Sub-folders of `folder` that have something to show. A folder that holds
   * nothing but a single sub-folder is skipped through ("shows / radio-etc").
   */
  #children(folder, all) {
    const count = (f) => (all ? f.total_files : f.total_main);
    const out = [];
    for (const child of this.st.children.all(folder.id)) {
      if (count(child) === 0) continue;
      let target = child;
      const label = [child.name];
      for (;;) {
        const direct = all ? target.direct_files : target.direct_main;
        if (direct > 0) break;
        const subs = this.st.children.all(target.id).filter((s) => count(s) > 0);
        if (subs.length !== 1) break;
        target = subs[0];
        label.push(target.name);
      }
      out.push({ name: label.join(' / '), path: target.path, files: count(target), target });
    }
    return out;
  }

  /**
   * For the start page: walk down through folders that only split into a few
   * parts, so the page opens on the shelves people actually pick from.
   */
  #sections(folder, all, prefix = '', depth = 0) {
    const out = [];
    for (const child of this.#children(folder, all)) {
      const name = prefix ? `${prefix} / ${child.name}` : child.name;
      const subs = this.#children(child.target, all);
      const direct = all ? child.target.direct_files : child.target.direct_main;
      // Only open a folder up if everything inside it is itself a folder of folders.
      const opensUp = subs.length > 0 && subs.length <= SECTION_SPLIT && direct === 0 && depth < 3
        && subs.every((s) => this.#children(s.target, all).length > 0);
      if (opensUp) {
        out.push(...this.#sections(child.target, all, name, depth + 1));
      } else {
        out.push({
          name,
          path: child.path,
          files: child.files,
          folderCount: subs.length,
          children: subs.slice(0, SECTION_PREVIEW).map(({ target, ...rest }) => rest),
        });
      }
    }
    return out;
  }

  /** One level of the folder tree: sub-folders, plus the files directly inside. */
  browse({ path = '/', all = false }) {
    const folder = this.#folder(path);
    if (!folder) return { notFound: true };
    const count = (f) => (all ? f.total_files : f.total_main);

    const children = this.#children(folder, all).map(({ target, ...rest }) => rest);
    let sections = null;
    if (folder.path === '/' && children.length <= SECTION_SPLIT) {
      sections = this.#sections(folder, all);
      if (sections.length > 8 || !sections.some((s) => s.children.length)) sections = null;
    }

    const maxKind = maxKindFor(all);
    const directTotal = all ? folder.direct_files : folder.direct_main;
    const items = directTotal
      ? this.st.filesInFolder.all(folder.id, maxKind, BROWSE_FILES, 0).map(toFile)
      : [];

    return {
      folder: {
        path: folder.path,
        name: folder.name,
        crumbs: this.#crumbs(folder),
        files: count(folder),
        otherFiles: folder.total_files - folder.total_main,
      },
      children,
      sections,
      files: { total: directTotal, items },
    };
  }

  /** Files directly inside one folder, optionally only those matching `q`. */
  files({ path, q = '', all = false, offset = 0, limit = MAX_FILES_PER_REQUEST }) {
    const folder = this.#folder(path);
    if (!folder) return { notFound: true };
    const maxKind = maxKindFor(all);
    const take = Math.max(1, Math.min(limit, MAX_FILES_PER_REQUEST));
    const parsed = parseQuery(q);
    if (parsed) {
      try {
        const total = this.st.countMatchesInFolder.get(parsed.match, folder.id, maxKind).n;
        const items = this.st.matchesInFolder.all(parsed.match, folder.id, maxKind, take, offset).map(toFile);
        return { total, offset, items };
      } catch (err) {
        if (err.code !== 'ERR_SQLITE_ERROR') throw err;
        return { total: 0, offset, items: [] };
      }
    }
    const total = all ? folder.direct_files : folder.direct_main;
    const items = this.st.filesInFolder.all(folder.id, maxKind, take, offset).map(toFile);
    return { total, offset, items };
  }
}
