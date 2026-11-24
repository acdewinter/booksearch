import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KIND_ARCHIVE,
  KIND_AUDIO,
  KIND_OTHER,
  normalizeFolderPath,
  parseCommandLine,
  parseSize,
  readLines,
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
