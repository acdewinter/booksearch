import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KIND_ARCHIVE,
  KIND_AUDIO,
  KIND_EBOOK,
  KIND_OTHER,
  kindOf,
  normalizeFolderPath,
  parseCommandLine,
  parseSize,
  readLines,
  readList,
} from '../server/parse.js';

test('command is everything before ::INFO:: and ends with the extension', () => {
  const f = parseCommandLine(
    '!TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip ::INFO:: 306.00MB',
  );
  assert.equal(f.command, '!TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip');
  assert.equal(f.name, 'Aaron, Rachel - By a Silver Thread (audiobook).zip');
  assert.equal(f.command.slice(f.namePos), f.name);
  assert.equal(f.ext, 'zip');
  assert.equal(f.kind, KIND_ARCHIVE);
  assert.equal(f.sizeLabel, '306.00MB');
  assert.equal(f.sizeBytes, Math.round(306 * 1024 * 1024));
});

test('file names may contain pipes, braces and apostrophes', () => {
  const f = parseCommandLine("!TrainFiles abc123 | Show | Part 2 - 'Song' {AFRS}.MP3 ::INFO:: 4.65MB");
  assert.equal(f.name, "Show | Part 2 - 'Song' {AFRS}.MP3");
  assert.equal(f.ext, 'mp3');
  assert.equal(f.kind, KIND_AUDIO);
});

test('lines without a size are still commands', () => {
  const f = parseCommandLine('!TrainFiles abc123 | notes.txt');
  assert.equal(f.command, '!TrainFiles abc123 | notes.txt');
  assert.equal(f.kind, KIND_OTHER);
  assert.equal(f.sizeBytes, 0);
  const g = parseCommandLine('!TrainFiles abc123 | notes.txt ::INFO::');
  assert.equal(g.command, '!TrainFiles abc123 | notes.txt');
});

test('ebooks are main files; covers and notes are extras', () => {
  const f = parseCommandLine('!Bookworm 1a2b3c | Pratchett, Terry - Mort.EPUB ::INFO:: 412.10KB');
  assert.equal(f.ext, 'epub');
  assert.equal(f.kind, KIND_EBOOK);
  for (const ext of ['epub', 'mobi', 'azw3', 'pdf', 'djvu', 'fb2', 'lit', 'cbz', 'cbr', 'docx', 'rtf']) {
    assert.equal(kindOf(ext), KIND_EBOOK, ext);
  }
  for (const ext of ['jpg', 'txt', 'nfo', 'html', 'opf', 'exe', '']) assert.equal(kindOf(ext), KIND_OTHER, ext);
  assert.equal(kindOf('mp3'), KIND_AUDIO);
  assert.equal(kindOf('rar'), KIND_ARCHIVE);
  assert.ok(KIND_AUDIO < KIND_OTHER && KIND_ARCHIVE < KIND_OTHER && KIND_EBOOK < KIND_OTHER);
});

test('commands without an id or a bar keep their whole file name', () => {
  const f = parseCommandLine('!Bsk Terry Pratchett - [Discworld 04] - Mort (UK) (retail).epub ::INFO:: 918.2KB');
  assert.equal(f.name, 'Terry Pratchett - [Discworld 04] - Mort (UK) (retail).epub');
  assert.equal(f.command.slice(f.namePos), f.name);
  assert.equal(f.kind, KIND_EBOOK);
  assert.equal(parseCommandLine('!Bsk 13 Pitch Black Cats - Sister\'s War.epub').name, '13 Pitch Black Cats - Sister\'s War.epub');
  // An id after the bot's name is still left out of the file name.
  assert.equal(parseCommandLine('!Bot 1a2b3c4d5e6f Some Book.mp3').name, 'Some Book.mp3');
  assert.equal(parseCommandLine('!Bot #1234 Some Book.mp3').name, 'Some Book.mp3');
});

test('folder headings in both layouts are recognised', () => {
  assert.equal(normalizeFolderPath('+1New\\2024\\2024-12-16'), '/+1New/2024/2024-12-16');
  assert.equal(normalizeFolderPath('D:\\Books\\New '), '/D:/Books/New');
  assert.equal(normalizeFolderPath('/a/b\\c'), '/a/b\\c');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-list-'));
  const file = path.join(dir, 'list.txt');
  fs.writeFileSync(file, [
    'OmenServe v2.73',
    'To request a file, copy/paste to the channel... !Bsk FILENAME',
    '',
    '===============',
    '+1New\\2024\\2024',
    '===============',
    '!Bsk A A Abbott - Run For Your Lies.epub ::INFO:: 852.53KB',
    '',
    '=====',
    'eBooks',
    '=====',
    '!Bsk Another Book.mobi ::INFO:: 1.3MB',
    '/unix/style',
    '====',
    '!Bot 123 | third.mp3',
    'a stray note',
  ].join('\r\n'));
  const seen = [];
  readList(file, {
    folder: (p) => seen.push(['folder', p]),
    command: (line) => seen.push(['command', line.slice(0, 12)]),
    other: (line) => seen.push(['other', line.slice(0, 12)]),
  });
  assert.deepEqual(seen, [
    ['other', 'OmenServe v2'],
    ['other', 'To request a'],
    ['folder', '/+1New/2024/2024'],
    ['command', '!Bsk A A Abb'],
    ['folder', '/eBooks'],
    ['command', '!Bsk Another'],
    ['folder', '/unix/style'],
    ['command', '!Bot 123 | t'],
    ['other', 'a stray note'],
  ]);
});

test('non-command lines are rejected', () => {
  assert.equal(parseCommandLine('/audio1/Audio Books'), null);
  assert.equal(parseCommandLine('====='), null);
  assert.equal(parseCommandLine('!'), null);
});

test('sizes', () => {
  assert.equal(parseSize('764B'), 764);
  assert.equal(parseSize('1.5KB'), 1536);
  assert.equal(parseSize('1.32GB'), Math.round(1.32 * 1024 ** 3));
  assert.equal(parseSize('nonsense'), 0);
});

test('folder paths are tidied', () => {
  assert.equal(normalizeFolderPath('/a/b/'), '/a/b');
  assert.equal(normalizeFolderPath('/a//b  '), '/a/b');
  assert.equal(normalizeFolderPath('/'), '/');
});

test('readLines copes with CRLF, a BOM, a missing final newline and non-UTF-8 bytes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-')), 'list.txt');
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('/dir\r\n!T 1 | café.mp3\r\n', 'utf8'),
    Buffer.from('!T 2 | S'),
    Buffer.from([0xe4]), // "ä" in Windows-1252, invalid as UTF-8
    Buffer.from('nger.mp3'),
  ]);
  fs.writeFileSync(file, bytes);
  const lines = [];
  readLines(file, (line) => lines.push(line));
  assert.deepEqual(lines, ['/dir', '!T 1 | café.mp3', '!T 2 | Sänger.mp3']);
});
