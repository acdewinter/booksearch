// End to end: the manager connects to a fake IRC server, asks its bot for
// files, and receives them over DCC.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileBytes, startFakeIrc } from '../dev/fake-irc.js';
import { IrcManager, UserError } from '../server/irc/manager.js';

const COMMAND = '!TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip';
const NAME = 'Aaron, Rachel - By a Silver Thread (audiobook).zip';

/** Wait until check() returns something truthy. */
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function setup(t, { server = {}, settings = {}, manager: managerOptions = {} } = {}) {
  const fake = await startFakeIrc(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-irc-'));
  const downloadDir = path.join(dir, 'downloads');
  const manager = new IrcManager({ dataDir: dir, downloadDir, version: 'test', ...managerOptions });
  const events = [];
  manager.on('event', (name, payload) => events.push({ name, payload }));
  manager.start();
  manager.saveSettings({
    host: '127.0.0.1', port: fake.port, tls: false, nick: 'adrian', channel: '#books',
    allowPrivate: true, sendIntervalSec: 2, ...settings,
  });
  t.after(async () => {
    manager.shutdown();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const item = (command = COMMAND) => manager.snapshot().items.find((i) => i.command === command);
  const online = () => until(() => manager.snapshot().conn.channel.joined && manager.snapshot().conn.channel.people >= 3, 'joining the channel');
  const done = (command) => until(() => {
    const it = item(command);
    if (it?.status === 'failed') throw new Error(`Download failed: ${it.error}`);
    return it?.status === 'done' && it;
  }, 'the download');
  // Skip the "undo" delay so tests do not wait for it.
  const request = (commands) => {
    const out = manager.request(commands);
    for (const it of manager.items.values()) it.notBefore = 0;
    return out;
  };
  return { fake, manager, events, dir, downloadDir, item, online, done, request };
}

test('connects, joins, requests a file and receives it', async (t) => {
  const size = 300_000;
  const { fake, manager, downloadDir, online, done, request } = await setup(t, { server: { sizeOf: () => size } });
  manager.connect();
  await online();

  const snap = manager.snapshot();
  assert.equal(snap.conn.status, 'online');
  assert.equal(snap.conn.nick, 'adrian');
  assert.equal(snap.conn.network, 'FakeNet');
  assert.equal(snap.conn.channel.topic, 'Be nice. One request at a time.');

  const [queued] = request([COMMAND]);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.bot, 'TrainFiles');
  assert.equal(queued.name, NAME);

  const item = await done();
  assert.equal(item.file, NAME);
  assert.equal(item.size, size);
  assert.equal(item.received, size);
  assert.ok(fake.lines.includes(`PRIVMSG #books :${COMMAND}`), 'the command went to the channel');
  assert.deepEqual(fs.readFileSync(path.join(downloadDir, NAME)), fileBytes(0, size));
  assert.equal(fs.existsSync(path.join(downloadDir, `${NAME}.part`)), false);
  assert.equal(manager.snapshot().conn.bots.TrainFiles, true);
});

test('names announced with underscores still match the request', async (t) => {
  const { manager, downloadDir, online, done, request } = await setup(t, { server: { underscores: true } });
  manager.connect();
  await online();
  request([COMMAND]);
  const item = await done();
  assert.equal(item.file, NAME.replace(/ /g, '_'));
  assert.ok(fs.existsSync(path.join(downloadDir, item.file)));
  assert.equal(manager.snapshot().items.length, 1, 'no second entry for the same file');
});

test('requests go out one at a time and the same command is not queued twice', async (t) => {
  const second = '!TrainFiles 5a82ab608cc8 | Aaron, Rachel - With a Golden Sword (audiobook).zip';
  const { fake, manager, online, done, request, item } = await setup(t, { server: { chunkDelayMs: 2 } });
  manager.connect();
  await online();

  request([COMMAND, second]);
  const again = request([COMMAND]);
  assert.equal(again[0].already, true);
  assert.equal(manager.snapshot().items.length, 2);

  await until(() => item(COMMAND)?.status === 'downloading', 'the first download to start');
  assert.equal(item(second).status, 'queued', 'the second waits for the first');
  assert.equal(fake.lines.filter((l) => l.startsWith('PRIVMSG #books :!')).length, 1);

  await done(COMMAND);
  await done(second);
  assert.equal(fake.lines.filter((l) => l.startsWith('PRIVMSG #books :!')).length, 2);
});

test('an interrupted download continues where it stopped', async (t) => {
  const size = 400_000;
  const { fake, manager, downloadDir, online, done, request, item } = await setup(t, { server: { sizeOf: () => size } });
  manager.connect();
  await online();

  fake.dropNextAfter(150_000);
  request([COMMAND]);
  const failed = await until(() => item()?.status === 'failed' && item(), 'the transfer to break');
  assert.match(failed.error, /closed the connection at 37%/);
  assert.equal(fs.statSync(path.join(downloadDir, `${NAME}.part`)).size, 150_000);

  let resumedFrom = null;
  fake.events.once('resume', (position) => {
    resumedFrom = position;
  });
  manager.act(failed.id, 'retry');
  const finished = await done();
  assert.equal(resumedFrom, 150_000);
  assert.equal(finished.received, size);
  assert.deepEqual(fs.readFileSync(path.join(downloadDir, NAME)), fileBytes(0, size));
});

test('a sender that ignores resume gets the whole file again', async (t) => {
  const size = 200_000;
  const { manager, downloadDir, online, done, request } = await setup(t, {
    server: { sizeOf: () => size, resume: false },
    manager: { resumeTimeoutMs: 400 },
  });
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.writeFileSync(path.join(downloadDir, `${NAME}.part`), Buffer.alloc(50_000, 1)); // wrong bytes on purpose
  manager.connect();
  await online();
  request([COMMAND]);
  await done();
  assert.deepEqual(fs.readFileSync(path.join(downloadDir, NAME)), fileBytes(0, size));
});

test('a file that is already in the folder is not downloaded again', async (t) => {
  const size = 120_000;
  const { manager, downloadDir, online, done, request } = await setup(t, { server: { sizeOf: () => size } });
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.writeFileSync(path.join(downloadDir, NAME), Buffer.alloc(size, 9));
  manager.connect();
  await online();
  request([COMMAND]);
  const item = await done();
  assert.equal(item.note, 'already');
  assert.deepEqual(fs.readFileSync(path.join(downloadDir, NAME)), Buffer.alloc(size, 9), 'the existing file is untouched');
});

test('a different file with the same name is kept next to the old one', async (t) => {
  const { manager, downloadDir, online, done, request } = await setup(t);
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.writeFileSync(path.join(downloadDir, NAME), 'older, different file');
  manager.connect();
  await online();
  request([COMMAND]);
  const item = await done();
  assert.equal(item.file, 'Aaron, Rachel - By a Silver Thread (audiobook) (2).zip');
  assert.equal(fs.readFileSync(path.join(downloadDir, NAME), 'utf8'), 'older, different file');
});

test('files from strangers wait for a decision, and never leave the download folder', async (t) => {
  const { fake, manager, downloadDir, dir, online } = await setup(t);
  manager.connect();
  await online();

  fake.offer('stranger', '../../escape.txt', 5000);
  const offered = await until(() => manager.snapshot().items.find((i) => i.status === 'offered'), 'the offer');
  assert.equal(offered.name, 'escape.txt');
  assert.equal(offered.bot, 'stranger');
  assert.equal(fs.existsSync(path.join(downloadDir, 'escape.txt.part')), false, 'nothing is fetched before accepting');

  manager.act(offered.id, 'accept');
  await until(() => manager.snapshot().items.find((i) => i.id === offered.id)?.status === 'done', 'the accepted file');
  assert.ok(fs.existsSync(path.join(downloadDir, 'escape.txt')));
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);

  fake.offer('stranger', 'second.txt', 5000);
  const second = await until(() => manager.snapshot().items.find((i) => i.status === 'offered'), 'the second offer');
  manager.act(second.id, 'cancel');
  assert.equal(manager.snapshot().items.some((i) => i.id === second.id), false);
});

test('trusted nicknames are accepted without asking', async (t) => {
  const { fake, manager, downloadDir, online } = await setup(t, { settings: { trustedNicks: 'friend, other' } });
  manager.connect();
  await online();
  fake.offer('Friend', 'gift.zip', 4096);
  await until(() => manager.snapshot().items.find((i) => i.name === 'gift.zip')?.status === 'done', 'the gift');
  assert.deepEqual(fs.readFileSync(path.join(downloadDir, 'gift.zip')), fileBytes(0, 4096));
});

test('offers from private addresses are refused unless allowed', async (t) => {
  const { manager, online, request, item } = await setup(t, { settings: { allowPrivate: false } });
  manager.connect();
  await online();
  request([COMMAND]);
  const failed = await until(() => item()?.status === 'failed' && item(), 'the refusal');
  assert.match(failed.error, /private network/);
});

test('requests are held while the bot is away, and sent when it joins', async (t) => {
  const { fake, manager, online, done, request, item } = await setup(t, { server: { botPresent: false } });
  manager.connect();
  await until(() => manager.snapshot().conn.channel.joined && manager.snapshot().conn.channel.people >= 3, 'joining');
  await online();

  request([COMMAND]);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(item().status, 'queued');
  assert.equal(manager.snapshot().conn.bots.TrainFiles, false);
  assert.equal(fake.lines.some((l) => l.includes('!TrainFiles')), false);

  fake.botJoin();
  await done();
});

test('reverse DCC: the sender connects to a port this app opens', async (t) => {
  const size = 150_000;
  const { fake, manager, downloadDir, online, done, request } = await setup(t, {
    server: { reverse: true, sizeOf: () => size },
    manager: { dccPorts: { min: 47310, max: 47330 }, dccPublicIp: '127.0.0.1' },
  });
  manager.connect();
  await online();
  request([COMMAND]);
  await done();
  assert.deepEqual(fs.readFileSync(path.join(downloadDir, NAME)), fileBytes(0, size));
  const reply = fake.lines.find((l) => /DCC SEND .* 2130706433 473\d\d 150000 \d+/.test(l));
  assert.ok(reply, 'the app told the sender where to connect');
});

test('reverse DCC is explained when no port is configured', async (t) => {
  const { manager, online, request, item } = await setup(t, { server: { reverse: true } });
  manager.connect();
  await online();
  request([COMMAND]);
  const failed = await until(() => item()?.status === 'failed' && item(), 'the refusal');
  assert.match(failed.error, /DCC_PORTS/);
});

test('cancelling a running download removes the partial file', async (t) => {
  const { manager, downloadDir, online, request, item } = await setup(t, {
    server: { sizeOf: () => 5_000_000, chunkDelayMs: 5 },
  });
  manager.connect();
  await online();
  request([COMMAND]);
  const running = await until(() => item()?.status === 'downloading' && item().received > 0 && item(), 'the download to start');
  manager.act(running.id, 'cancel');
  assert.equal(item().status, 'cancelled');
  await until(() => !fs.existsSync(path.join(downloadDir, `${NAME}.part`)), 'the partial file to go');
  manager.act(running.id, 'remove');
  assert.equal(manager.snapshot().items.length, 0);
});

test('reconnects after losing the connection, and stays offline when asked', async (t) => {
  const { fake, manager, online } = await setup(t);
  manager.connect();
  await online();

  fake.dropClients();
  await until(() => manager.snapshot().conn.status === 'retrying', 'the retry to be planned');
  assert.ok(manager.snapshot().conn.retryAt > Date.now());
  assert.match(manager.snapshot().conn.error, /lost|closed/);
  await until(() => manager.snapshot().conn.status === 'online' && manager.snapshot().conn.channel.joined, 'coming back', 12_000);

  manager.disconnect();
  await until(() => manager.snapshot().conn.status === 'offline', 'going offline');
  assert.ok(fake.lines.some((l) => l.startsWith('QUIT')));
}, { timeout: 30_000 });

test('picks another nickname when the first is taken, and signs in with SASL', async (t) => {
  const { fake, manager, online } = await setup(t, {
    server: { takenNicks: ['adrian'], sasl: true },
    settings: { accountPassword: 'hunter2' },
  });
  manager.connect();
  await online();
  assert.equal(manager.snapshot().conn.nick, 'adrian_');
  const auth = fake.lines.find((l) => l.startsWith('AUTHENTICATE ') && l !== 'AUTHENTICATE PLAIN');
  assert.equal(Buffer.from(auth.split(' ')[1], 'base64').toString(), 'adrian\0adrian\0hunter2');
  assert.equal(fake.lines.some((l) => l.includes('NickServ')), false);
});

test('falls back to NickServ without SASL, and a failed join is reported', async (t) => {
  const { fake, manager } = await setup(t, {
    server: { joinError: 475 },
    settings: { accountPassword: 'hunter2' },
  });
  manager.connect();
  await until(() => manager.snapshot().conn.channel.error, 'the join error', 12_000);
  assert.match(manager.snapshot().conn.channel.error, /key/);
  assert.equal(manager.snapshot().conn.channel.joined, false);
  assert.ok(fake.lines.includes('PRIVMSG NickServ :IDENTIFY hunter2'));
  // The password never shows up in what the page gets to see.
  assert.equal(JSON.stringify(manager.snapshot()).includes('hunter2'), false);
});

test('settings are checked, and passwords are never handed back', async (t) => {
  const { manager, dir } = await setup(t);
  assert.throws(() => manager.saveSettings({ nick: '9lives' }), (err) => err instanceof UserError && Boolean(err.fields.nick));
  assert.throws(() => manager.saveSettings({ port: 99999 }), UserError);
  assert.throws(() => manager.saveSettings({ channel: 'two words' }), UserError);

  const saved = manager.saveSettings({ host: 'ircs://irc.example.net:7000/', channel: 'books', serverPassword: 'secret' });
  assert.equal(saved.host, 'irc.example.net');
  assert.equal(saved.port, 7000);
  assert.equal(saved.channel, '#books');
  assert.equal(saved.hasServerPassword, true);
  assert.equal('serverPassword' in saved, false);

  // Leaving the password out keeps it; an empty one removes it.
  assert.equal(manager.saveSettings({ nick: 'adrian2' }).hasServerPassword, true);
  assert.equal(manager.saveSettings({ serverPassword: '' }).hasServerPassword, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'irc-settings.json'), 'utf8')).nick, 'adrian2');
});

test('only list commands can be requested, and messages cannot smuggle extra lines', async (t) => {
  const { fake, manager, online } = await setup(t);
  assert.throws(() => manager.request(['hello channel']), UserError);
  assert.throws(() => manager.request([]), UserError);
  assert.throws(() => manager.say('hi'), /Not connected/);

  manager.connect();
  await online();
  manager.say('hello\r\nQUIT :oops');
  manager.say('/msg TrainFiles are you there?');
  assert.throws(() => manager.say('/dance'), UserError);
  await until(() => fake.lines.includes('PRIVMSG TrainFiles :are you there?'), 'the private message');
  assert.ok(fake.lines.includes('PRIVMSG #books :hello QUIT :oops'));
  assert.equal(fake.lines.some((l) => l.startsWith('QUIT')), false);
});

test('the queue survives a restart', async (t) => {
  const { manager, dir, downloadDir } = await setup(t);
  manager.request([COMMAND]);
  manager.shutdown();

  const next = new IrcManager({ dataDir: dir, downloadDir, version: 'test' });
  next.start();
  const snap = next.snapshot();
  next.shutdown();
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].command, COMMAND);
  assert.equal(snap.items[0].status, 'queued');
  assert.equal(snap.settings.nick, 'adrian');
  assert.equal(snap.conn.status, 'offline');
});
