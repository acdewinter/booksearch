import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../server/build.js';
import { Library } from '../server/library.js';

const fixture = fileURLToPath(new URL('./fixtures/sample-list.txt', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-'));
const dbPath = path.join(dir, 'library.db');
const stats = buildDatabase(fixture, dbPath);
const library = new Library(dbPath);
library.open();
test.after(() => library.close());

const names = (files) => files.map((f) => f.c.slice(f.p));

test('build counts files and folders', () => {
  assert.equal(stats.files, 15);
  assert.equal(stats.mainFiles, 13);
  assert.equal(stats.folders, 6);
  assert.equal(stats.skippedLines, 0);
  assert.equal(library.info.sourceName, 'sample-list.txt');
});

test('search finds by author and title, grouped by folder', () => {
  const r = library.search({ q: 'rachel heartstrikers' });
  assert.deepEqual(r.total, { files: 2, folders: 1 });
  assert.equal(r.groups[0].path, '/audio1/Audio Books/A/Aaron, Rachel');
  assert.equal(
    r.groups[0].files[0].c,
    '!TrainFiles e48187982e62 | Aaron, Rachel - Heartstrikers 01 - Nice Dragons Finish Last (audiobook).zip',
  );
});

test('search matches the folder when the file name says nothing', () => {
  const r = library.search({ q: 'dickens copperfield' });
  assert.deepEqual(names(r.groups[0].files), ['1 of 8.mp3', '2 of 8.mp3']);
  assert.equal(r.folderMatches[0].path, '/shows/radio-etc/Charles Dickens/David Copperfield');
});

test('search ignores accents and matches word starts', () => {
  assert.equal(library.search({ q: 'frederic chop' }).total.files, 1);
  assert.equal(library.search({ q: 'otrrpg' }).total.files, 1);
});

test('extras are hidden unless asked for', () => {
  assert.equal(library.search({ q: 'stopped heart' }).total.files, 2);
  assert.equal(library.search({ q: 'stopped heart', all: true }).total.files, 3);
});

test('ebooks are found without switching to all files', () => {
  const r = library.search({ q: 'pratchett mort' });
  assert.equal(r.total.files, 2);
  assert.deepEqual(names(r.groups[0].files), ['Pratchett, Terry - Discworld 04 - Mort.epub', 'Pratchett, Terry - Discworld 04 - Mort.mobi']);
  assert.equal(library.search({ q: 'pratchett mort', all: true }).total.files, 3, 'the cover only shows under all files');
  const folder = library.browse({ path: '/books/P/Pratchett, Terry' });
  assert.equal(folder.files.total, 2);
  assert.equal(folder.folder.otherFiles, 1);
});

test('search can be limited to a folder, and exclusions work', () => {
  assert.equal(library.search({ q: 'heaven' }).total.files, 2);
  assert.equal(library.search({ q: 'heaven', path: '/shows' }).total.files, 0);
  assert.equal(library.search({ q: 'heaven -phone' }).total.files, 1);
  assert.equal(library.search({ q: 'x', path: '/nope' }).notFound, true);
});

test('odd input never throws', () => {
  for (const q of ['"', '*', 'a AND', 'NEAR(', ')(', '^x', 'col:x', "o'", '\u0000', 'AND OR NOT']) {
    assert.doesNotThrow(() => library.search({ q }), `query ${JSON.stringify(q)}`);
  }
});

test('browse lists sub-folders and skips single-folder chains', () => {
  const root = library.browse({});
  assert.deepEqual(root.children.map((c) => c.name), ['audio1 / Audio Books', 'books / P / Pratchett, Terry', 'shows / radio-etc']);
  assert.equal(root.folder.files, 13);
  assert.equal(root.folder.otherFiles, 2);
  assert.deepEqual(root.sections.map((s) => s.name), ['audio1 / Audio Books', 'books / P / Pratchett, Terry', 'shows / radio-etc']);

  const author = library.browse({ path: '/audio1/Audio Books/A/Aaron, Rachel' });
  assert.equal(author.files.total, 3);
  assert.deepEqual(author.folder.crumbs.map((c) => c.name), ['audio1', 'Audio Books', 'A', 'Aaron, Rachel']);
});

test('files lists one folder, optionally filtered', () => {
  const p = '/audio1/Audio Books/M/Myerson, Julie/Myerson, Julie - The Stopped Heart';
  assert.equal(library.files({ path: p }).total, 2);
  assert.equal(library.files({ path: p, all: true }).total, 3);
  assert.deepEqual(names(library.files({ path: p, q: 'part02' }).items), ['The Stopped Heart-Part02.mp3']);
});

test('a file with no commands is refused', () => {
  const bad = path.join(dir, 'bad.txt');
  fs.writeFileSync(bad, 'just some text\nwith no commands\n');
  assert.throws(() => buildDatabase(bad, path.join(dir, 'bad.db')), /No command lines/);
  assert.equal(fs.existsSync(path.join(dir, 'bad.db')), false);
});
