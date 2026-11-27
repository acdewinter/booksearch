import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../server/build.js';
import { Library } from '../server/library.js';
import { ListError, ListStore, nameFromFile } from '../server/lists.js';

const fixture = fileURLToPath(new URL('./fixtures/sample-list.txt', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-lists-'));

const EBOOKS = [
  'OmenServe v2.73',
  '',
  '===============',
  '+New\\2026',
  '===============',
  '!Bsk Terry Pratchett - [Discworld 04] - Mort (retail).epub ::INFO:: 918.2KB',
  '!Bsk Rachel Aaron - Nice Dragons Finish Last.epub ::INFO:: 611.0KB',
  '!Bsk Mort-Cover.jpg ::INFO:: 80.0KB',
  '',
].join('\n');

function writeEbooks(dir, name = 'Bsk-ebooks_2026-11-23.txt') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, EBOOKS);
  return file;
}

test('names are taken from file names', () => {
  assert.equal(nameFromFile('TrainFiles_audio_2026-11-21.txt'), 'TrainFiles audio');
  assert.equal(nameFromFile('Bsk-ebooks 20261123.txt'), 'Bsk-ebooks');
  assert.equal(nameFromFile('SearchBot_results_for_ tolkien.txt.zip'), 'SearchBot results for tolkien.txt');
  assert.equal(nameFromFile('2026-11-21.txt'), 'List');
});

test('several lists are searched together, each under its own top folder', () => {
  const dir = tmp();
  const dbPath = path.join(dir, 'library.db');
  const stats = buildDatabase([
    { id: 'a', name: 'TrainFiles audio', path: fixture },
    { id: 'b', name: 'Bsk ebooks', path: writeEbooks(dir) },
  ], dbPath, { key: 'k1' });

  assert.equal(stats.files, 18);
  assert.deepEqual(stats.bots, ['Bsk', 'TrainFiles'], 'the senders of both lists');
  assert.deepEqual(stats.lists.map((l) => [l.id, l.name, l.folder, l.files, l.mainFiles]), [
    ['a', 'TrainFiles audio', '/TrainFiles audio', 15, 13],
    ['b', 'Bsk ebooks', '/Bsk ebooks', 3, 2],
  ]);
  assert.equal(stats.lists[1].skippedLines, 1);

  const library = new Library(dbPath);
  assert.equal(library.open(), true);
  assert.equal(library.info.listsKey, 'k1');
  assert.equal(library.info.sourceName, '2 lists');

  // One search finds the book in both lists.
  const both = library.search({ q: 'pratchett mort' });
  assert.equal(both.total.files, 3);
  assert.deepEqual(both.groups.map((g) => g.path).sort(), ['/Bsk ebooks/+New/2026', '/TrainFiles audio/books/P/Pratchett, Terry']);
  assert.equal(library.search({ q: 'aaron dragons' }).total.folders, 2);

  // A list is a folder, so searching inside it works like any folder.
  assert.equal(library.search({ q: 'pratchett mort', path: '/Bsk ebooks' }).total.files, 1);
  assert.equal(library.search({ q: 'pratchett mort', path: '/TrainFiles audio' }).total.files, 2);

  const root = library.browse({});
  assert.deepEqual(root.children.map((c) => c.path.split('/')[1]).filter((v, i, a) => a.indexOf(v) === i), ['Bsk ebooks', 'TrainFiles audio']);
  assert.equal(root.folder.files, 15);
  library.close();
});

test('a single list keeps its folders as they are', () => {
  const dir = tmp();
  const dbPath = path.join(dir, 'library.db');
  const stats = buildDatabase([{ id: 'a', name: 'TrainFiles audio', path: fixture }], dbPath);
  assert.equal(stats.lists[0].folder, '');
  const library = new Library(dbPath);
  library.open();
  assert.equal(library.search({ q: 'rachel heartstrikers' }).groups[0].path, '/audio1/Audio Books/A/Aaron, Rachel');
  library.close();
});

test('lists with the same name, or with slashes in it, still get separate folders', () => {
  const dir = tmp();
  const stats = buildDatabase([
    { name: 'Books', path: fixture },
    { name: 'books', path: writeEbooks(dir) },
    { name: 'a/b\\c', path: writeEbooks(dir, 'other.txt') },
  ], path.join(dir, 'library.db'));
  assert.deepEqual(stats.lists.map((l) => l.folder), ['/Books', '/books (2)', '/a-b-c']);
});

test('one bad file stops the whole load and names the file', () => {
  const dir = tmp();
  const bad = path.join(dir, 'holiday-photos.txt');
  fs.writeFileSync(bad, 'nothing to see here\n');
  const dbPath = path.join(dir, 'library.db');
  assert.throws(
    () => buildDatabase([{ name: 'Good', path: fixture }, { name: 'Bad', path: bad }], dbPath),
    /No command lines found in "holiday-photos\.txt"/,
  );
  assert.equal(fs.existsSync(dbPath), false);
});

test('the store adds, replaces and removes lists', () => {
  const dir = tmp();
  const store = new ListStore(dir);
  assert.deepEqual(store.load(), []);
  const upload = (content) => {
    const staged = store.stage();
    fs.writeFileSync(staged.path, content);
    return staged.token;
  };

  // Two new lists at once.
  let plan = store.plan({
    add: [
      { token: upload('one'), fileName: 'TrainFiles_audio_2026-11-21.txt' },
      { token: upload('two'), fileName: 'Bsk-ebooks.txt', name: 'Ebooks / Bsk' },
    ],
  });
  assert.deepEqual(plan.sources.map((s) => s.name), ['TrainFiles audio', 'Ebooks - Bsk']);
  assert.equal(store.lists.length, 0, 'nothing changes before commit');
  plan.commit(plan.sources.map((s, i) => ({ id: s.id, files: 10 + i, mainFiles: 9, folders: 2, bytes: 5, skippedLines: 0 })));
  assert.equal(store.lists.length, 2);
  assert.equal(store.lists[1].files, 11);
  const [audio, ebooks] = store.lists;
  assert.equal(fs.readFileSync(store.pathOf(audio.id), 'utf8'), 'one');
  const keyBefore = store.key();

  // A newer copy of one list keeps its name and place.
  plan = store.plan({ replace: [{ token: upload('one, newer'), id: audio.id, fileName: 'TrainFiles_audio_2026-12-01.txt' }] });
  assert.equal(plan.sources[0].path.includes('staging'), true);
  plan.commit();
  assert.equal(store.lists[0].id, audio.id);
  assert.equal(store.lists[0].name, 'TrainFiles audio');
  assert.equal(store.lists[0].fileName, 'TrainFiles_audio_2026-12-01.txt');
  assert.equal(fs.readFileSync(store.pathOf(audio.id), 'utf8'), 'one, newer');
  assert.notEqual(store.key(), keyBefore);

  // Adding a list with a name that is taken gets a number.
  plan = store.plan({ add: [{ token: upload('three'), name: 'trainfiles AUDIO' }] });
  assert.equal(plan.sources[2].name, 'trainfiles AUDIO 2');
  plan.discard();
  assert.equal(fs.readdirSync(path.join(dir, 'staging')).length, 0);

  // Removing.
  plan = store.plan({ remove: [ebooks.id] });
  plan.commit();
  assert.deepEqual(store.lists.map((l) => l.id), [audio.id]);
  assert.equal(fs.existsSync(store.pathOf(ebooks.id)), false);

  // It is all still there after a restart.
  const again = new ListStore(dir);
  assert.deepEqual(again.load().map((l) => l.name), ['TrainFiles audio']);
});

test('the store refuses changes that make no sense, and drops the uploads', () => {
  const dir = tmp();
  const store = new ListStore(dir);
  store.load();
  const staged = store.stage();
  fs.writeFileSync(staged.path, 'x');

  assert.throws(() => store.plan({}), ListError);
  assert.throws(() => store.plan({ add: [{ token: '../../etc/passwd' }] }), ListError);
  assert.throws(() => store.plan({ add: [{ token: 'ffffffffffffffff' }] }), /no longer there/);
  assert.throws(() => store.plan({ replace: [{ token: staged.token, id: 'nope' }] }), /no longer there/);
  assert.equal(fs.existsSync(staged.path), false, 'the upload of a refused change is deleted');
  assert.throws(() => store.plan({ remove: ['nope'] }), ListError);
});

test('a list stored by an older version is taken over', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'source.txt'), 'old list');
  fs.writeFileSync(path.join(dir, 'source.name'), 'TrainFiles_audio_2026-11-21.txt');
  const store = new ListStore(dir);
  const lists = store.load();
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, 'TrainFiles audio');
  assert.equal(lists[0].fileName, 'TrainFiles_audio_2026-11-21.txt');
  assert.equal(fs.readFileSync(store.pathOf(lists[0].id), 'utf8'), 'old list');
  assert.equal(fs.existsSync(path.join(dir, 'source.txt')), false);
  assert.equal(new ListStore(dir).load()[0].id, lists[0].id);
});
