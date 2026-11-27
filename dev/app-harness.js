// Starts the whole app the way `npm start` does, with the practice Hardcover
// behind it, for the tests that go through the web API.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../server/build.js';
import { startFakeHardcover } from './fake-hardcover.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('../test/fixtures/sample-list.txt', import.meta.url));

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** A browser's worth of behaviour: it keeps cookies and can follow redirects. */
export function visitor(base) {
  const jar = new Map();
  async function request(url, options = {}) {
    const target = new URL(url, base);
    const headers = { ...(options.headers || {}) };
    // Cookies belong to the app; the practice Hardcover never sees them.
    if (target.origin === base && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(target, { ...options, headers, redirect: 'manual' });
    if (target.origin === base) {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        if (attrs.some((a) => /^\s*Max-Age=0$/i.test(a))) jar.delete(pair.slice(0, eq));
        else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    return res;
  }
  return {
    jar,
    get: (url) => request(url),
    json: async (url) => (await request(url)).json(),
    post: (url, body = {}, headers = {}) => request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
      body: JSON.stringify(body),
    }),
    /** Follow redirects to the end, as a browser would. Returns the last address. */
    async follow(url) {
      let next = new URL(url, base);
      for (let i = 0; i < 8; i += 1) {
        const res = await request(next);
        await res.arrayBuffer();
        if (res.status < 300 || res.status >= 400) return next;
        next = new URL(res.headers.get('location'), next);
      }
      throw new Error('too many redirects');
    },
  };
}

export async function startApp(t, env = {}, fakeOptions = {}) {
  const fake = await startFakeHardcover(fakeOptions);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfmark-app-'));
  buildDatabase(fixture, path.join(dataDir, 'library.db'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      HARDCOVER_CLIENT_ID: 'practice',
      HARDCOVER_CLIENT_SECRET: 'practice',
      HARDCOVER_API_URL: fake.url,
      HARDCOVER_WEB_URL: fake.url,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; ; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (i > 200) throw new Error(`The app did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 25));
  }

  async function library(v) {
    for (let i = 0; i < 400; i += 1) {
      const data = await v.json('/api/hardcover/library');
      if (data.syncedAt && !data.sync.running) return data;
      if (data.sync?.error) throw new Error(data.sync.error);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('The library was never synced.');
  }
  return { fake, base, dataDir, library, visit: () => visitor(base), output: () => output };
}
