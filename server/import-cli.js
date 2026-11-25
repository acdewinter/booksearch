// Load list files from the command line:
//
//   npm run import -- path/to/list.txt [another-list.txt ...]
//
// A file whose name matches a list that is already loaded (ignoring dates)
// replaces that list; any other file is added as a new list.
// Stop the server first; it only picks up the new database when it starts.

import fs from 'node:fs';
import path from 'node:path';
import { buildDatabase } from './build.js';
import { config } from './config.js';
import { ListStore, nameFromFile } from './lists.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run import -- <list-file.txt> [more-list-files.txt ...]');
  process.exit(1);
}
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
}

fs.mkdirSync(config.dataDir, { recursive: true });
const store = new ListStore(config.dataDir);
store.load();

const changes = { add: [], replace: [] };
for (const file of files) {
  const fileName = path.basename(file);
  const name = nameFromFile(fileName);
  const staged = store.stage();
  fs.copyFileSync(file, staged.path);
  const existing = store.lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  const taken = existing && changes.replace.some((r) => r.id === existing.id);
  if (existing && !taken) {
    changes.replace.push({ token: staged.token, id: existing.id, fileName });
    console.log(`${fileName}: replaces the list "${existing.name}"`);
  } else {
    changes.add.push({ token: staged.token, name, fileName });
    console.log(`${fileName}: added as a new list`);
  }
}

const started = Date.now();
const plan = store.plan(changes);
let lastPhase = '';
let stats;
try {
  stats = buildDatabase(plan.sources, config.buildPath, {
    key: plan.key,
    onProgress: ({ phase, progress }) => {
      if (phase !== lastPhase || progress === 1) {
        lastPhase = phase;
        console.log(`${phase}… ${Math.round(progress * 100)}%`);
      }
    },
  });
} catch (err) {
  plan.discard();
  console.error(err.message);
  process.exit(1);
}

fs.renameSync(config.buildPath, config.dbPath);
plan.commit(stats.lists);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `Loaded ${stats.files.toLocaleString()} files in ${stats.folders.toLocaleString()} folders from ${stats.lists.length} list${stats.lists.length === 1 ? '' : 's'} (${seconds}s).`,
);
if (stats.skippedLines) console.log(`${stats.skippedLines} lines were not recognised and were skipped.`);
