// Runs the reader app's page engine (android/app/src/main/assets/reader) in an
// ordinary browser, against a real epub, so paging, themes and type can be
// tried without a phone.
//
//   node dev/reader-harness.js path/to/book.epub [port]
//
// Then open http://localhost:4020 and make the window phone-sized, or open
// http://localhost:4020/phone for the book in a phone-sized frame.
// Keys: ←/→ turn pages · t theme · f typeface · +/- size · j alignment · l line height · s slide
//
// It stands in for the app the same way the app works: every chapter is sent
// with reader.css and reader.js added to its head, and a small script plays
// the part of `ShelfmarkHost`.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip } from '../server/zip.js';

const assets = fileURLToPath(new URL('../android/app/src/main/assets/reader/', import.meta.url));
const TYPES = {
  '.xhtml': 'application/xhtml+xml', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ncx': 'application/xml',
};

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));

export function startHarness(file, port = 4020) {
  const zip = Zip.open(file);
  const container = zip.read(zip.find('META-INF/container.xml')).toString('utf8');
  const opfPath = attrs(/<rootfile\b[^>]*>/i.exec(container)[0])['full-path'];
  const opf = zip.read(opfPath).toString('utf8');
  const base = path.posix.dirname(opfPath) === '.' ? '' : `${path.posix.dirname(opfPath)}/`;
  const items = new Map([...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => attrs(m[0])).map((a) => [a.id, a]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map((m) => items.get(attrs(m[0]).idref)).filter(Boolean)
    .map((item) => path.posix.normalize(base + decodeURIComponent(item.href)));

  const hostScript = `
(function () {
  var spine = ${JSON.stringify(spine)};
  var here = decodeURIComponent(location.pathname.replace(/^\\/book\\//, ''));
  var index = spine.indexOf(here);
  var THEMES = [
    { name: 'Light', bg: '#ffffff', fg: '#1b1b1b', link: '#1d5b4d' },
    { name: 'Stone', bg: '#e6e2d9', fg: '#2b2a27', link: '#35594d', flat: true },
    { name: 'Dark', bg: '#16191a', fg: '#c9ccca', link: '#7ccdb3', flat: true, ink: true, dim: true },
    { name: 'Night', bg: '#000000', fg: '#b3541e', link: '#d9742b', flat: true, ink: true, dim: true },
  ];
  var FONTS = ['', '"Literata", serif', '"Bitter", serif', '"Atkinson Hyperlegible Next", sans-serif', '"Shelfmark Grotesque", sans-serif', 'ui-monospace, monospace'];
  var state = JSON.parse(sessionStorage.getItem('harness') || '{"theme":0,"font":0,"scale":1,"align":"book","lh":0,"slide":true}');
  var start = JSON.parse(sessionStorage.getItem('harness-start') || '{"kind":"start"}');
  sessionStorage.removeItem('harness-start');
  function settings() {
    var t = THEMES[state.theme];
    return { bg: t.bg, fg: t.fg, link: t.link, flat: t.flat, ink: t.ink, dim: t.dim, font: FONTS[state.font], cssScale: state.scale,
      align: state.align, lineHeight: state.lh, slide: state.slide, side: 22, top: 30, bottom: 40, taps: 'sides', lang: 'en' };
  }
  function open(i, where) {
    if (i < 0 || i >= spine.length) return;
    sessionStorage.setItem('harness-start', JSON.stringify(where));
    location.href = '/book/' + spine[i].split('/').map(encodeURIComponent).join('/');
  }
  window.harnessEvents = [];
  window.ShelfmarkHost = {
    config: function () { return JSON.stringify({ settings: settings(), start: start }); },
    event: function (name, json) {
      var data = JSON.parse(json);
      window.harnessEvents.push([name, data]);
      if (name === 'ready' || name === 'page') document.title = (index + 1) + '/' + spine.length + ' · page ' + (data.page + 1) + ' of ' + data.pages;
      if (name === 'edge') open(index + data.dir, { kind: data.dir < 0 ? 'end' : 'start' });
      if (name === 'link') open(spine.indexOf(data.path.replace(/^\\/book\\//, '')), data.hash ? { kind: 'anchor', value: data.hash } : { kind: 'start' });
      if (name === 'xmlerror') location.href = location.pathname + '?lenient=1';
    },
  };
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 't') state.theme = (state.theme + 1) % THEMES.length;
    else if (k === 'f') state.font = (state.font + 1) % FONTS.length;
    else if (k === '+' || k === '=') state.scale = Math.min(3, state.scale + 0.1);
    else if (k === '-') state.scale = Math.max(0.5, state.scale - 0.1);
    else if (k === 'j') state.align = { book: 'justify', justify: 'left', left: 'book' }[state.align];
    else if (k === 'l') state.lh = state.lh ? (state.lh >= 2 ? 0 : state.lh + 0.25) : 1.25;
    else if (k === 's') state.slide = !state.slide;
    else return;
    sessionStorage.setItem('harness', JSON.stringify(state));
    window.Shelfmark.apply(settings());
  });
})();`;

  const inject = '<meta name="viewport" content="width=device-width, initial-scale=1"/>'
    + '<link rel="stylesheet" type="text/css" href="/__reader/reader.css"/>'
    + '<script type="text/javascript" src="/__host.js"></script>'
    + '<script type="text/javascript" src="/__reader/reader.js"></script>';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/') {
      res.writeHead(302, { Location: `/book/${spine[0].split('/').map(encodeURIComponent).join('/')}` });
      return res.end();
    }
    if (url.pathname === '/phone') {
      // The book in a frame the size of a phone screen, for a browser window that cannot be made that small.
      return send(200, 'text/html', '<!doctype html><title>Reader harness</title><body style="margin:0;background:#444;display:grid;place-items:center;height:100vh">'
        + '<iframe src="/" style="width:412px;height:880px;border:0;background:#fff"></iframe>');
    }
    if (url.pathname === '/__host.js') return send(200, 'text/javascript', hostScript);
    if (url.pathname.startsWith('/__reader/')) {
      const file2 = path.join(assets, url.pathname.slice('/__reader/'.length));
      if (!file2.startsWith(assets) || !fs.existsSync(file2)) return send(404, 'text/plain', 'not found');
      return send(200, TYPES[path.extname(file2)] || 'application/octet-stream', fs.readFileSync(file2));
    }
    if (url.pathname.startsWith('/book/')) {
      const name = zip.find(decodeURIComponent(url.pathname.slice('/book/'.length)));
      if (!name) return send(404, 'text/plain', 'not in the book');
      let body = zip.read(name);
      let type = TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
      if (spine.includes(name)) {
        let text = body.toString('utf8');
        if (url.searchParams.get('lenient')) {
          // As the app does for a chapter that is not well-formed: read it as HTML, with self-closed tags opened up.
          type = 'text/html';
          text = text.replace(/<(title|script|style|a|div|span|p|i|b|em|strong|h[1-6]|td|th|li|ul|ol|table|section|sup|sub|small|blockquote|textarea|iframe)\b([^<>]*?)\/>/gi, '<$1$2></$1>');
        }
        text = /<head\b[^>]*>/i.test(text) ? text.replace(/<head\b[^>]*>/i, (m) => m + inject) : inject + text;
        body = Buffer.from(text, 'utf8');
        type += '; charset=utf-8';
      }
      return send(200, type, body);
    }
    return send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, spine, url: `http://localhost:${port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('Usage: node dev/reader-harness.js <book.epub> [port]');
    process.exit(1);
  }
  const harness = await startHarness(process.argv[2], Number(process.argv[3]) || 4020);
  console.log(`The reader is at ${harness.url} (${harness.spine.length} chapters). Make the window phone-sized.`);
}
