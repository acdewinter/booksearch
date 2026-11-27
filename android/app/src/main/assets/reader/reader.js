// The part of the reader that lives inside the page.
//
// Every chapter of a book is an HTML document of its own. The app loads one
// into its web view with this script (and reader.css) added to the head. The
// script lays the chapter out as pages, turns them on taps, swipes and keys,
// and tells the app where the reader is. The app answers through the
// `Shelfmark` object this script puts on the window.
//
// The app is reached through `ShelfmarkHost`:
//   config()           -> JSON: { settings, start, gen }
//   event(name, json)  <- ready, page, edge, tap, link, jumped, external, xmlerror
//
// `gen` is handed back with every event, so the app can tell the events of
// the chapter it is showing from late ones of the chapter before.

(function () {
  'use strict';
  if (window.Shelfmark) return;

  var host = window.ShelfmarkHost;
  var root = document.documentElement;
  var settings = {};
  var start = { kind: 'start' };
  var page = 0;
  var pages = 1;
  var ready = false;
  var chrome = false;       // the app's bars are showing: any tap puts them away
  var anchor = null;        // a Range at the top of the page on screen
  var stickToEnd = false;   // opened at its last page (turning back from the next chapter)
  var anchorTimer = 0;
  var layoutTimer = 0;
  var gen = 0;

  function send(name, data) {
    try {
      data = data || {};
      data.gen = gen;
      host.event(name, JSON.stringify(data));
    } catch (e) {
      // no app is listening
    }
  }

  try {
    var given = JSON.parse(host.config());
    settings = given.settings || {};
    start = given.start || start;
    gen = given.gen || 0;
  } catch (e) {
    // laid out with the defaults
  }

  // How wide one page is. The body is exactly one page wide, to a fraction of a pixel; that fraction
  // matters, because it adds up over many pages. (window.innerWidth is no use here: on a phone it
  // grows when the content is wider than the screen, which a chapter laid out in columns always is.)
  var width = function () {
    var body = document.body;
    var exact = body ? body.getBoundingClientRect().width : 0;
    return exact || root.clientWidth || 1;
  };
  var clamp = function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };

  // ---------------------------------------------------------------- settings

  function applySettings(s) {
    settings = s || {};
    var set = function (name, value) { root.style.setProperty(name, value); };
    root.classList.add('sm');
    set('--sm-bg', settings.bg || '#ffffff');
    set('--sm-fg', settings.fg || '#1a1a1a');
    set('--sm-link', settings.link || '#1d5b4d');
    set('--sm-select', settings.select || 'rgba(120,160,220,0.4)');
    set('--sm-side', (settings.side == null ? 22 : settings.side) + 'px');
    set('--sm-top', (settings.top == null ? 28 : settings.top) + 'px');
    set('--sm-bottom', (settings.bottom == null ? 36 : settings.bottom) + 'px');
    set('--sm-font', settings.font || 'serif');
    set('--sm-lh', String(settings.lineHeight || 1.5));
    set('--sm-para', (settings.para || 0.7) + 'em');
    var flag = function (name, on) { root.classList.toggle(name, Boolean(on)); };
    flag('sm-flat', settings.flat);
    flag('sm-ink', settings.ink);
    flag('sm-dim', settings.dim);
    flag('sm-font', settings.font);
    flag('sm-lh', settings.lineHeight);
    flag('sm-justify', settings.align === 'justify');
    flag('sm-left', settings.align === 'left');
    flag('sm-spaced', settings.spaced);
    flag('sm-bold', settings.bold);
    // The app sizes text with the web view's own zoom; elsewhere it is done here.
    root.style.fontSize = settings.cssScale ? Math.round(settings.cssScale * 100) + '%' : '';
    // Hyphenation needs to know the language.
    if (settings.lang && !root.getAttribute('lang') && !root.getAttribute('xml:lang')) root.setAttribute('lang', settings.lang);
  }

  applySettings(settings);

  // ------------------------------------------------------------------ layout

  /** Run fn with the body back at the first page, so positions are plain distances from the start. */
  function unmoved(fn) {
    var body = document.body;
    root.classList.remove('sm-slide');
    var was = body.style.transform;
    body.style.transform = 'none';
    try {
      return fn();
    } finally {
      body.style.transform = was;
    }
  }

  /** How far from the start of the chapter the end of its content is. Only valid inside unmoved(). */
  function contentRight() {
    var node = document.body.lastChild;
    while (node) {
      var rect = null;
      if (node.nodeType === 1) {
        rect = node.getBoundingClientRect();
      } else if (node.nodeType === 3 && /\S/.test(node.nodeValue)) {
        var range = document.createRange();
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
      }
      if (rect && rect.width > 0 && rect.height > 0) return rect.right;
      node = node.previousSibling;
    }
    return 0;
  }

  function countPages() {
    var w = width();
    var total = Math.max(document.body.scrollWidth, root.scrollWidth);
    var count = Math.max(1, Math.ceil((total - 1) / w));
    // A margin hanging off the last line can leave a page with nothing on it.
    var right = contentRight();
    if (right > 0) count = Math.min(count, Math.max(1, Math.ceil((right - 1) / w)));
    return count;
  }

  /** The page a spot in the text is on. Only valid inside unmoved(). Returns -1 when it cannot be told. */
  function pageOfRange(range) {
    try {
      var probe = range.cloneRange();
      var node = probe.startContainer;
      if (node.nodeType === 3 && probe.startOffset < node.nodeValue.length) probe.setEnd(node, probe.startOffset + 1);
      var rect = probe.getClientRects()[0];
      if (!rect) {
        var el = node.nodeType === 1 ? (node.childNodes[probe.startOffset] || node) : node.parentNode;
        while (el && el.nodeType !== 1) el = el.parentNode;
        rect = el && (el.getClientRects()[0] || el.getBoundingClientRect());
      }
      if (!rect || (!rect.width && !rect.height && !rect.left)) return -1;
      return Math.floor((rect.left + 1) / width());
    } catch (e) {
      return -1;
    }
  }

  function pageOfElement(el) {
    var rect = el.getClientRects()[0] || el.getBoundingClientRect();
    return Math.floor((rect.left + 1) / width());
  }

  function findTarget(id) {
    if (!id) return null;
    var el = document.getElementById(id);
    if (!el) {
      var named = document.getElementsByName ? document.getElementsByName(id) : [];
      el = named[0] || null;
    }
    return el;
  }

  /** Remember what is at the top of the page, so it can be found again when the layout changes. */
  function rememberAnchor() {
    anchor = null;
    if (!document.caretRangeFromPoint) return;
    var x = (settings.side == null ? 22 : settings.side) + 6;
    var y = (settings.top == null ? 28 : settings.top) + 8;
    for (var i = 0; i < 4 && !anchor; i += 1) {
      var range = document.caretRangeFromPoint(x, y + i * 24);
      if (range && range.startContainer !== document.body && range.startContainer !== root && document.body.contains(range.startContainer)) {
        anchor = range;
      }
    }
  }

  function position() {
    return { page: page, pages: pages, inner: page / pages, seen: (page + 1) / pages };
  }

  /** `moved` says the reader went somewhere, as opposed to the same text being laid out again. */
  function show(target, animate, moved) {
    page = clamp(target, 0, pages - 1);
    root.classList.toggle('sm-slide', Boolean(animate && settings.slide));
    document.body.style.transform = page ? 'translate3d(' + (-page * width()) + 'px,0,0)' : 'none';
    clearTimeout(anchorTimer);
    // Looked up once the page has come to rest: while it slides, the text is not where it will be.
    anchorTimer = setTimeout(rememberAnchor, animate && settings.slide ? 230 : 0);
    if (ready) {
      var at = position();
      at.moved = Boolean(moved);
      send('page', at);
    }
  }

  /** Lay the chapter out again (the size, the text or the settings changed) and stay at the same text. */
  function relayout() {
    if (!document.body) return;
    clearTimeout(layoutTimer);
    var keep = anchor;
    var fraction = page / pages;
    var target = unmoved(function () {
      pages = countPages();
      if (stickToEnd) return pages - 1;
      var p = keep ? pageOfRange(keep) : -1;
      return p >= 0 ? p : Math.floor(fraction * pages + 0.0001);
    });
    show(target, false);
  }

  function relayoutSoon() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(relayout, 120);
  }

  // ------------------------------------------------------------------ moving

  function turn(direction) {
    stickToEnd = false;
    var next = page + (direction < 0 ? -1 : 1);
    if (next < 0 || next >= pages) {
      send('edge', { dir: direction < 0 ? -1 : 1 });
      return;
    }
    show(next, true, true);
  }

  function goTo(inner) {
    stickToEnd = false;
    show(Math.floor(clamp(Number(inner) || 0, 0, 1) * pages + 0.0001), false, true);
  }

  function goToAnchor(id) {
    var el = findTarget(id);
    if (!el) return false;
    stickToEnd = false;
    show(unmoved(function () { return pageOfElement(el); }), false, true);
    return true;
  }

  function followLink(a) {
    var raw = typeof a.href === 'string' ? a.href : (a.href && a.href.baseVal) || a.getAttribute('href') || '';
    var url;
    try {
      url = new URL(raw, document.baseURI);
    } catch (e) {
      return;
    }
    var hash = '';
    try {
      hash = decodeURIComponent(url.hash.slice(1));
    } catch (e) {
      hash = url.hash.slice(1);
    }
    if (url.origin === location.origin && url.pathname === location.pathname) {
      if (hash) {
        var from = position();
        if (goToAnchor(hash)) send('jumped', { from: from.inner });
      }
      return;
    }
    if (url.origin === location.origin) {
      var path = url.pathname;
      try {
        path = decodeURIComponent(path);
      } catch (e) {
        // sent as it is written
      }
      send('link', { path: path, hash: hash });
    } else if (/^(https?|mailto):/.test(url.protocol)) {
      send('external', { url: url.href });
    }
  }

  // ------------------------------------------------------------------- input

  var hasSelection = function () {
    var sel = window.getSelection && window.getSelection();
    return Boolean(sel && !sel.isCollapsed && String(sel).trim());
  };

  var touch = null;        // where a finger went down
  var swallowClick = false; // the touch was a swipe, or it only put a selection away

  document.addEventListener('touchstart', function (e) {
    swallowClick = false;
    if (e.touches.length !== 1) {
      touch = null;
      return;
    }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), selecting: hasSelection() };
  }, { passive: true, capture: true });

  document.addEventListener('touchend', function (e) {
    if (!touch || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - touch.x;
    var dy = e.changedTouches[0].clientY - touch.y;
    var quick = Date.now() - touch.t < 700;
    var began = touch;
    touch = null;
    if (began.selecting || hasSelection()) {
      swallowClick = true;
      return;
    }
    if (chrome) return;
    if (quick && Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swallowClick = true;
      turn(dx < 0 ? 1 : -1);
    } else if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
      swallowClick = true; // a drag that was not a page turn is not a tap either
    }
  }, { passive: true, capture: true });

  document.addEventListener('click', function (e) {
    var target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    var link = target && target.closest ? target.closest('a[href], a[*|href]') : null;
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      return;
    }
    if (chrome) {
      e.preventDefault();
      send('tap', { zone: 'center' });
      return;
    }
    if (link) {
      e.preventDefault();
      followLink(link);
      return;
    }
    if (hasSelection()) return;
    var x = e.clientX / width();
    var mode = settings.taps || 'sides';
    if (mode === 'off' || (x >= 0.3 && x <= 0.7)) {
      send('tap', { zone: 'center' });
    } else if (x < 0.3) {
      turn(mode === 'forward' ? 1 : -1);
    } else {
      turn(1);
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      turn(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      turn(-1);
    }
  });

  // The page never scrolls by itself: pages are turned by moving the body.
  window.addEventListener('scroll', function () {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  });
  window.addEventListener('resize', relayoutSoon);
  document.addEventListener('load', function (e) {
    // A picture that arrives late changes where everything after it sits.
    if (ready && e.target && /^(IMG|IMAGE|SVG|VIDEO)$/i.test(e.target.tagName || '')) relayoutSoon();
  }, true);

  // ------------------------------------------------------------------- start

  function begin() {
    if (ready) return;
    if (!root.clientWidth || !root.clientHeight) {
      // The view has no size yet, so there is nothing to lay pages out in. It gets one in a moment.
      setTimeout(begin, 40);
      return;
    }
    if (document.querySelector('parsererror')) {
      // The chapter is not well-formed XML. The app loads it again, read more forgivingly.
      send('xmlerror', {});
      return;
    }
    var first = unmoved(function () {
      pages = countPages();
      if (start.kind === 'end') {
        stickToEnd = true;
        return pages - 1;
      }
      if (start.kind === 'anchor') {
        var el = findTarget(start.value);
        return el ? pageOfElement(el) : 0;
      }
      if (start.kind === 'inner') return Math.floor(clamp(Number(start.value) || 0, 0, 1) * pages + 0.0001);
      return 0;
    });
    show(first, false);
    ready = true;
    root.classList.add('sm-ready');
    send('ready', position());
  }

  function whenParsed() {
    var fonts = document.fonts && document.fonts.ready;
    var done = false;
    var go = function () {
      if (done) return;
      done = true;
      begin();
    };
    // Wait a moment for the typeface, so the first layout is the one that stays.
    if (fonts && fonts.then) fonts.then(go, go);
    setTimeout(go, 350);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenParsed);
  else whenParsed();

  window.addEventListener('load', function () {
    if (ready) relayout();
    else begin();
    // What stuck to the end until now stays where it is from here on.
    setTimeout(function () { stickToEnd = false; }, 600);
  });
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', function () {
      if (ready) relayoutSoon();
    });
  }

  window.Shelfmark = {
    /** New settings (a JSON string or an object). The page stays at the same text. */
    apply: function (json) {
      applySettings(typeof json === 'string' ? JSON.parse(json) : json);
      if (ready) relayout();
    },
    relayout: relayout,
    turn: turn,
    goTo: goTo,
    goToAnchor: goToAnchor,
    setChrome: function (on) { chrome = Boolean(on); },
    position: position,
  };
})();
