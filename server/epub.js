// What an .epub says about itself: its title, who wrote it, and its cover.
//
// An epub is a zip. META-INF/container.xml names the "package" file, and that
// lists the book's details and every file in it. Node has no XML reader, so
// the few tags needed are picked out by hand; anything unexpected is skipped.

import path from 'node:path';
import { Zip, ZipError } from './zip.js';

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const TYPE_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_PACKAGE = 4 * 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;

export class EpubError extends Error {}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescape(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The text inside a tag, without markup or runs of white space. */
const textOf = (inner) => unescape(String(inner).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** `id="a" href='b'` -> { id: 'a', href: 'b' } */
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = unescape(m[2] ?? m[3]);
  return out;
}

/** Every `<name ...>` (opening or self-closing) in the text, as its attributes. */
function tags(xml, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, 'gi');
  return [...xml.matchAll(re)].map((m) => attributes(m[1]));
}

/** Every `<name ...>text</name>`, as { attrs, text }. */
function elements(xml, name) {
  const re = new RegExp(`<((?:[\\w.-]+:)?${name})\\b([^>]*)>([\\s\\S]*?)</\\1\\s*>`, 'gi');
  return [...xml.matchAll(re)].map((m) => ({ attrs: attributes(m[2]), text: textOf(m[3]) }));
}

/** "Sanderson, Brandon" -> "Brandon Sanderson" */
const firstNameFirst = (name) => {
  const m = /^([^,]+),\s*([^,]+)$/.exec(name);
  return m ? `${m[2]} ${m[1]}` : name;
};

/** Where a file named in the package really is inside the zip. */
function resolve(base, href) {
  let clean = href.split('#')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep it as written
  }
  return path.posix.normalize(path.posix.join(base, clean)).replace(/^(\.\.\/)+/, '');
}

/**
 * Read the details of an epub.
 *
 * @param {string} file
 * @param {{cover?: boolean}} [o] also return the cover image itself
 * @returns {{title: string, authors: string[], series: {name: string, position: number|null}|null,
 *   language: string, description: string, year: number|null, hasCover: boolean,
 *   cover?: {data: Buffer, type: string, ext: string} | null}}
 *   Throws EpubError when the file is not an epub that can be read.
 */
export function readEpub(file, { cover = false } = {}) {
  let zip;
  try {
    zip = Zip.open(file);
  } catch (err) {
    throw new EpubError(err instanceof ZipError ? 'This file is not an epub that can be read.' : err.message);
  }
  try {
    const containerName = zip.find('META-INF/container.xml');
    if (!containerName) throw new EpubError('This file is not an epub: it has no table of contents.');
    const container = zip.read(containerName, MAX_PACKAGE).toString('utf8');
    const rootfile = tags(container, 'rootfile').find((r) => r['full-path']);
    const packageName = rootfile && zip.find(resolve('', rootfile['full-path']));
    if (!packageName) throw new EpubError('This file is not an epub: its package file is missing.');
    const opf = zip.read(packageName, MAX_PACKAGE).toString('utf8');
    const base = path.posix.dirname(packageName) === '.' ? '' : path.posix.dirname(packageName);

    const metadata = /<(?:[\w.-]+:)?metadata\b[\s\S]*?<\/(?:[\w.-]+:)?metadata\s*>/i.exec(opf)?.[0] || opf;
    const metas = tags(metadata, 'meta');
    const named = (name) => metas.find((m) => m.name?.toLowerCase() === name)?.content || '';

    const title = elements(metadata, 'title')[0]?.text || '';
    const creators = elements(metadata, 'creator');
    const writers = creators.filter((c) => !c.attrs['opf:role'] || c.attrs['opf:role'].toLowerCase() === 'aut');
    const authors = [...new Set((writers.length ? writers : creators).map((c) => firstNameFirst(c.text)).filter(Boolean))].slice(0, 6);

    let series = null;
    const calibre = named('calibre:series');
    const collection = elements(metadata, 'meta').find((m) => m.attrs.property === 'belongs-to-collection');
    if (calibre) {
      const index = Number.parseFloat(named('calibre:series_index'));
      series = { name: calibre, position: Number.isFinite(index) ? index : null };
    } else if (collection?.text) {
      const refined = elements(metadata, 'meta').find((m) => m.attrs.property === 'group-position' && (!collection.attrs.id || m.attrs.refines === `#${collection.attrs.id}`));
      const index = Number.parseFloat(refined?.text);
      series = { name: collection.text, position: Number.isFinite(index) ? index : null };
    }

    const year = Number.parseInt(/\b(1[5-9]\d\d|20\d\d)\b/.exec(elements(metadata, 'date')[0]?.text || '')?.[1] || '', 10);

    // The cover: marked as such (EPUB 3), named by a <meta name="cover"> (EPUB 2), or an image called "cover".
    const items = tags(opf, 'item').filter((i) => i.href);
    const isImage = (i) => Boolean(IMAGE_TYPES[i['media-type']] || TYPE_BY_EXT[path.posix.extname(i.href).toLowerCase()]);
    const coverId = named('cover');
    const coverItem = items.find((i) => /(^|\s)cover-image(\s|$)/.test(i.properties || '') && isImage(i))
      || (coverId && items.find((i) => i.id === coverId && isImage(i)))
      || items.find((i) => isImage(i) && /cover/i.test(`${i.id || ''} ${i.href}`));
    const coverName = coverItem ? zip.find(resolve(base, coverItem.href)) : null;

    const out = {
      title,
      authors,
      series,
      language: elements(metadata, 'language')[0]?.text || '',
      // Descriptions often carry markup of their own, written out as text.
      description: textOf(elements(metadata, 'description')[0]?.text || '').slice(0, 4000),
      year: Number.isFinite(year) ? year : null,
      hasCover: Boolean(coverName),
    };
    if (cover) {
      out.cover = null;
      if (coverName && zip.entries.get(coverName).size <= MAX_COVER) {
        const type = IMAGE_TYPES[coverItem['media-type']] ? coverItem['media-type'] : TYPE_BY_EXT[path.posix.extname(coverName).toLowerCase()];
        out.cover = { data: zip.read(coverName, MAX_COVER), type, ext: IMAGE_TYPES[type] };
      }
    }
    return out;
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError(err instanceof ZipError ? err.message : 'This epub could not be read.');
  } finally {
    zip.close();
  }
}
