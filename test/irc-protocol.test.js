import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDccAddress, isPrivateAddress, matchKey, namesMatch, parseCtcp, parseDcc, parseDccAddress,
  parseLine, parseRequestCommand, sanitizeFilename, stripFormatting,
} from '../server/irc/protocol.js';

test('parseLine reads prefix, command and parameters', () => {
  const m = parseLine(':TrainFiles!bot@files.example PRIVMSG adrian :hello there\r\n');
  assert.equal(m.nick, 'TrainFiles');
  assert.equal(m.user, 'bot');
  assert.equal(m.host, 'files.example');
  assert.equal(m.command, 'PRIVMSG');
  assert.deepEqual(m.params, ['adrian', 'hello there']);

  assert.deepEqual(parseLine('PING :abc').params, ['abc']);
  assert.equal(parseLine('@time=2026 :irc.example 001 me :Welcome').command, '001');
  assert.deepEqual(parseLine(':s 353 me = #c :a b c').params, ['me', '=', '#c', 'a b c']);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine(':onlyprefix'), null);
});

test('formatting codes and control characters are removed', () => {
  assert.equal(stripFormatting('\x0304,01red\x03 \x02bold\x0f plain\x07'), 'red bold plain');
});

test('CTCP messages are recognised', () => {
  assert.deepEqual(parseCtcp('\x01VERSION\x01'), { command: 'VERSION', args: '' });
  assert.deepEqual(parseCtcp('\x01DCC SEND a 1 2 3\x01'), { command: 'DCC', args: 'SEND a 1 2 3' });
  assert.equal(parseCtcp('plain'), null);
});

test('DCC SEND with a quoted name', () => {
  assert.deepEqual(parseDcc('SEND "Aaron, Rachel - By a Silver Thread.zip" 3232235777 5000 320864256'), {
    type: 'send',
    filename: 'Aaron, Rachel - By a Silver Thread.zip',
    host: '192.168.1.1',
    port: 5000,
    size: 320864256,
    token: null,
    secure: false,
  });
});

test('DCC SEND with an unquoted name, with and without spaces', () => {
  assert.equal(parseDcc('SEND file_name.zip 1481729345 4000 99').filename, 'file_name.zip');
  const spaced = parseDcc('SEND Book 2 of 3.mp3 1481729345 4000 99');
  assert.equal(spaced.filename, 'Book 2 of 3.mp3');
  assert.equal(spaced.port, 4000);
  assert.equal(spaced.size, 99);
});

test('reverse DCC, secure DCC, literal addresses and missing sizes', () => {
  const reverse = parseDcc('SEND file.zip 1481729345 0 12345 77');
  assert.equal(reverse.port, 0);
  assert.equal(reverse.size, 12345);
  assert.equal(reverse.token, '77');
  assert.equal(parseDcc('SSEND file.zip 1481729345 4000 5').secure, true);
  assert.equal(parseDcc('SEND file.zip 2001:db8::1 4000 5').host, '2001:db8::1');
  assert.equal(parseDcc('SEND file.zip 88.81.1.1 4000 5').host, '88.81.1.1');
  assert.equal(parseDcc('SEND file.zip 1481729345 4000').size, 0);
});

test('malformed DCC is refused', () => {
  for (const text of ['SEND', 'SEND file.zip', 'SEND file.zip x y z', 'SEND file.zip 1481729345 70000 5', 'CHAT chat 1 2', '']) {
    assert.equal(parseDcc(text), null, text);
  }
});

test('DCC ACCEPT', () => {
  assert.deepEqual(parseDcc('ACCEPT file.ext 5000 4096'), {
    type: 'accept', filename: 'file.ext', port: 5000, position: 4096, token: null,
  });
  assert.equal(parseDcc('ACCEPT "a b.zip" 0 4096 77').token, '77');
});

test('DCC addresses convert both ways', () => {
  assert.equal(parseDccAddress('2130706433'), '127.0.0.1');
  assert.equal(formatDccAddress('127.0.0.1'), '2130706433');
  assert.equal(formatDccAddress('203.0.113.9'), '3405803785');
  assert.equal(parseDccAddress('99999999999'), null);
  assert.equal(parseDccAddress('not-an-ip'), null);
});

test('private addresses are told apart from public ones', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['88.81.1.1', '172.32.0.1', '8.8.8.8', '2001:db8::1']) {
    assert.equal(isPrivateAddress(a), false, a);
  }
});

test('file names cannot escape the download folder', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('..'), 'download');
  assert.equal(sanitizeFilename(''), 'download');
  assert.equal(sanitizeFilename('.hidden'), 'hidden');
  assert.equal(sanitizeFilename('what? a "book": part 1.mp3'), 'what_ a _book__ part 1.mp3');
  assert.equal(sanitizeFilename('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFilename('name\x00with\x1fcontrol.zip'), 'namewithcontrol.zip');
  assert.equal(sanitizeFilename('trailing dots... '), 'trailing dots');

  const long = sanitizeFilename(`${'é'.repeat(300)}.mp3`);
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith('.mp3'));
});

test('offered names are matched with requested names', () => {
  assert.equal(matchKey('Aaron,_Rachel_-_Café.ZIP'), 'aaronrachelcafezip');
  assert.equal(namesMatch('Aaron,_Rachel_-_By_a_Silver_Thread.zip', 'Aaron, Rachel - By a Silver Thread.zip'), true);
  assert.equal(namesMatch('By a Silver Thread (audiobook).zip', 'Aaron, Rachel - By a Silver Thread (audiobook).zip'), true);
  assert.equal(namesMatch('1 of 8.mp3', '2 of 8.mp3'), false);
  assert.equal(namesMatch('a.zip', 'Aaron, Rachel - a.zip'), false);
  assert.equal(namesMatch('', ''), false);
});

test('list commands name the bot and the file', () => {
  assert.deepEqual(parseRequestCommand('!TrainFiles f77467ded33c | Some Book (audiobook).zip'), {
    bot: 'TrainFiles', name: 'Some Book (audiobook).zip',
  });
  assert.deepEqual(parseRequestCommand('!Bsk Woods, Stuart - Stone Barrington 56 - Hush-Hush.epub'), {
    bot: 'Bsk', name: 'Woods, Stuart - Stone Barrington 56 - Hush-Hush.epub',
  });
  assert.deepEqual(parseRequestCommand('!Bot 1a2b3c4d5e6f Some Book.mp3'), { bot: 'Bot', name: 'Some Book.mp3' });
  assert.deepEqual(parseRequestCommand('!Bsk help me'), { bot: 'Bsk', name: '' });
  assert.deepEqual(parseRequestCommand('@search tolkien'), { bot: 'search', name: '' });
  assert.equal(parseRequestCommand('hello everyone'), null);
  assert.equal(parseRequestCommand('!'), null);
});
