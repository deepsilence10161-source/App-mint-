/**
 * WEBSITE TO APP
 * ==============
 *
 * Two jobs, and the second one is the point.
 *
 * The first is to describe a site honestly: what it is called, which pages it
 * has, what it loads from where, whether it works with no network, whether the
 * content is in the HTML or drawn later by JavaScript, and what a WebView will
 * do with it. Everything it cannot decide, it reports instead of guessing.
 *
 * The second is to turn that description into a specification the rest of this
 * project already understands — the same specification a person types by hand —
 * so the analyser produces apps through the existing generator, validator,
 * permission engine and build pipeline rather than a parallel path of its own.
 * A second build system would be a second thing to keep correct.
 *
 * The rules that shape every choice below:
 *
 *   Deterministic. The same site produces the same specification, byte for
 *   byte. No network is used for a local site, and nothing here reads a clock,
 *   a random number or an environment variable.
 *
 *   Never silently destructive. Bundling a site for offline use means rewriting
 *   URLs that a WebView cannot resolve from a local asset. Every rewrite is
 *   recorded, and a link to a page that was not collected is reported rather
 *   than quietly left broken.
 *
 *   Say what it cannot do. A form that posts to a server still needs the
 *   server. A page whose words arrive from a fetch will show an empty screen
 *   offline. Those are findings, not failures to hide.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parsePage, parseCss, rankedColours, normaliseColour, readableOn, ensureContrast, classifyUrl, squash } from './html.mjs';
import { defaultSpec } from '../spec/spec.mjs';

const PAGE_EXT = new Set(['.html', '.htm']);
const ASSET_EXT = new Set(['.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.json', '.txt', '.webmanifest', '.mp4', '.webm']);

/** Hosts that mean something specific when a page loads from them. */
const KNOWN_THIRD_PARTIES = [
  { pattern: /(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$|(^|\.)analytics\.google\.com$/, kind: 'analytics', what: 'Google Analytics' },
  { pattern: /(^|\.)doubleclick\.net$|(^|\.)googlesyndication\.com$/, kind: 'advertising', what: 'an advertising network' },
  { pattern: /(^|\.)facebook\.net$|(^|\.)facebook\.com$/, kind: 'tracking', what: 'a Facebook pixel' },
  { pattern: /(^|\.)hotjar\.com$|(^|\.)clarity\.ms$|(^|\.)mixpanel\.com$|(^|\.)segment\.(com|io)$/, kind: 'tracking', what: 'an analytics or session-recording script' },
  { pattern: /(^|\.)sentry\.io$|(^|\.)bugsnag\.com$/, kind: 'error-reporting', what: 'an error reporter' },
  { pattern: /fonts\.googleapis\.com$|fonts\.gstatic\.com$/, kind: 'fonts', what: 'Google Fonts' },
  { pattern: /(^|\.)jsdelivr\.net$|(^|\.)unpkg\.com$|(^|\.)cdnjs\.cloudflare\.com$/, kind: 'cdn', what: 'a content delivery network' },
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
const compact = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/* ── collecting a site ────────────────────────────────────────────────────── */

/**
 * Read a site from a directory.
 *
 * Only files that a WebView can serve are taken: pages and assets. Anything else
 * (source maps, editor backups, a .git directory) is left behind, and the count
 * of what was left is reported so nobody wonders where it went.
 */
export function readLocalSite(root) {
  if (!fs.existsSync(root)) throw new Error(`no such directory: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);

  const files = [];
  const skipped = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') { skipped.push({ rel, why: 'not part of a published site' }); continue; }
        walk(full);
      } else if (PAGE_EXT.has(path.extname(entry.name).toLowerCase()) || ASSET_EXT.has(path.extname(entry.name).toLowerCase())) {
        files.push(rel);
      } else {
        skipped.push({ rel, why: `not a file type a WebView serves (${path.extname(entry.name) || 'no extension'})` });
      }
    }
  };
  walk(root);

  const pages = [];
  const assets = [];
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const full = path.join(root, rel);
    if (PAGE_EXT.has(ext)) {
      pages.push({ rel, html: fs.readFileSync(full, 'utf8'), bytes: fs.statSync(full).size });
    } else {
      assets.push({ rel, file: full, bytes: fs.statSync(full).size });
    }
  }

  return {
    kind: 'local',
    root,
    host: null,
    entry: pages.find((p) => p.rel === 'index.html')?.rel || pages[0]?.rel || null,
    pages,
    assets,
    skipped,
    notes: [],
  };
}

/**
 * Read a site from a URL.
 *
 * Same-origin pages reachable from the entry page are fetched too, up to a
 * budget, because an app that bundles one page of a four-page site is not the
 * app anyone wanted. Everything skipped is listed with the reason — a limit that
 * is not reported looks exactly like a bug.
 */
export async function fetchSite(entryUrl, {
  maxPages = 12, maxBytesPerFile = 2 * 1024 * 1024, maxTotalBytes = 24 * 1024 * 1024,
  timeoutMs = 15000, fetchImpl = globalThis.fetch, userAgent = 'AppMint-Analyser/1.0 (+static site analyser)',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available');
  const entry = new URL(entryUrl);
  if (!/^https?:$/.test(entry.protocol)) throw new Error('only http and https can be fetched');

  const pages = [];
  const assets = [];
  const skipped = [];
  const notes = [];
  let total = 0;
  const seen = new Set();

  const get = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': userAgent } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, contentType: res.headers.get('content-type') || '', finalUrl: res.url || url };
    } finally {
      clearTimeout(timer);
    }
  };

  const queue = [entry.href];
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    let got;
    try {
      got = await get(url);
    } catch (err) {
      skipped.push({ rel: url, why: `could not be fetched: ${err.message}` });
      continue;
    }
    if (got.buf.byteLength > maxBytesPerFile) {
      skipped.push({ rel: url, why: `larger than the ${Math.round(maxBytesPerFile / 1024)} KB per-file limit` });
      continue;
    }
    total += got.buf.byteLength;
    if (total > maxTotalBytes) {
      skipped.push({ rel: url, why: `the ${Math.round(maxTotalBytes / 1024 / 1024)} MB total limit was reached` });
      break;
    }

    const pathname = new URL(got.finalUrl).pathname;
    const rel = pathname.replace(/^\//, '') || 'index.html';
    const looksHtml = /html/i.test(got.contentType) || PAGE_EXT.has(path.extname(rel).toLowerCase()) || pathname.endsWith('/');
    if (!looksHtml) { skipped.push({ rel, why: `not a page (${got.contentType || 'unknown type'})` }); continue; }

    const html = got.buf.toString('utf8');
    const pageRel = rel.endsWith('/') || rel === '' || !path.extname(rel) ? `${rel.replace(/\/$/, '')}${rel && !rel.endsWith('/') ? '/' : ''}index.html`.replace(/^index\.html$/, 'index.html') : rel;
    pages.push({ rel: pageRel, url: got.finalUrl, html, bytes: got.buf.byteLength });

    // Follow same-origin pages that this page links to.
    const parsed = parsePage(html);
    for (const link of parsed.links) {
      if (link.kind === 'scheme' || link.kind === 'fragment' || link.kind === 'empty') continue;
      if (link.kind === 'relative' && /\.(pdf|zip|png|jpg|jpeg|gif|svg|mp4|webm|css|js|json|xml|txt)$/i.test(link.url)) continue;
      let target;
      try { target = new URL(link.url, got.finalUrl); } catch { continue; }
      if (target.hostname !== entry.hostname) continue;
      const clean = `${target.origin}${target.pathname}`;
      if (seen.has(clean) || queue.includes(clean)) continue;
      queue.push(clean);
    }
  }
  if (queue.length) notes.push(`${queue.length} further same-site page link${queue.length === 1 ? '' : 's'} were not followed: the ${maxPages}-page limit was reached.`);

  return {
    kind: 'url',
    root: null,
    host: entry.hostname,
    entryUrl: entry.href,
    entry: pages.find((p) => /(^|\/)index\.html$/.test(p.rel))?.rel || pages[0]?.rel || null,
    pages,
    assets,
    skipped,
    notes,
  };
}

/* ── what the site is ─────────────────────────────────────────────────────── */

/** Everything worth knowing about a collected site, in one object. */
export function describeSite(site) {
  const pages = site.pages.map((p) => {
    const page = parsePage(p.html);
    const stylesheets = [];
    for (const href of page.stylesheets) {
      const target = resolveInSite(href, p.rel, site);
      if (target) {
        const found = site.assets.find((a) => a.rel === target);
        if (found) stylesheets.push({ rel: target, css: fs.readFileSync(found.file, 'utf8') });
      }
    }
    const css = [page.styleText, ...stylesheets.map((s) => s.css)].filter(Boolean).join('\n');
    const parsedCss = parseCss(css);
    return { rel: p.rel, bytes: p.bytes, html: p.html, page, css: parsedCss, stylesheetCount: stylesheets.length, title: titleOf(p.html) };
  });

  const links = pages.flatMap((p) => p.page.links.map((l) => ({ ...l, from: p.rel })));
  const images = pages.flatMap((p) => p.page.images.map((i) => ({ ...i, from: p.rel })));
  const scripts = pages.flatMap((p) => p.page.scripts.map((s) => ({ ...s, from: p.rel })));
  const forms = pages.flatMap((p) => p.page.forms.map((f) => ({ ...f, from: p.rel })));

  const allCss = pages.reduce((acc, p) => { mergeColours(acc, p.css); return acc; }, { colours: new Map(), background: [], foreground: [], mediaQueries: [], fonts: [], imports: [], urlRefs: [] });

  const external = [];
  for (const s of scripts) collectExternal(external, s.src, p0(s.from), 'script');
  for (const i of images) collectExternal(external, i.src, p0(i.from), 'image');
  for (const l of links) if (l.kind === 'absolute') collectExternal(external, l.url, p0(l.from), 'link');
  for (const p of pages) for (const href of p.page.stylesheets) collectExternal(external, href, p.rel, 'stylesheet');
  for (const p of pages) for (const asset of p.css.urlRefs) collectExternal(external, asset, p.rel, 'asset');

  const inHtmlText = pages.map((p) => p.page.bodyText).join(' ');
  return {
    site,
    pages,
    links,
    images,
    scripts,
    forms,
    css: allCss,
    external: dedupeExternal(external),
    title: pages.find((p) => p.rel === site.entry)?.title || pages[0]?.title || null,
    textLength: inHtmlText.length,
  };
}

function p0(rel) { return rel; }
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? squash(m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) : null;
}

function mergeColours(acc, css) {
  for (const [c, n] of css.colours) acc.colours.set(c, (acc.colours.get(c) || 0) + n);
  acc.background.push(...css.background);
  acc.foreground.push(...css.foreground);
  acc.mediaQueries.push(...css.mediaQueries);
  acc.fonts.push(...css.fonts);
  acc.imports.push(...css.imports);
  acc.urlRefs.push(...css.urlRefs);
}

function collectExternal(list, url, from, kind) {
  const c = classifyUrl(url);
  if (c.kind !== 'absolute') return;
  const host = hostOf(c.url) || (c.url.startsWith('//') ? hostOf(`https:${c.url}`) : null);
  if (!host) return;
  list.push({ url: c.url, host, kind, from, scheme: c.url.startsWith('//') ? 'inherit' : c.scheme });
}

function dedupeExternal(list) {
  const byKey = new Map();
  for (const e of list) {
    const key = `${e.host}|${e.kind}`;
    if (!byKey.has(key)) byKey.set(key, { ...e, pages: [e.from] });
    else if (!byKey.get(key).pages.includes(e.from)) byKey.get(key).pages.push(e.from);
  }
  return [...byKey.values()].sort((a, b) => a.host.localeCompare(b.host) || a.kind.localeCompare(b.kind));
}

/** Resolve a URL from a page to a path inside the collected site, if it is there. */
export function resolveInSite(url, pageRel, site) {
  const c = classifyUrl(url);
  if (c.kind === 'fragment' || c.kind === 'empty' || c.kind === 'scheme') return null;
  let target;
  if (c.kind === 'absolute') {
    const host = hostOf(c.url);
    if (site.host && host !== site.host) return null;
    try { target = new URL(c.url).pathname; } catch { return null; }
  } else if (c.kind === 'root-relative') {
    target = c.url;
  } else {
    target = path.posix.join(path.posix.dirname(pageRel), c.url.split('#')[0].split('?')[0]);
  }
  let rel = String(target).replace(/^\//, '').split('?')[0].split('#')[0];
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  return rel;
}

/* ── the findings ─────────────────────────────────────────────────────────── */

const F = (code, level, title, detail, action, evidence = []) => ({ code, level, title, detail, action, evidence });

/**
 * What a person needs to know before this becomes an app.
 *
 * Levels mean what they say:
 *   blocking — an app built from this would not work as it stands
 *   warning  — it will work, but something needs a decision
 *   info     — worth knowing, nothing to do
 */
export function findingsFor(site, model) {
  const found = [];
  const { pages, external, forms, links, images, textLength } = model;

  if (!pages.length) {
    found.push(F('no-pages', 'blocking', 'No pages were found',
      site.kind === 'local' ? `Nothing to read in ${site.root}: no .html or .htm files.` : `Nothing was fetched from ${site.entryUrl}.`,
      'Check the address, or point the analyser at a directory containing the site.'));
    return found;
  }

  const noTitle = pages.filter((p) => !p.title);
  if (!model.title) {
    found.push(F('no-title', 'blocking', 'The pages have no title',
      'Every page is missing <title>, so the app has no name to take and no label for the recent-apps list.',
      'Pass --name to choose one.',
      noTitle.map((p) => p.rel)));
  }

  const noViewport = pages.filter((p) => !p.page.meta.viewport);
  if (noViewport.length) {
    found.push(F('no-viewport', 'warning', 'No mobile viewport',
      'Without <meta name="viewport" content="width=device-width"> the WebView renders the page at desktop width and shrinks it to fit, so the text is small and the layout is wrong on a phone.',
      'Add the viewport meta tag to the site, or accept that the app will show the desktop layout.',
      noViewport.map((p) => p.rel)));
  }

  const mixed = external.filter((e) => e.scheme === 'http');
  if (mixed.length) {
    found.push(F('mixed-content', 'blocking', 'Part of the page is served over http',
      `The app refuses cleartext traffic by default (Android blocks it on modern versions), so these will not load: ${mixed.map((e) => e.host).join(', ')}.`,
      'Serve them over https, or accept a broken-looking page.',
      mixed.map((e) => e.url)));
  }

  const third = external.filter((e) => KNOWN_THIRD_PARTIES.some((k) => k.pattern.test(e.host)));
  if (third.length) {
    const described = [...new Set(third.map((e) => {
      const known = KNOWN_THIRD_PARTIES.find((k) => k.pattern.test(e.host));
      return `${e.host} (${known.what})`;
    }))];
    found.push(F('third-parties', 'warning', 'The page loads from other companies',
      `The site calls out to ${described.join(', ')}. The app does not block or rewrite these: they load when the phone has a network, exactly as they do in a browser. Anyone using the app is subject to those parties' tracking just as on the website.`,
      'Leave it, or remove the third-party tags from the site before bundling.',
      third.map((e) => e.url)));
  }

  const remoteAssets = external.filter((e) => !KNOWN_THIRD_PARTIES.some((k) => k.pattern.test(e.host)));
  if (remoteAssets.length) {
    found.push(F('external-assets', 'warning', 'Some files are not bundled for offline use',
      `These load from other hosts, so they need a network connection and will be missing offline: ${[...new Set(remoteAssets.map((e) => e.url))].slice(0, 8).join(', ')}${remoteAssets.length > 8 ? `, and ${remoteAssets.length - 8} more` : ''}.`,
      'Download them into the site so the app is complete offline, or accept that the app needs a connection for those files.',
      remoteAssets.map((e) => e.url)));
  }

  const serverForms = forms.filter((f) => f.action && classifyUrl(f.action).kind === 'absolute');
  if (serverForms.length) {
    found.push(F('form-needs-server', 'warning', 'A form submits to a server',
      `The app can show and fill in ${serverForms.length === 1 ? 'a form' : 'these forms'}, but pressing send needs the site's own server to accept it. Offline, the person will fill it in and nothing will happen.`,
      'Keep the form for online use, or add a telephone or email link as an offline path.',
      serverForms.map((f) => `${f.from}: ${f.method.toUpperCase()} ${f.action}`)));
  }

  const fileInputs = forms.flatMap((f) => f.inputs.filter((i) => i.type === 'file'));
  if (fileInputs.length) {
    found.push(F('file-upload', 'info', 'The page has a file picker',
      'A file input needs the app to hand the chosen file to the page; the generated app enables that.',
      'Nothing to do.'));
  }

  /*
   * Will the page be empty until a script runs?
   *
   * The first version of this asked whether a page had fewer than 200
   * characters of text and any script at all, which flagged three ordinary small
   * pages of a working website — a menu, an order form, an about page — as
   * probably client-rendered. A warning that fires on healthy input is worse than
   * no warning, because it teaches people to ignore the list.
   *
   * So it now looks for the two things that actually mean it. A framework's
   * mount point is one: an empty container plus the framework's own marker is
   * what a single-page app looks like before it runs. Failing that, text that is
   * a vanishingly small share of the file: a page that is almost all markup has
   * its words somewhere else.
   */
  const SPA_MARKERS = [
    /id=["'](root|app|__next|__nuxt|svelte)["']/i,
    /__NEXT_DATA__|window\.__NUXT__|__remixContext|data-reactroot/i,
    /<script[^>]+type=["']module["'][^>]*src=/i,
  ];
  const clientRendered = pages.filter((p) => {
    const text = p.page.bodyText.length;
    const scripts = p.page.scripts.length + p.page.inlineScripts;
    if (!scripts) return false;
    const emptyContainer = SPA_MARKERS.some((re) => re.test(p.html ?? ''));
    // 400 characters is a paragraph; below that with almost no text per byte of
    // markup, the words are arriving from somewhere else.
    const starved = text < 400 && p.bytes > 400 && text / p.bytes < 0.05;
    return emptyContainer || starved;
  });
  if (clientRendered.length) {
    found.push(F('client-rendered', 'warning', 'Some pages may be drawn by JavaScript',
      `${clientRendered.map((p) => p.rel).join(', ')} ${clientRendered.length === 1 ? 'looks' : 'look'} like a page whose content is built or fetched after it loads, rather than written in the HTML. The app allows JavaScript, so with a network this works exactly as it does in a browser — but with the network off, the page may arrive empty.`,
      'Check the app on a device with the network off before trusting it offline.',
      clientRendered.map((p) => `${p.rel}: ${p.page.bodyText.length} characters of text in ${p.bytes} bytes`)));
  }

  const internalLinks = links.filter((l) => l.kind === 'relative' || l.kind === 'root-relative');
  const outside = [];
  for (const l of internalLinks) {
    const target = resolveInSite(l.url, l.from, site);
    if (!target) continue;
    const exists = site.pages.some((p) => p.rel === target) || site.assets.some((a) => a.rel === target);
    if (!exists) outside.push(`${l.from} → ${l.url}`);
  }
  if (outside.length) {
    found.push(F('missing-targets', 'warning', `${outside.length} link${outside.length === 1 ? ' goes' : 's go'} somewhere that is not in the app`,
      `These point to pages or files that were not collected, so in the app they will show "page not found": ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? `, and ${outside.length - 6} more` : ''}.`,
      'Collect the missing files, or accept the broken links.',
      outside));
  }

  const phoneLinks = links.filter((l) => l.kind === 'scheme' && ['tel', 'mailto', 'sms', 'whatsapp'].includes(l.scheme));
  if (phoneLinks.length) {
    found.push(F('hand-off-links', 'info', `${phoneLinks.length} link${phoneLinks.length === 1 ? '' : 's'} handed to another app`,
      `Links to ${[...new Set(phoneLinks.map((l) => `${l.scheme}:`))].join(', ')} open the phone, mail or messaging app. The generated app allows this.`,
      'Nothing to do.'));
  }

  if (!model.css.mediaQueries.length) {
    found.push(F('no-media-queries', 'info', 'The stylesheet does not adapt to screen width',
      'No @media rules were found, so one layout serves every screen. On a phone it will look like the desktop version, scaled.',
      'Nothing to do if the layout is already narrow.'));
  }

  const heavy = site.pages.reduce((n, p) => n + p.bytes, 0) + site.assets.reduce((n, a) => n + a.bytes, 0);
  found.push(F('bundle-size', heavy > 8 * 1024 * 1024 ? 'warning' : 'info',
    `The app will carry ${humanBytes(heavy)} of site`,
    `${pages.length} page${pages.length === 1 ? '' : 's'} and ${site.assets.length} file${site.assets.length === 1 ? '' : 's'} will be inside the app. That is what makes it work with no network.`,
    heavy > 8 * 1024 * 1024 ? 'Consider compressing the images: everything here is downloaded once per install.' : 'Nothing to do.'));

  if (site.skipped?.length) {
    found.push(F('skipped-files', 'info', `${site.skipped.length} file${site.skipped.length === 1 ? '' : 's'} left out`,
      `Not bundled: ${site.skipped.slice(0, 6).map((s) => `${s.rel} (${s.why})`).join(', ')}${site.skipped.length > 6 ? `, and ${site.skipped.length - 6} more` : ''}.`,
      'Nothing to do unless one of them was needed.'));
  }

  for (const note of site.notes || []) found.push(F('collection-limit', 'warning', 'Not everything on the site was collected', note, 'Raise the limit if the whole site is wanted.'));
  if (!images.some((i) => i.alt)) found.push(F('no-alt-text', 'info', 'Images have no alt text', 'No image describes itself in words. That affects screen-reader users of the website and of the app, which shows the same pages.', 'Nothing to do here; a note for the site itself.'));

  return found.sort((a, b) => levelRank(a.level) - levelRank(b.level) || a.code.localeCompare(b.code));
}

const levelRank = (l) => ({ blocking: 0, warning: 1, info: 2 }[l] ?? 3);

/** Sizes in the unit a person would use: 480 KB, not 0.0 MB. */
export function humanBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ── the specification ────────────────────────────────────────────────────── */

/** A name that fits Google Play, cut at a word boundary rather than mid-word. */
export function playSafeName(raw, { limit = 30 } = {}) {
  const clean = squash(String(raw || '')).replace(/\s*[|·•]\s*/g, ' — ');
  // Marketing titles are usually "Name — tagline". Take the name, when what is
  // left still looks like one.
  const head = clean.split(/\s+—\s+|\s+-\s+/)[0].trim();
  const candidate = head.length >= 3 ? head : clean;
  if (candidate.length <= limit) return { name: candidate, truncated: false, original: clean };
  const cut = candidate.slice(0, limit + 1);
  const atWord = cut.lastIndexOf(' ');
  const name = (atWord >= limit * 0.5 ? cut.slice(0, atWord) : cut.slice(0, limit)).trim();
  return { name, truncated: true, original: clean };
}

/** Directory names that say nothing about the app they hold. */
const GENERIC_DIRS = new Set(['site', 'www', 'public', 'dist', 'build', 'out', 'htdocs', 'web', 'html', 'src']);

/**
 * A package name that is valid, stable, and says where it came from.
 *
 * `provided` is what a person asked for and is returned untouched — if someone
 * types a package name they mean it, and the validator will tell them if it is
 * malformed rather than this quietly rewriting it.
 *
 * The first version of this function returned `hint` whenever one was given,
 * which is how a local site in a directory called "site" produced the package
 * name `site`: not a package name at all, and it validated, because the
 * validator only checks the shape. `hint` is now a suggestion to build from, and
 * `provided` is the one that is obeyed.
 */
export function packageFor({ provided, hint, host } = {}) {
  if (provided) return provided;
  if (host) {
    const labels = host.split('.').filter(Boolean);
    const withoutWww = labels[0] === 'www' ? labels.slice(1) : labels;
    // A hostname read backwards is already the package name Android expects:
    // bakery.example.org becomes org.example.bakery, and greenfield.in becomes
    // in.greenfield. The first version appended the first label as well, which
    // produced org.example.bakery.bakery — the label is already there, because it
    // is the last one after reversing.
    const reversed = [...withoutWww].reverse();
    if (reversed.length >= 2) return reversed.join('.');
    return ['com', 'appmint', compact(reversed[0] || 'site')].join('.');
  }
  // A local directory: use its name, but skip past names that describe a
  // hosting layout rather than an app ("web", "public", "dist").
  const parts = String(hint || '').split(/[\\/]+/).filter(Boolean);
  const useful = [...parts].reverse().find((p) => !GENERIC_DIRS.has(p.toLowerCase())) || parts[0] || 'site';
  return ['com', 'appmint', compact(useful)].join('.');
}

/** The palette, taken from the site rather than invented. */
export function themeFor(model) {
  const meta = model.pages.map((p) => p.page.meta.themeColor).find(Boolean) || null;
  const candidates = rankedColours(model.css).map((r) => r.colour).filter((c) => normaliseColour(c));
  const relLum = (c) => {
    const n = normaliseColour(c);
    if (!n) return null;
    return (0.2126 * parseInt(n.slice(1, 3), 16) + 0.7152 * parseInt(n.slice(3, 5), 16) + 0.0722 * parseInt(n.slice(5, 7), 16)) / 255;
  };

  // Which colour is "the" colour: the one the site repeats most that is not
  // nearly-white or nearly-black, because those carry no identity. A declared
  // theme-color beats any inference — the site said so itself.
  const colourful = candidates.filter((c) => { const l = relLum(c); return l !== null && l > 0.02 && l < 0.9; });
  let primary = normaliseColour(meta) || colourful[0] || candidates[0] || '#2563EB';

  // The background is chosen by what a background is, not by popularity: the
  // most-used colour that is actually light (or, failing that, actually dark).
  // Reading this off a plain "most common colour" list once produced a dark navy
  // background for a cream-coloured bakery's website, because the fallback
  // assumed a dark primary implied a dark site.
  const byLum = (test) => candidates.find((c) => { const l = relLum(c); return l !== null && test(l); });
  // A colour that a stylesheet used in a background declaration is better
  // evidence than one that merely appears often: a repeated colour is usually
  // text, a background colour is a background.
  const declared = (model.css.background || []).filter(Boolean);
  const background = declared.find((c) => (relLum(c) ?? 1) > 0.75)
    || declared.find((c) => (relLum(c) ?? 0) < 0.12)
    || byLum((l) => l > 0.75) || byLum((l) => l < 0.12) || '#FFFFFF';

  // Surfaces are a small step away from the background. They are not taken from
  // the site's text colour, which is what the first version did — the most-used
  // `color:` value is ink, and using it as a surface produced a card the exact
  // colour of the text on it.
  const surface = shadeIfNeeded(background);

  // The palette must not fail the contrast rules the validator enforces. If the
  // site's own colour cannot carry its text, it is nudged until it can, and the
  // adjustment is recorded rather than hidden.
  const onPrimaryWanted = readableOn(primary);
  const primaryFix = ensureContrast(primary, onPrimaryWanted === '#000000' ? '#000000' : '#FFFFFF');
  primary = primaryFix.colour;

  return {
    theme: {
      primary,
      onPrimary: readableOn(primary) || '#FFFFFF',
      background,
      surface,
      onSurface: readableOn(surface) || '#FFFFFF',
      accent: candidates.find((c) => c !== primary && c !== background && relLum(c) > 0.15 && relLum(c) < 0.95) || primary,
      statusBarStyle: readableOn(primary) === '#000000' ? 'light' : 'dark',
    },
    evidence: {
      metaThemeColor: normaliseColour(meta),
      coloursSeen: candidates.slice(0, 8),
      contrastAdjusted: primaryFix.changed,
      adjustedFrom: primaryFix.changed ? normaliseColour(meta) || null : null,
    },
  };
}

function shadeIfNeeded(background) {
  const b = normaliseColour(background) || '#FFFFFF';
  const lightBg = (parseInt(b.slice(1, 3), 16) + parseInt(b.slice(3, 5), 16) + parseInt(b.slice(5, 7), 16)) / 3 > 128;
  return lightBg ? '#F1F4F9' : '#151B2E';
}

/**
 * Turn a described site into a specification.
 *
 * The output is an ordinary specification — the same object a person would type
 * — so everything downstream (validation, permissions, generation, the cache)
 * treats an analysed site exactly like a hand-written app.
 */
export function proposeApp(model, { name, packageName, versionName = '1.0.0' } = {}) {
  const spec = defaultSpec();
  const site = model.site;
  const named = name ? { name, truncated: false, original: name } : playSafeName(model.title || site.host || 'My app');
  const themeResult = themeFor(model);

  spec.identity.appName = named.name;
  // `packageName` is what the caller asked for and is obeyed; the hint is the
  // directory the site came from, used only to build a name when nothing was
  // asked for.
  spec.identity.packageName = packageFor({
    provided: packageName,
    hint: site.root || null,
    host: site.host,
  });
  spec.identity.versionName = versionName;
  spec.identity.description = model.pages.map((p) => p.page.meta.description).find(Boolean)
    || `The ${named.name} website, in an app that works offline.`;

  spec.app.mode = 'webview';
  spec.app.webview = {
    ...spec.app.webview,
    /*
     * Where the app opens, stated honestly.
     *
     * For a site that was fetched, this is its real address. For a directory of
     * files there may be no address at all, and the first version left the
     * placeholder https://example.com in place — a specification claiming the app
     * opens a website that has nothing to do with it. When the site's address is
     * unknown, this records the bundled asset URL, which is precisely the address
     * the generated app loads, so the field is true even when it is not a
     * website.
     */
    startUrl: site.entryUrl
      || `https://appassets.androidplatform.net/assets/www/${(site.entry || 'index.html').replace(/^\/+/, '')}`,
    localAsset: site.entry || 'index.html',
    allowedHosts: site.host ? [site.host] : [],
    javascriptEnabled: true,
    domStorage: true,
    externalLinks: 'custom-tab',
    fileUploads: model.forms.some((f) => f.inputs.some((i) => i.type === 'file')),
    zoom: false,
  };
  spec.android.orientation = 'unspecified';
  spec.theme = themeResult.theme;
  spec.deepLinks.customScheme = compact(named.name);

  // Only capabilities the site actually shows a need for. Nothing is added for
  // symmetry, and nothing here grants a permission that the analyser did not
  // find a reason for.
  const caps = new Set();
  const capReasons = [];
  const add = (cap, why) => { if (!caps.has(cap)) { caps.add(cap); capReasons.push({ cap, why }); } };
  add('share', 'a page in an app is worth sharing, and sharing needs no permission');
  if (model.links.some((l) => l.kind === 'scheme' && l.scheme === 'tel') || model.textLength > 0) add('clipboard', 'copying an address or a price out of the page; Android restricts background reads itself');
  if (model.forms.some((f) => f.inputs.some((i) => i.type === 'file'))) add('files', 'the site has a file picker');
  spec.capabilities = [...caps];
  spec.capabilitiesReason = capReasons;

  return { spec, name: named, theme: themeResult };
}

/* ── writing the app ──────────────────────────────────────────────────────── */

/**
 * Rewrite the URLs a local WebView cannot resolve.
 *
 * The generated app serves bundled pages through Android's WebViewAssetLoader at
 * https://appassets.androidplatform.net/assets/www/<entry>, whose /assets/ path
 * is the app's own asset root. A page that asks for `/assets/style.css` therefore
 * asks for a file at the asset root, not for the one at assets/www/assets/, and
 * arrives unstyled and without images. Absolute URLs pointing at the site itself
 * fail the other way round: they reach across the network for a copy of a file
 * that is already inside the app.
 *
 * Both are rewritten to a path relative to the page, and every single rewrite is
 * returned so it can be shown. A link to something that is not in the bundle is
 * left exactly as it was — rewriting it to a path that does not exist would turn
 * a working link into a broken one.
 */
export function planRewrites(site, pageRel, html) {
  const rewrites = [];
  const pageDir = path.posix.dirname(pageRel);
  const known = new Set([...site.pages.map((p) => p.rel), ...site.assets.map((a) => a.rel)]);

  const resolved = (url) => {
    const target = resolveInSite(url, pageRel, site);
    if (!target || !known.has(target)) return null;
    const relative = path.posix.relative(pageDir, target) || target;
    return relative.startsWith('.') ? relative : `./${relative}`;
  };

  const out = html.replace(/\b(href|src|poster|action|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, attr, quoted, dq, sq) => {
    const value = dq ?? sq ?? '';
    const kind = classifyUrl(value);
    if (kind.kind !== 'root-relative' && kind.kind !== 'absolute') return whole;
    const rel = resolved(value);
    if (!rel) return whole;
    rewrites.push({ page: pageRel, attr, from: value, to: rel });
    const quote = dq !== undefined ? '"' : "'";
    return `${attr}=${quote}${rel}${quote}`;
  }).replace(/url\(\s*(['"]?)(\/[^'")]+)\1\s*\)/g, (whole, quote, value) => {
    const rel = resolved(value);
    if (!rel) return whole;
    rewrites.push({ page: pageRel, attr: 'css url()', from: value, to: rel });
    return `url(${quote}${rel}${quote})`;
  });

  return { html: out, rewrites };
}

/**
 * Write an analysed site out as an app: the bundle, the specification, and the
 * analysis itself.
 *
 * The analysis is written next to the app because a specification built by a
 * tool has to be able to answer "why does it say that?" months later, when the
 * person who ran it has forgotten and the site has changed.
 */
export function writeApp({ model, proposal, outDir, analysis = null }) {
  const site = model.site;
  const webDir = path.join(outDir, 'web');
  fs.mkdirSync(webDir, { recursive: true });

  const rewrites = [];
  for (const page of site.pages) {
    const planned = planRewrites(site, page.rel, page.html);
    rewrites.push(...planned.rewrites);
    const target = path.join(webDir, page.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, planned.html);
  }
  for (const asset of site.assets) {
    const target = path.join(webDir, asset.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A local site has the bytes on disk; a fetched site has them in memory
    // under `data`. Both end up as files in the app.
    fs.writeFileSync(target, asset.data !== undefined ? asset.data : fs.readFileSync(asset.file));
  }

  const spec = { ...proposal.spec };
  // The rewrite list is part of what was built, so it belongs with the build.
  fs.writeFileSync(path.join(outDir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
  if (analysis) fs.writeFileSync(path.join(outDir, 'analysis.json'), `${JSON.stringify({ ...analysis, rewrites }, null, 2)}\n`);
  return { spec, rewrites, webDir };
}

/* ── one call that does the whole thing ───────────────────────────────────── */

/**
 * Describe a site, decide what app it should become, and optionally write it.
 *
 * The order is deliberate: read, describe, find problems, then propose. The
 * proposal is built from the description, so a specification's choices can
 * always be traced back to something the site actually contains.
 */
export async function analyse(target, {
  out = null, name = null, packageName = null, versionName = '1.0.0',
  site = null, fetchOptions = {},
} = {}) {
  let collected = site;
  if (!collected) {
    collected = /^https?:\/\//i.test(target)
      ? await fetchSite(target, fetchOptions)
      : readLocalSite(target);
  }
  const model = describeSite(collected);
  const findings = findingsFor(collected, model);
  const proposal = proposeApp(model, { name, packageName, versionName });
  const analysis = {
    analyser: 'appmint-website-analyser',
    version: 1,
    target,
    kind: collected.kind,
    entry: collected.entry,
    host: collected.host || null,
    pages: collected.pages.map((p) => ({ rel: p.rel, bytes: p.bytes })),
    assets: collected.assets.map((a) => ({ rel: a.rel, bytes: a.bytes })),
    skipped: collected.skipped,
    findings,
    theme: proposal.theme,
    proposal: {
      appName: proposal.spec.identity.appName,
      namedFrom: proposal.name.original,
      nameTruncated: proposal.name.truncated,
      packageName: proposal.spec.identity.packageName,
      capabilities: proposal.spec.capabilities,
      capabilitiesReason: proposal.spec.capabilitiesReason,
    },
    summary: {
      blocking: findings.filter((f) => f.level === 'blocking').length,
      warning: findings.filter((f) => f.level === 'warning').length,
      info: findings.filter((f) => f.level === 'info').length,
    },
  };

  let written = null;
  if (out) written = writeApp({ model, proposal, outDir: out, analysis });

  return { model, findings, proposal, analysis, written };
}
