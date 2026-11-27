// The collection: reading an epub's own details, tying files in the download
// folder to titles, and remembering how far each was read.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeEpub } from '../dev/make-epub.js';
import { Collection, CollectionError, guessBooks, kindOf, nameQuery } from '../server/collection/store.js';
import { EpubError, readEpub } from '../server/epub.js';
import { Zip, ZipError, makeZip } from '../server/zip.js';

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-col-'));
  const downloadDir = path.join(dataDir, 'downloads');
  fs.mkdirSync(downloadDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const put = (name, data) => {
    fs.mkdirSync(path.dirname(path.join(downloadDir, name)), { recursive: true });
    fs.writeFileSync(path.join(downloadDir, name), data);
  };
  const make = () => {
    const collection = new Collection({ dataDir, downloadDir, ...options });
    collection.load();
    return collection;
  };
  return { dataDir, downloadDir, put, make };
}

const MORT = { hardcoverId: 104, title: 'Mort', authors: ['Terry Pratchett'], series: { name: 'Discworld', position: 4 }, year: 1987, cover: 'https://img.example/mort.jpg' };

test('a zip is read back entry by entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-zip-'));
  try {
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, makeZip([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'deep/Folder/Tëxt.txt', data: 'hello '.repeat(500) },
      { name: 'empty.txt', data: '' },
    ]));
    const zip = Zip.open(file);
    assert.deepEqual([...zip.entries.keys()], ['mimetype', 'deep/Folder/Tëxt.txt', 'empty.txt']);
    assert.equal(zip.read('mimetype').toString(), 'application/epub+zip');
    assert.equal(zip.read('deep/Folder/Tëxt.txt').toString(), 'hello '.repeat(500));
    assert.equal(zip.read('empty.txt').length, 0);
    assert.equal(zip.find('DEEP/folder/tëxt.TXT'), 'deep/Folder/Tëxt.txt');
    assert.throws(() => zip.read('deep/Folder/Tëxt.txt', 100), ZipError, 'an entry larger than allowed is refused');
    assert.throws(() => zip.read('nope'), ZipError);
    zip.close();

    fs.writeFileSync(file, 'this is not a zip file at all, just some text that is long enough');
    assert.throws(() => Zip.open(file), ZipError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an epub tells its title, author, series and cover', (t) => {
  const { downloadDir, put } = setup(t);
  put('book.epub', makeEpub({ title: 'By a Silver Thread & Other <Tales>', author: 'Aaron, Rachel', series: ['DFZ Changeling', 1], year: 2023 }));
  const meta = readEpub(path.join(downloadDir, 'book.epub'), { cover: true });
  assert.equal(meta.title, 'By a Silver Thread & Other <Tales>');
  assert.deepEqual(meta.authors, ['Rachel Aaron'], 'a name filed surname first is turned around');
  assert.deepEqual(meta.series, { name: 'DFZ Changeling', position: 1 });
  assert.equal(meta.year, 2023);
  assert.equal(meta.language, 'en');
  assert.equal(meta.description, 'A book that exists to be opened.', 'markup in the description is taken out');
  assert.equal(meta.hasCover, true);
  assert.equal(meta.cover.type, 'image/png');
  assert.deepEqual([...meta.cover.data.subarray(1, 4)], [0x50, 0x4e, 0x47]);

  put('bare.epub', makeEpub({ cover: false }));
  assert.equal(readEpub(path.join(downloadDir, 'bare.epub')).hasCover, false);

  put('fake.epub', 'not a zip');
  assert.throws(() => readEpub(path.join(downloadDir, 'fake.epub')), EpubError);
  put('other.epub', makeZip([{ name: 'readme.txt', data: 'a zip, but not a book' }]));
  assert.throws(() => readEpub(path.join(downloadDir, 'other.epub')), EpubError);
});

test('file names are told apart and turned into something to look up', () => {
  assert.equal(kindOf('epub'), 'ebook');
  assert.equal(kindOf('m4b'), 'audio');
  assert.equal(kindOf('rar'), 'archive');
  assert.equal(kindOf('nfo'), 'other');
  assert.equal(nameQuery('Aaron, Rachel - By a Silver Thread (retail) (epub).epub'), 'Aaron, Rachel - By a Silver Thread');
  assert.equal(nameQuery('Terry_Pratchett.-.Mort.[Discworld 4].epub'), 'Terry Pratchett - Mort');
});

test('the likeliest book of a library is guessed from a file name', () => {
  const books = [
    { id: 1, title: 'Mort', authors: ['Terry Pratchett'] },
    { id: 2, title: 'The Final Empire', authors: ['Brandon Sanderson'] },
    { id: 3, title: 'The Well of Ascension', authors: ['Brandon Sanderson'] },
    { id: 4, title: "Ender's Game", authors: ['Orson Scott Card'] },
    { id: 5, title: 'Good Omens: The Nice and Accurate Prophecies of Agnes Nutter, Witch', authors: ['Terry Pratchett', 'Neil Gaiman'] },
  ];
  const ids = (q) => guessBooks(q, books).map((b) => b.id);
  assert.deepEqual(ids('Pratchett, Terry - Discworld 04 - Mort'), [1]);
  assert.deepEqual(ids('Sanderson, Brandon - Mistborn 01 - The Final Empire'), [2]);
  assert.deepEqual(ids('Enders Game - Orson Scott Card'), [4]);
  assert.deepEqual(ids('Some Other Book Entirely'), []);
  assert.deepEqual(ids(''), []);
});

test('files are tied to titles, and the rest wait to be sorted', (t) => {
  const { put, make, downloadDir } = setup(t);
  put('Pratchett, Terry - Discworld 04 - Mort.epub', makeEpub({ title: 'Mort', author: 'Pratchett, Terry' }));
  put('Pratchett, Terry - Discworld 04 - Mort.mobi', 'mobi bytes');
  put('audio/Mort (audiobook).zip', 'zip bytes');
  put('half-done.epub.part', 'partial');
  put('.hidden', 'x');
  const collection = make();

  let list = collection.list('local');
  assert.deepEqual(list.books, []);
  assert.deepEqual(list.loose.map((f) => f.path).sort(), [
    'Pratchett, Terry - Discworld 04 - Mort.epub', 'Pratchett, Terry - Discworld 04 - Mort.mobi', 'audio/Mort (audiobook).zip',
  ], 'partial downloads and hidden files are left out');

  const info = collection.describeFile('Pratchett, Terry - Discworld 04 - Mort.epub');
  assert.deepEqual(info.embedded, { title: 'Mort', authors: ['Terry Pratchett'], series: null, year: 2024, hasCover: true });
  assert.equal(info.query, 'Mort Terry Pratchett');
  assert.equal(collection.describeFile('audio/Mort (audiobook).zip').query, 'Mort');

  // Two files of one Hardcover book become one title with two files.
  const book = collection.attach('Pratchett, Terry - Discworld 04 - Mort.epub', MORT);
  assert.equal(collection.attach('audio/Mort (audiobook).zip', MORT).id, book.id);
  list = collection.list('local');
  assert.equal(list.books.length, 1);
  assert.deepEqual(
    { title: list.books[0].title, hardcoverId: list.books[0].hardcoverId, series: list.books[0].series, formats: list.books[0].files.map((f) => f.format) },
    { title: 'Mort', hardcoverId: 104, series: { name: 'Discworld', position: 4 }, formats: ['epub', 'zip'] },
  );
  assert.ok(list.books[0].cover, 'a title from Hardcover has a cover to ask for');
  assert.deepEqual(list.loose.map((f) => f.name), ['Pratchett, Terry - Discworld 04 - Mort.mobi']);
  assert.deepEqual(collection.owned(), { 104: { id: book.id, formats: ['epub', 'zip'] } });

  // What was tied is remembered after a restart.
  const again = make();
  assert.equal(again.list('local').books[0].files.length, 2);
  const epub = again.list('local').books[0].files[0];
  assert.equal(again.fileOnDisk(epub.id).abs, path.join(downloadDir, 'Pratchett, Terry - Discworld 04 - Mort.epub'));

  // A renamed file keeps its title; a deleted one is shown as missing.
  fs.renameSync(path.join(downloadDir, 'Pratchett, Terry - Discworld 04 - Mort.epub'), path.join(downloadDir, 'Mort.epub'));
  fs.rmSync(path.join(downloadDir, 'audio/Mort (audiobook).zip'));
  again.scan({ force: true });
  const after = again.list('local').books[0].files;
  assert.deepEqual(after.map((f) => [f.name, f.missing]), [['Mort.epub', undefined], ['Mort (audiobook).zip', true]]);
  assert.equal(again.fileOnDisk(after[1].id), null);

  // Untying the last file takes the title out; the file itself stays.
  again.detach(after[1].id);
  again.detach(after[0].id);
  assert.deepEqual(again.list('local').books, []);
  assert.ok(fs.existsSync(path.join(downloadDir, 'Mort.epub')));
  assert.throws(() => again.detach('f999'), CollectionError);
});

test('a file can be added with its own details, and paths cannot leave the folder', (t) => {
  const { put, make, dataDir } = setup(t);
  put('practice.epub', makeEpub({ title: 'The Practice Book', author: 'Reader, Practice' }));
  put('notes.pdf', 'pdf');
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'outside the folder');
  const collection = make();

  const own = collection.attach('practice.epub');
  assert.deepEqual({ title: own.title, authors: own.authors, hardcoverId: own.hardcoverId }, { title: 'The Practice Book', authors: ['Practice Reader'], hardcoverId: null });
  const typed = collection.attach('notes.pdf', { title: 'My Notes', authors: ['Me'] });
  assert.equal(typed.title, 'My Notes');
  assert.equal(collection.list('local').books.length, 2);

  for (const bad of ['../secret.txt', '/etc/passwd', 'nope.epub', '', 'a\0b']) {
    assert.throws(() => collection.attach(bad), CollectionError, bad);
  }

  collection.remove(typed.id);
  assert.deepEqual(collection.list('local').books.map((b) => b.title), ['The Practice Book']);
  assert.deepEqual(collection.list('local').loose.map((f) => f.name), ['notes.pdf']);
});

test('a download asked for from a book is tied to it when it arrives', (t) => {
  const { put, make } = setup(t);
  const collection = make();
  const command = '!Bsk Pratchett, Terry - Discworld 04 - Mort.epub';
  collection.expect(command, 104, 'hc:4242');

  const facts = (id, account) => (id === 104 && account === 'hc:4242' ? MORT : null);
  assert.equal(collection.downloaded({ command: '!Bsk Something else.epub', file: 'Something else.epub' }, facts), null);

  put('Pratchett, Terry - Discworld 04 - Mort.epub', makeEpub({ title: 'Mort' }));
  let changes = 0;
  collection.onChange(() => { changes += 1; });
  const book = make().downloaded({ command, file: 'x' }, facts);
  assert.equal(book, null, 'a collection that was not told to expect it leaves the file alone');

  const tied = collection.downloaded({ command, file: 'Pratchett, Terry - Discworld 04 - Mort.epub' }, facts);
  assert.equal(tied.title, 'Mort');
  assert.equal(changes, 1);
  assert.equal(collection.downloaded({ command, file: 'Pratchett, Terry - Discworld 04 - Mort.epub' }, facts), null, 'only once');
  assert.equal(collection.list('hc:4242').books[0].hardcoverId, 104);
});

test('reading progress is kept per account, and the newest wins', (t) => {
  const { put, make } = setup(t);
  put('practice.epub', makeEpub());
  const collection = make();
  const book = collection.attach('practice.epub');
  const fileId = book.files[0].id;
  const now = Date.now();

  const first = collection.setProgress('hc:1', fileId, { fraction: 0.25, updatedAt: now - 5000, device: 'OnePlus 13', locator: { spine: 1, inner: 0.5, href: 'OEBPS/text/chapter-2.xhtml', junk: 'x' } });
  assert.deepEqual(first, { fraction: 0.25, locator: { spine: 1, href: 'OEBPS/text/chapter-2.xhtml', inner: 0.5 }, updatedAt: now - 5000, device: 'OnePlus 13', finished: undefined });

  // Something older (a phone that was offline) does not wind the book back.
  assert.equal(collection.setProgress('hc:1', fileId, { fraction: 0.1, updatedAt: now - 60000 }).fraction, 0.25);
  assert.equal(collection.setProgress('hc:1', fileId, { fraction: 0.4, updatedAt: now - 1000 }).fraction, 0.4);
  // A clock that runs ahead cannot claim the future.
  assert.ok(collection.setProgress('hc:1', fileId, { fraction: 1, updatedAt: now + 9e9 }).updatedAt <= Date.now());

  assert.equal(collection.list('hc:1').books[0].progress.fraction, 1);
  assert.equal(collection.list('hc:1').books[0].progress.finished, true);
  assert.equal(collection.list('hc:2').books[0].progress, undefined, 'someone else has their own place');
  assert.equal(make().getProgress('hc:1', fileId).fraction, 1, 'kept after a restart');

  assert.throws(() => collection.setProgress('hc:1', fileId, { fraction: 2 }), CollectionError);
  assert.throws(() => collection.setProgress('hc:1', 'f404', { fraction: 0.5 }), CollectionError);
});

test('a cover comes from Hardcover, or else from inside the epub', async (t) => {
  const asked = [];
  const { put, make } = setup(t, {
    fetchCover: async (url, stem) => {
      asked.push(url);
      if (url.includes('broken')) return null;
      fs.writeFileSync(`${stem}.jpg`, 'jpeg bytes');
      return { file: `${stem}.jpg`, type: 'image/jpeg' };
    },
  });
  put('mort.epub', makeEpub({ title: 'Mort' }));
  put('own.epub', makeEpub({ title: 'Own Cover' }));
  put('bare.epub', makeEpub({ title: 'No Cover', cover: false }));
  const collection = make();

  const mort = collection.attach('mort.epub', MORT);
  assert.equal((await collection.cover(mort.id)).type, 'image/jpeg');
  assert.equal((await collection.cover(mort.id)).type, 'image/jpeg');
  assert.deepEqual(asked, ['https://img.example/mort.jpg'], 'fetched once, then kept');

  const own = collection.attach('own.epub');
  const cover = await collection.cover(own.id);
  assert.equal(cover.type, 'image/png');
  assert.ok(fs.statSync(cover.file).size > 50);

  const fallback = collection.attach('own.epub', { hardcoverId: 7, title: 'Own Cover', authors: [], cover: 'https://img.example/broken.jpg' });
  assert.equal((await collection.cover(fallback.id)).type, 'image/png', 'when Hardcover has none, the epub is asked');

  const bare = collection.attach('bare.epub');
  assert.equal(collection.list('local').books.find((b) => b.id === bare.id).cover, undefined);
  assert.equal(await collection.cover(bare.id), null);
  assert.equal(await collection.cover('b404'), null);
});
