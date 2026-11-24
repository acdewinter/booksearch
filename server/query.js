// Turns what someone typed into a full-text query.
//
//   stephen king        both words, each matching the start of a word
//   "the stand"         exact phrase
//   king -abridged      leave out anything containing "abridged"

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const MAX_TERMS = 12;

const quote = (s) => `"${s.replace(/"/g, '""')}"`;

export function parseQuery(input) {
  const text = String(input ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .slice(0, 300);
  const include = [];
  const exclude = [];
  const highlight = [];

  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m;
  while ((m = re.exec(text)) && include.length + exclude.length < MAX_TERMS) {
    let negative = false;
    let value;
    let phrase = false;
    if (m[3] !== undefined) {
      value = m[3];
      if (value.length > 1 && value.startsWith('-')) {
        negative = true;
        value = value.slice(1);
      }
      value = value.replace(/"/g, ' ').trim();
    } else {
      negative = m[1] === '-';
      value = m[2].trim();
      phrase = true;
    }
    if (!value || !HAS_WORD_CHAR.test(value)) continue;
    const expr = phrase ? quote(value) : `${quote(value)}*`;
    if (negative) {
      exclude.push(expr);
    } else {
      include.push(expr);
      highlight.push(value);
    }
  }

  if (include.length === 0) return null;
  const positive = include.join(' AND ');
  const match = exclude.length ? `(${positive}) NOT (${exclude.join(' OR ')})` : positive;
  return { match, positive, highlight };
}
