// Runs the database build off the main thread so searches keep working
// while a new list is being loaded.

import { parentPort, workerData } from 'node:worker_threads';
import { buildDatabase } from './build.js';

try {
  const stats = buildDatabase(workerData.sourcePath, workerData.outPath, {
    sourceName: workerData.sourceName,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
  });
  parentPort.postMessage({ type: 'done', stats });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err?.message || String(err) });
}
