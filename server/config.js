import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

const number = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** "50000-50010" or "50000" -> { min, max }. Anything else: reverse DCC stays off. */
function portRange(value) {
  const m = /^s*(d{1,5})(?:s*-s*(d{1,5}))?s*$/.exec(value || '');
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2] ?? m[1]);
  if (min < 1024 || max > 65535 || max < min) return null;
  return { min, max: Math.min(max, min + 99) };
}

let version = '';
try {
  version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '';
} catch {
  // not important
}

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

/** "adrian, Someone Else" -> ['adrian', 'someone else'] */
const nameList = (value) => String(value || '').split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);

export const config = {
  version,
  root,
  publicDir: path.join(root, 'public'),
  dataDir,
  port: number(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  maxUploadBytes: number(process.env.MAX_UPLOAD_MB, 512) * 1024 * 1024,
  // The address people open the app at, such as https://books.example.com.
  // Empty = taken from each request (fine behind most proxies).
  appUrl: trimSlash(process.env.APP_URL),
  // Optional sign-in with a password. Empty = no password sign-in.
  username: process.env.APP_USERNAME || '',
  password: process.env.APP_PASSWORD || '',

  // Sign in with Hardcover (an OAuth app made at hardcover.app/account/developer-apps).
  hardcover: {
    clientId: (process.env.HARDCOVER_CLIENT_ID || '').trim(),
    clientSecret: (process.env.HARDCOVER_CLIENT_SECRET || '').trim(),
    // Hardcover usernames that may sign in. Empty = the first account to sign in owns the app.
    allowedUsers: nameList(process.env.HARDCOVER_ALLOWED_USERS),
    scopes: (process.env.HARDCOVER_SCOPES || 'read:me:content read:library read:lists').trim(),
    // Only changed to point the app at the practice server in dev/fake-hardcover.js.
    apiUrl: trimSlash(process.env.HARDCOVER_API_URL) || 'https://api.hardcover.app',
    webUrl: trimSlash(process.env.HARDCOVER_WEB_URL) || 'https://hardcover.app',
  },

  dbPath: path.join(dataDir, 'library.db'),
  buildPath: path.join(dataDir, 'library.build.db'),
  // The list files themselves live in <dataDir>/lists (see server/lists.js).
  uploadPath: path.join(dataDir, 'upload.tmp'), // left behind by older versions

  // Where files received over DCC end up.
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR || path.join(dataDir, 'downloads')),
  // Only needed for senders behind a firewall: ports this app may accept
  // connections on, and this machine's public address.
  dccPorts: portRange(process.env.DCC_PORTS),
  dccPublicIp: net.isIP(process.env.DCC_PUBLIC_IP || '') ? process.env.DCC_PUBLIC_IP : '',
};
