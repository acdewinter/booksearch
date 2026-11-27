// Makes a small but complete .epub, for the tests and for trying the
// collection and the reader app without a real book at hand.
//
//   node dev/make-epub.js "data/downloads/Practice Book.epub"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { makeZip } from '../server/zip.js';

const esc = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** A plain one-colour PNG, as a stand-in for a cover. */
export function plainPng(hex = '#1d5b4d', width = 60, height = 90) {
  const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FILLER = [
  'The road out of the valley climbed for an hour before it gave up and became a path, and the path gave up soon after and became a suggestion.',
  'Nobody in the village could say who had built the tower, only that it had been there before the village and would likely be there after.',
  '“You will want a lantern,” said the keeper, in the tone of someone who had watched many people decide they would not.',
  'By the third evening the rain had settled into the kind of steady work that suggested it had nowhere else to be.',
  'She kept the letter in the lining of her coat, where it could be felt but not read, which suited them both.',
  'There is a particular silence that falls over a room when everyone in it has just realised the same thing at once.',
];

/**
 * @param {object} [o]
 * @param {string} [o.title]
 * @param {string} [o.author]      written the way calibre files it: "Surname, First"
 * @param {[string, number]} [o.series]
 * @param {number} [o.chapters]
 * @param {number} [o.paragraphs]  per chapter
 * @param {boolean} [o.cover]
 * @returns {Buffer}
 */
export function makeEpub(o = {}) {
  const title = o.title || 'The Practice Book';
  const author = o.author || 'Reader, Practice';
  const chapters = o.chapters ?? 5;
  const paragraphs = o.paragraphs ?? 40;
  const cover = o.cover !== false;

  const chapter = (i) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><title>Chapter ${i}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
<h1 id="start">Chapter ${i}</h1>
${Array.from({ length: paragraphs }, (_, p) => `<p>${esc(`${FILLER[(i + p) % FILLER.length]} ${FILLER[(i * 3 + p * 2) % FILLER.length]} (${i}.${p + 1})`)}</p>`).join('\n')}
${i < chapters ? `<p><a href="chapter-${i + 1}.xhtml#start">On to chapter ${i + 1}</a></p>` : '<p><em>The end.</em></p>'}
</body>
</html>`;

  const numbers = Array.from({ length: chapters }, (_, i) => i + 1);
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="id">urn:uuid:practice-${esc(title.toLowerCase().replace(/\W+/g, '-'))}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:creator opf:role="aut">${esc(author)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>${o.year || 2024}-01-01</dc:date>
    <dc:description>&lt;p&gt;A book that exists to be opened.&lt;/p&gt;</dc:description>
    ${o.series ? `<meta name="calibre:series" content="${esc(o.series[0])}"/><meta name="calibre:series_index" content="${o.series[1]}"/>` : ''}
    ${cover ? '<meta name="cover" content="cover-img"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${cover ? '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>' : ''}
    ${numbers.map((i) => `<item id="c${i}" href="text/chapter-${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${numbers.map((i) => `<itemref idref="c${i}"/>`).join('\n    ')}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><h1>Contents</h1><ol>
${numbers.map((i) => `<li><a href="text/chapter-${i}.xhtml">Chapter ${i}</a></li>`).join('\n')}
</ol></nav></body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="practice"/></head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${numbers.map((i) => `<navPoint id="n${i}" playOrder="${i}"><navLabel><text>Chapter ${i}</text></navLabel><content src="text/chapter-${i}.xhtml"/></navPoint>`).join('\n')}
</navMap>
</ncx>`;

  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/style.css', data: 'body { font-family: Georgia, serif; }\nh1 { text-align: center; margin: 2em 0 1em; }\np { margin: 0; text-indent: 1.2em; }\n' },
    ...(cover ? [{ name: 'OEBPS/images/cover.png', data: plainPng(o.color), store: true }] : []),
    ...numbers.map((i) => ({ name: `OEBPS/text/chapter-${i}.xhtml`, data: chapter(i) })),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: node dev/make-epub.js <file.epub> [title] [author]');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, makeEpub({ title: process.argv[3], author: process.argv[4], chapters: 12 }));
  console.log(`Wrote ${out}`);
}
