/**
 * COLLECTING A SITE, AND WRITING AN APP OUT
 * =========================================
 *
 * Everything with a side effect: reading a directory, fetching over the network,
 * writing files to disk. The decisions — what the site is, what app it should
 * become, what is wrong with it — are in site.mjs, which is pure and which the
 * Studio inlines, so that a phone and a build pipeline give the same answers.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parsePage, classifyUrl, squash } from './html.mjs';
import { PAGE_EXT, ASSET_EXT, isTextExt, describeSite, findingsFor, proposeApp, planRewrites } from './site.mjs';

// Everything the pure core offers is re-exported, so a caller has one module to
// import from and does not need to know how this was split.
export * from './site.mjs';

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
      // The reader is attached here rather than in the pure core, so that the
      // core never has to know whether the bytes came from a disk, a fetch or a
      // phone's storage. Text files can be read as text; images are left as
      // files and are copied byte for byte.
      assets.push({
        rel,
        file: full,
        bytes: fs.statSync(full).size,
        readText: isTextExt(ext) ? () => fs.readFileSync(full, 'utf8') : undefined,
      });
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
