// Small helpers shared by the search page and the downloads page.

export const $ = (id) => document.getElementById(id);

const fmt = new Intl.NumberFormat();
export const n = (value) => fmt.format(value);
export const plural = (count, one, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

/** Tiny element builder. Strings become text nodes, so data is never parsed as HTML. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

/** replaceChildren that ignores null/false, so optional parts can be written inline. */
export function setChildren(el, ...nodes) {
  el.replaceChildren(...nodes.flat(Infinity).filter((node) => node != null && node !== false));
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

export const formatBytes = (bytes) => {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/** POST JSON to the app's own API. Errors carry the server's message (and per-field messages). */
export async function postJson(path, body = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('The server did not answer. Check that the app is running.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const err = new Error(data?.error || `The server answered with an error (${res.status}).`);
    err.status = res.status;
    err.fields = data?.fields || null;
    throw err;
  }
  return data;
}

/** A yes/no question in the app's own dialog. Resolves true when confirmed. */
export function askConfirm({ title, text, action }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const yes = $('confirm-yes');
  yes.textContent = action;
  return new Promise((resolve) => {
    const onYes = () => {
      dialog.returnValue = 'yes';
      dialog.close();
    };
    yes.addEventListener('click', onYes);
    dialog.addEventListener('close', () => {
      yes.removeEventListener('click', onYes);
      resolve(dialog.returnValue === 'yes');
    }, { once: true });
    dialog.returnValue = '';
    dialog.showModal();
    yes.focus();
  });
}
