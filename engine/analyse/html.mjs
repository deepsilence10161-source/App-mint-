/**
 * READING A WEB PAGE WITHOUT A BROWSER
 * =====================================
 *
 * The analyser has to understand enough HTML and CSS to answer practical
 * questions — what is this page called, what does it link to, does it work
 * without a network, what colour is it — and it has to answer them the same way
 * every time, on a phone, with no browser, no dependencies and no AI.
 *
 * So this is a small tolerant scanner rather than a full HTML parser. It is
 * written to the parts that matter and honest about the parts it does not do:
 *
 *   What it does:  tags, attributes, quoted values, comments, raw text inside
 *                  <script> and <style>, text content, and enough structure to
 *                  follow <nav>, <header>, <main>, <footer>, headings, links,
 *                  images and forms.
 *
 *   What it does not: the full HTML5 tree-building algorithm. No implied
 *                  <tbody>, no foster parenting, no error recovery to the
 *                  specification. A page that relies on those to look right will
 *                  still be read correctly for everything above, because none of
 *                  it depends on element nesting being legal — but the *browser*
 *                  is what renders the app, not this file, so an approximation
 *                  that only feeds decisions is the right size of tool.
 *
 * Every function here is pure: same input, same output, no I/O, no clock.
 */

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', pound: '£', euro: '€', rupee: '₹',
};

/** Decode the entities that actually appear in titles and link text. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] ?? m));
}

function safeCodePoint(n) {
  // A page can contain any number at all; String.fromCodePoint throws outside
  // the Unicode range, and one malformed entity should not stop an analysis.
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/** Collapse whitespace the way rendered text does. */
export const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Scan an attribute string into an object.
 * Unquoted values are accepted because real pages contain them.
 */
function parseAttributes(source) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Split a document into elements and text.
 *
 * Returns a flat list rather than a tree. Everything the analyser asks is a
 * question about what appears in the document — is there a viewport tag, which
 * links are relative, what does the first heading say — and flattening avoids
 * inventing a nesting model that would be wrong on malformed pages.
 */
export function scanHtml(html) {
  const elements = [];
  const textParts = [];
  const source = String(html);
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) textParts.push(decodeEntities(source.slice(textStart, end)));
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;

    // Comments: skipped whole, including the conditional-comment syntax that
    // old pages still carry.
    if (source.startsWith('<!--', lt)) {
      flushText(lt);
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      textStart = i;
      continue;
    }

    // Doctypes and processing instructions.
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      flushText(lt);
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      textStart = i;
      continue;
    }

    const gt = findTagEnd(source, lt + 1);
    if (gt === -1) break;

    flushText(lt);

    const raw = source.slice(lt + 1, gt);
    const closing = raw.startsWith('/');
    const body = closing ? raw.slice(1) : raw;
    const m = /^([a-zA-Z][-a-zA-Z0-9:]*)/.exec(body);
    if (!m) { i = gt + 1; textStart = i; continue; }

    const name = m[1].toLowerCase();
    const attrs = parseAttributes(body.slice(m[1].length));
    const selfClosing = raw.endsWith('/') || VOID_ELEMENTS.has(name);

    i = gt + 1;
    textStart = i;

    if (closing) {
      elements.push({ type: 'end', name });
      continue;
    }

    elements.push({ type: 'start', name, attrs, selfClosing });

    if (!selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      // Inside <script>, <style>, <textarea> and <title> nothing is markup until
      // the matching close tag: a `<` in JavaScript or a CSS child combinator is
      // not the start of an element, and treating it as one corrupts the scan
      // for the rest of the document.
      const closer = new RegExp(`</${name}\\s*>`, 'i');
      const rest = source.slice(i);
      const found = closer.exec(rest);
      const inner = found ? rest.slice(0, found.index) : rest;
      // <title> is a raw-text element because a title may contain a `<`, but it
      // is text a person reads, so its entities are decoded. The first version
      // pushed it raw, and every page title arrived in the analysis still
      // spelled &amp;.
      if (name === 'title') textParts.push(decodeEntities(inner));
      elements.push({ type: 'raw', name, text: inner });
      i = found ? i + found.index + found[0].length : source.length;
      textStart = i;
    }
  }
  flushText(source.length);

  return { elements, text: textParts.join(' ') };
}

/** Find the '>' that closes a tag, ignoring '>' inside quoted attributes. */
function findTagEnd(source, from) {
  let quote = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

/* ── what the document says ───────────────────────────────────────────────── */

/** Classify a URL the way a WebView will have to. */
export function classifyUrl(href) {
  const value = String(href || '').trim();
  if (!value) return { kind: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const scheme = value.split(':')[0].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return { kind: 'absolute', scheme, url: value };
    return { kind: 'scheme', scheme, url: value };
  }
  if (value.startsWith('//')) return { kind: 'absolute', scheme: 'inherit', url: value };
  if (value.startsWith('#')) return { kind: 'fragment', url: value };
  if (value.startsWith('/')) return { kind: 'root-relative', url: value };
  return { kind: 'relative', url: value };
}

/** Strip the tag soup and leave the words a person would read. */
export function visibleText(html) {
  const { text } = scanHtml(html);
  return squash(text);
}

/**
 * Everything the analyser wants to know about one page.
 *
 * Deliberately one pass over the scan: the shape of this object is the contract
 * between reading a page and deciding what kind of app it becomes.
 */
export function parsePage(html) {
  const { elements, text } = scanHtml(html);
  const page = {
    title: null,
    lang: null,
    meta: {},
    stylesheets: [],
    scripts: [],
    inlineScripts: 0,
    inlineStyles: 0,
    icons: [],
    links: [],
    images: [],
    forms: [],
    headings: [],
    landmarks: [],
    bodyText: squash(text),
    styleText: '',
  };

  let openForm = null;
  let openHeading = null;
  const openLandmarks = [];

  for (const el of elements) {
    if (el.type === 'raw') {
      if (el.name === 'style') page.styleText += `${el.text}\n`;
      if (el.name === 'script') page.inlineScripts += 1;
      continue;
    }
    if (el.type === 'end') {
      if (el.name === 'form' && openForm) { page.forms.push(openForm); openForm = null; }
      if (openHeading && el.name === `h${openHeading.level}`) openHeading = null;
      const at = openLandmarks.lastIndexOf(el.name);
      if (at !== -1) openLandmarks.splice(at, 1);
      continue;
    }

    const { name, attrs } = el;
    switch (name) {
      case 'html':
        if (attrs.lang) page.lang = attrs.lang;
        break;
      case 'title':
        break;                                   // captured through the raw text
      case 'meta': {
        const key = (attrs.name || attrs.property || attrs['http-equiv'] || '').toLowerCase();
        if (key === 'viewport') page.meta.viewport = attrs.content || '';
        else if (key === 'description') page.meta.description = squash(attrs.content || '');
        else if (key === 'theme-color') page.meta.themeColor = (attrs.content || '').trim();
        else if (key === 'charset') page.meta.charset = attrs.charset;
        else if (key === 'og:title') page.meta.ogTitle = squash(attrs.content || '');
        else if (key === 'og:image') page.meta.ogImage = (attrs.content || '').trim();
        else if (key === 'og:description') page.meta.ogDescription = squash(attrs.content || '');
        break;
      }
      case 'link': {
        const rel = (attrs.rel || '').toLowerCase();
        if (rel.includes('stylesheet') && attrs.href) page.stylesheets.push(attrs.href);
        else if (rel.includes('icon') && attrs.href) page.icons.push(attrs.href);
        break;
      }
      case 'script':
        if (attrs.src) page.scripts.push({ src: attrs.src, async: !!attrs.async, defer: !!attrs.defer });
        break;
      case 'style':
        page.inlineStyles += 1;
        break;
      case 'a': {
        const href = attrs.href;
        if (href === undefined) break;
        page.links.push({ href, text: '', rel: attrs.rel || null, target: attrs.target || null, ...classifyUrl(href) });
        break;
      }
      case 'img':
        if (attrs.src) {
          page.images.push({
            src: attrs.src, alt: attrs.alt ?? null,
            width: attrs.width ? Number(attrs.width) || null : null,
            height: attrs.height ? Number(attrs.height) || null : null,
            loading: attrs.loading || null,
            ...classifyUrl(attrs.src),
          });
        }
        break;
      case 'form':
        openForm = { action: attrs.action || '', method: (attrs.method || 'get').toLowerCase(), inputs: [] };
        break;
      case 'input':
      case 'textarea':
      case 'select':
        if (openForm) {
          openForm.inputs.push({
            tag: name, type: (attrs.type || (name === 'input' ? 'text' : name)).toLowerCase(),
            name: attrs.name || '', required: attrs.required !== undefined,
          });
        }
        break;
      case 'h1': case 'h2': case 'h3': case 'h4':
        openHeading = { level: Number(name[1]), text: '' };
        page.headings.push(openHeading);
        break;
      case 'header': case 'nav': case 'main': case 'footer': case 'section':
        page.landmarks.push(name);
        openLandmarks.push(name);
        break;
      default:
        break;
    }
  }

  // Fill in link and heading text from the flattened text is not possible
  // without ordering, so the caller re-reads these from the source when it needs
  // the words. What matters for decisions is which URLs are used and how.
  return page;
}

/* ── CSS, for colour and responsiveness ───────────────────────────────────── */

const NAMED_COLOURS = {
  white: '#FFFFFF', black: '#000000', red: '#FF0000', green: '#008000', blue: '#0000FF',
  transparent: null, grey: '#808080', gray: '#808080', silver: '#C0C0C0', orange: '#FFA500',
  brown: '#A52A2A', beige: '#F5F5DC', ivory: '#FFFFF0', navy: '#000080', teal: '#008080',
  olive: '#808000', maroon: '#800000', purple: '#800080', yellow: '#FFFF00', pink: '#FFC0CB',
};

/** Any CSS colour to #RRGGBB, or null when it cannot be understood. */
export function normaliseColour(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v in NAMED_COLOURS) return NAMED_COLOURS[v];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return `#${h.slice(0, 3).split('').map((c) => c + c).join('').toUpperCase()}`;
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6).toUpperCase()}`;
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)/.exec(v);
  if (rgb) {
    const part = (p) => (p.endsWith('%') ? Math.round(parseFloat(p) * 2.55) : Math.round(parseFloat(p)));
    const [r, g, b] = [part(rgb[1]), part(rgb[2]), part(rgb[3])];
    if ([r, g, b].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }
  return null;
}

/** WCAG relative luminance, used for contrast decisions. */
export function luminance(hex) {
  const c = normaliseColour(hex);
  if (!c) return null;
  const channels = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrast(a, b) {
  const la = luminance(a); const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on this colour. */
export function readableOn(colour) {
  const l = luminance(colour);
  if (l === null) return null;
  return l > 0.35 ? '#000000' : '#FFFFFF';
}

/**
 * Nudge a colour until text in `on` is readable on it.
 *
 * Used when a page's theme colour cannot carry white text: rather than shipping
 * a spec with a contrast failure that the validator would reject, darken (or
 * lighten) the colour in fixed steps and report that it was changed. Predictable
 * and reversible — the original value stays in the findings.
 */
export function ensureContrast(colour, on, target = 4.5) {
  let value = normaliseColour(colour);
  const text = normaliseColour(on);
  if (!value || !text) return { colour: value, changed: false };
  if ((contrast(value, text) ?? 0) >= target) return { colour: value, changed: false };

  const towardBlack = (luminance(text) ?? 0) > 0.5;
  for (let step = 1; step <= 20; step += 1) {
    value = shade(value, step * 5, towardBlack);
    if ((contrast(value, text) ?? 0) >= target) return { colour: value, changed: true, steps: step };
  }
  return { colour: towardBlack ? '#000000' : '#FFFFFF', changed: true, steps: 20 };
}

/** Move a colour toward black (darken) or white (lighten) by a percentage. */
export function shade(colour, percent, darken = true) {
  const c = normaliseColour(colour);
  if (!c) return colour;
  const target = darken ? 0 : 255;
  const parts = [1, 3, 5].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16);
    return Math.round(v + (target - v) * (percent / 100));
  });
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * Read a stylesheet for the decisions the analyser makes: which colours carry
 * the design, what font it asks for, whether it adapts to small screens, and
 * what it loads from where.
 */
export function parseCss(css) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = {
    colours: new Map(),        // colour -> how often it appears
    background: [],
    foreground: [],
    fonts: [],
    mediaQueries: [],
    imports: [],
    urlRefs: [],
    // `50vw` has a digit in front of it, which is how a viewport unit is
    // normally written. Requiring a space or bracket before it — which an
    // earlier version did — meant this was false for every real stylesheet.
    hasViewportUnit: /(?:^|[\s(\d.:])(?:vw|vh|vmin|vmax)\b/.test(text),
    hasFlexOrGrid: /\b(?:flex|grid)\b/.test(text),
  };

  for (const m of text.matchAll(/(?<![\w-])(#[0-9a-f]{3,8}|rgba?\([^)]*\)|\b[a-z]{3,20}\b)(?![\w-])/gi)) {
    const colour = normaliseColour(m[1]);
    if (colour) out.colours.set(colour, (out.colours.get(colour) || 0) + 1);
  }
  // A declaration's value may be `rgb(36, 26, 18)`, `#fff`, or `#fff !important`.
  // Splitting on whitespace first — which is what an earlier version did —
  // breaks every functional colour into `rgb(36,` and loses it silently.
  const colourFrom = (value) => normaliseColour(value) || normaliseColour(String(value).trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/(background(?:-color)?)\s*:\s*([^;{}]+)/gi)) {
    const colour = colourFrom(m[2]);
    if (colour) out.background.push(colour);
  }
  for (const m of text.matchAll(/(?<![-\w])color\s*:\s*([^;{}]+)/gi)) {
    const colour = colourFrom(m[1]);
    if (colour) out.foreground.push(colour);
  }
  for (const m of text.matchAll(/font-family\s*:\s*([^;{}]+)/gi)) {
    const first = m[1].split(',')[0].replace(/["']/g, '').trim();
    if (first) out.fonts.push(first);
  }
  for (const m of text.matchAll(/@media([^{]+)\{/gi)) out.mediaQueries.push(squash(m[1]));
  for (const m of text.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/gi)) out.imports.push(m[1].trim());
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) out.urlRefs.push(m[1].trim());

  return out;
}

/** The colours a page is built from, most used first. */
export function rankedColours(...cssObjects) {
  const total = new Map();
  for (const css of cssObjects) {
    if (!css?.colours) continue;
    for (const [colour, count] of css.colours) total.set(colour, (total.get(colour) || 0) + count);
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([colour, count]) => ({ colour, count }));
}
