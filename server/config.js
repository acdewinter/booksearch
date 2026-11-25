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

export const config = {
  version,
  root,
  publicDir: path.join(root, 'public'),
  dataDir,
  port: number(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  maxUploadBytes: number(process.env.MAX_UPLOAD_MB, 512) * 1024 * 1024,
  // Optional sign-in for the whole app (HTTP Basic). Empty = no sign-in.
  username: process.env.APP_USERNAME || '',
  password: process.env.APP_PASSWORD || '',

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
