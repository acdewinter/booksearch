// Load a list file from the command line:  npm run import -- path/to/list.txt
// Stop the server first; it only picks up the new database when it starts.

import fs from 'node:fs';
import path from 'node:path';
import { buildDatabase } from './build.js';
import { config } from './config.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- <list-file.txt>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

fs.mkdirSync(config.dataDir, { recursive: true });
const started = Date.now();
let lastPhase = '';
const stats = buildDatabase(file, config.buildPath, {
  sourceName: path.basename(file),
  onProgress: ({ phase, progress }) => {
    if (phase !== lastPhase || progress === 1) {
      lastPhase = phase;
      console.log(`${phase}… ${Math.round(progress * 100)}%`);
    }
  },
});

fs.copyFileSync(file, config.sourcePath);
fs.writeFileSync(config.sourceNamePath, path.basename(file));
fs.renameSync(config.buildPath, config.dbPath);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `Loaded ${stats.files.toLocaleString()} files in ${stats.folders.toLocaleString()} folders (${seconds}s).`,
);
if (stats.skippedLines) console.log(`${stats.skippedLines} lines were not recognised and were skipped.`);
