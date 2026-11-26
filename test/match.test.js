import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../server/build.js';
import { Library } from '../server/library.js';
import { authorName, bookQueries, pickQueries, titleVariants, words } from '../server/match.js';

const fixture = fileURLToPath(new URL('./fixtures/sample-list.txt', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-match-'));
const dbPath = path.join(dir, 'library.db');
buildDatabase(fixture, dbPath);
const library = new Library(dbPath);
library.open();
test.after(() => {
  library.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const find = (book) => pickQueries(bookQueries(book), (q) => library.count({ q }));
const first = (book) => bookQueries(book)[0].q;

test('words drop punctuation, accents and possessives', () => {
  assert.deepEqual(words("Ender's Game"), ['ender', 'game']);
  assert.deepEqual(words('Les Misérables'), ['les', 'miserables']);
  assert.deepEqual(words("O'Brien"), ['brien']);
  assert.deepEqual(words('Catch-22'), ['catch', '22']);
  assert.deepEqual(words('Jo Nesbø'), ['jo', 'nesb'], 'a letter the index keeps is cut off, so both spellings match');
});

test('titles lose their brackets and split at a colon', () => {
  assert.deepEqual(titleVariants('The Final Empire (Mistborn, #1)'), [['final', 'empire']]);
  assert.deepEqual(titleVariants('Mistborn: The Final Empire'), [['mistborn', 'final', 'empire'], ['mistborn'], ['final', 'empire']]);
  assert.deepEqual(titleVariants('It'), [['it']], 'a title of nothing but small words keeps them');
});

test('authors are reduced to the surname files carry', () => {
  assert.deepEqual(authorName('Brandon Sanderson'), { last: 'sanderson', first: 'brandon' });
  assert.deepEqual(authorName('J.R.R. Tolkien'), { last: 'tolkien', first: '' });
  assert.deepEqual(authorName('Le Guin, Ursula K.'), { last: 'guin', first: 'ursula' });
  assert.deepEqual(authorName('Martin Luther King Jr.'), { last: 'king', first: 'martin' });
  assert.equal(authorName(''), null);
});

test('the first search is the surname and the telling words of the title', () => {
  assert.equal(first({ title: 'The Final Empire', authors: ['Brandon Sanderson'] }), 'sanderson final empire');
  assert.equal(first({ title: "Ender's Game", authors: ['Orson Scott Card'] }), 'card ender game');
  assert.equal(first({ title: 'It', authors: ['Stephen King'] }), 'king "it"', 'short words are matched whole');
  assert.equal(first({ title: '1984', authors: ['George Orwell'] }), 'orwell "1984"');
  assert.equal(first({ title: 'Untitled', authors: [] }), 'untitled');
});

test('a book is found whichever way its file is named', () => {
  // "Aaron, Rachel - Heartstrikers 01 - Nice Dragons Finish Last (audiobook).zip"
  const dragons = find({ title: 'Nice Dragons Finish Last', authors: ['Rachel Aaron'], series: { name: 'Heartstrikers' } });
  assert.equal(dragons.best, 'aaron nice dragons finish last');
  assert.deepEqual(dragons.queries.map((q) => [q.kind, q.files]), [['book', 1], ['title', 1], ['series', 2], ['author', 3]]);

  // The author and title are only in the folders: ".../Charles Dickens/David Copperfield/1 of 8.mp3"
  assert.equal(find({ title: 'David Copperfield', authors: ['Charles Dickens'] }).queries[0].files, 2);

  // Hardcover has the article, the file does not: "Albom, Mitch - Five People You Meet in Heaven.mp3"
  assert.equal(find({ title: 'The Five People You Meet in Heaven', authors: ['Mitch Albom'] }).queries[0].files, 1);
});

test('a subtitle after a colon does not stand in the way', () => {
  const r = find({ title: 'Mort: A Discworld Novel', authors: ['Terry Pratchett'] });
  assert.equal(r.best, 'pratchett mort');
  assert.equal(r.queries.find((q) => q.q === r.best).files, 2);
});

test('the co-author is tried when the first author finds nothing', () => {
  const r = find({ title: 'Mort', authors: ['Neil Gaiman', 'Terry Pratchett'] });
  assert.equal(r.best, 'pratchett mort');
});

test('another title of the same book is tried too', () => {
  const r = find({ title: 'Gevatter Tod', authors: ['Terry Pratchett'], otherTitles: ['Mort'] });
  assert.equal(r.best, 'pratchett mort');
});

test('a book that is not there says so, and still offers the author', () => {
  const r = find({ title: 'Small Gods', authors: ['Terry Pratchett'], series: { name: 'Discworld' } });
  assert.equal(r.best, null);
  assert.deepEqual(r.queries.map((q) => [q.kind, q.q, q.files]), [
    ['book', 'pratchett small gods', 0],
    ['series', 'pratchett discworld', 2],
    ['author', 'pratchett terry', 2],
  ]);
});

test('every search can be read by the search box', () => {
  for (const book of [
    { title: 'Good Omens: The Nice and Accurate Prophecies of Agnes Nutter, Witch', authors: ['Terry Pratchett', 'Neil Gaiman'] },
    { title: '"Surely You\'re Joking, Mr. Feynman!"', authors: ['Richard P. Feynman'] },
    { title: '!!!', authors: ['???'] },
  ]) {
    for (const query of bookQueries(book)) {
      assert.doesNotThrow(() => library.count({ q: query.q }));
      assert.ok(query.q.split(' ').length <= 12, query.q);
    }
  }
});
