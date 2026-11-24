import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

const number = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
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
  sourcePath: path.join(dataDir, 'source.txt'),
  sourceNamePath: path.join(dataDir, 'source.name'), // original file name of source.txt
  uploadPath: path.join(dataDir, 'upload.tmp'),
};
