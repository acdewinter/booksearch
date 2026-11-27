// Writes the epubs the reader app's own tests open (android/app/src/test/resources).
// Run it again after changing what they should contain:
//
//   node dev/make-test-epubs.js

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../server/zip.js';
import { makeEpub } from './make-epub.js';

const out = fileURLToPath(new URL('../android/app/src/test/resources/', import.meta.url));
fs.mkdirSync(out, { recursive: true });

// A tidy EPUB 3 with a nav document.
fs.writeFileSync(`${out}practice.epub`, makeEpub({ title: 'The Practice Book', author: 'Reader, Practice', chapters: 4, paragraphs: 6 }));

// An awkward EPUB 2, the way old files often are: the package file at the top
// of the zip, only an NCX for contents (nested, with a link into the middle of
// a chapter), a space and an accent in file names, names that differ in case
// from what the package says, a chapter the contents do not mention, and a
// chapter that is not well-formed.
const chapter = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h2>${title}</h2>${body}</body></html>`;

fs.writeFileSync(`${out}awkward.epub`, makeZip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
  { name: 'book.opf', data: `<?xml version="1.0" encoding="utf-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0" unique-identifier="uid">
  <opf:metadata>
    <dc:title>  An Awkward
      Book </dc:title>
    <dc:creator opf:role="aut">Ann Author</dc:creator>
    <dc:creator opf:role="ill">Ian Illustrator</dc:creator>
    <dc:language>nl</dc:language>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <opf:item id="cover" href="Text/Cover.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="one" href="Text/Chapter%20One.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="two" href="Text/caf%C3%A9.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="three" href="Text/broken.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="gone" href="Text/not-in-the-zip.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="css" href="Styles/main.css" media-type="text/css"/>
  </opf:manifest>
  <opf:spine toc="ncx">
    <opf:itemref idref="cover"/>
    <opf:itemref idref="one"/>
    <opf:itemref idref="gone"/>
    <opf:itemref idref="two"/>
    <opf:itemref idref="three"/>
  </opf:spine>
</opf:package>` },
  { name: 'toc.ncx', data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<docTitle><text>An Awkward Book</text></docTitle>
<navMap>
  <navPoint id="p1" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="Text/Chapter%20One.xhtml"/>
    <navPoint id="p1a" playOrder="2"><navLabel><text>  A   Scene in
      the Middle </text></navLabel><content src="Text/Chapter%20One.xhtml#middle"/></navPoint>
  </navPoint>
  <navPoint id="p2" playOrder="3"><navLabel><text>Caf&#233;&nbsp;&amp; Bar</text></navLabel><content src="Text/caf%C3%A9.xhtml"/></navPoint>
  <navPoint id="p3" playOrder="4"><navLabel><text>Nowhere</text></navLabel><content src="Text/missing.xhtml"/></navPoint>
</navMap>
</ncx>` },
  // Lower case in the zip, upper case in the package file.
  { name: 'text/cover.xhtml', data: chapter('Cover', '<p>The cover.</p>') },
  { name: 'Text/Chapter One.xhtml', data: chapter('One', `${'<p>Some text to give this chapter a size.</p>'.repeat(40)}<p id="middle">The middle.</p>`) },
  { name: 'Text/café.xhtml', data: chapter('Two', '<p>Short.</p>') },
  { name: 'Text/broken.xhtml', data: '<html><head><title/></head><body><p>Not closed &nbsp; properly<br></body></html>' },
  { name: 'Styles/main.css', data: 'p { margin: 0 }' },
]));
console.log(`Wrote practice.epub and awkward.epub to ${out}`);
