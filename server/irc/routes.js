// The /api/irc/* endpoints, and the live event stream the page listens to.

import { UserError } from './manager.js';

const MAX_BODY = 256 * 1024;
const MAX_STREAMS = 40;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new UserError('That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new UserError('The request could not be read.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('./manager.js').IrcManager} manager
 * @param {object} http helpers from the web server: sendJson, sendError, sameOrigin
 */
export function createIrcRoutes(manager, { sendJson, sendError, sameOrigin }) {
  const streams = new Set();

  manager.on('event', (name, payload) => {
    if (!streams.size) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of streams) res.write(frame);
  });

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 20_000);
  heartbeat.unref();

  function openStream(req, res) {
    if (streams.size >= MAX_STREAMS) return sendError(req, res, 503, 'Too many open pages. Close a few tabs.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify(manager.snapshot())}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return undefined;
  }

  const actions = {
    connect: () => manager.connect(),
    disconnect: () => manager.disconnect(),
    join: () => manager.rejoin(),
    settings: (body) => ({ settings: manager.saveSettings(body) }),
    request: (body) => ({ items: manager.request(body.commands) }),
    act: (body) => manager.act(body.id, body.action),
    clear: () => manager.clearFinished(),
    say: (body) => manager.say(body.text),
  };

  /** Returns true when the request was for this part of the API. */
  function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/irc/')) return false;
    const name = url.pathname.slice('/api/irc/'.length);

    if (req.method === 'GET') {
      if (name === 'events') openStream(req, res);
      else if (name === 'state') sendJson(req, res, 200, manager.snapshot());
      else sendError(req, res, 404, 'Not found.');
      return true;
    }
    if (req.method !== 'POST') {
      sendError(req, res, 405, 'Method not allowed.');
      return true;
    }
    const action = Object.hasOwn(actions, name) ? actions[name] : null;
    if (!action) {
      req.resume();
      sendError(req, res, 404, 'Not found.');
      return true;
    }
    // These change things and talk to other people, so they must come from this app's own page.
    if (!sameOrigin(req) || !/^application\/json/i.test(req.headers['content-type'] || '')) {
      req.resume();
      sendError(req, res, 403, 'This is only accepted from the app itself.');
      return true;
    }

    readBody(req)
      .then((body) => sendJson(req, res, 200, { ok: true, ...(action(body) || {}) }))
      .catch((err) => {
        if (err instanceof UserError) {
          sendJson(req, res, 400, { error: err.message, fields: err.fields || undefined });
        } else {
          console.error(err);
          sendError(req, res, 500, 'Something went wrong on the server.');
        }
      });
    return true;
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of streams) res.end();
    streams.clear();
  }

  return { handle, close };
}
