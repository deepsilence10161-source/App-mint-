/**
 * ⚡ AppKaro Server — zero-dependency (Node 18+)
 *
 *  Smart Scale System (docs/SCALE-PLAN.md):
 *   L1 → Queue + live ETA + per-lane concurrency guards (20-limit कभी hit नहीं)
 *   L3 → config-hash instant dedup + build cache (repeat build ~free)
 *   L4 → Fairness: 1 active build/user + दैनिक cap (abuse से क़तार बचती है)
 *   Lanes: user-gh (optional turbo) / pool (central) / demo / dedup
 *
 *  Secrets केवल env में। Signing हमेशा server पर।
 */
'use strict';

/* silent death नहीं — production में systemd/pm2 से auto-restart रखना */
process.on('unhandledRejection', e => console.error('⚠️  unhandledRejection:', e));
process.on('uncaughtException', e => console.error('⚠️  uncaughtException:', e));

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const auth = require('./auth');
const github = require('./github');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const ART_DIR = path.join(DATA_DIR, 'artifacts');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
const DB_FILE = path.join(DATA_DIR, 'builds.json');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';        // central pool "owner/repo"
const CENTRAL_LIVE = !!(GITHUB_TOKEN && GITHUB_REPO);
const DEMO_STEP_MS = Number(process.env.DEMO_STEP_MS || 3000);

/* ---- L1: lane concurrency guards (GitHub hosted Free ceiling = 20 — हम कभी भरी नहीं) ---- */
const LANES = {
  pool:      { max: Math.max(1, Math.min(20, Number(process.env.POOL_MAX_CONCURRENT || 20))) },
  'user-gh': { max: Math.max(1, Number(process.env.USER_GH_MAX_CONCURRENT || 5)) },
  demo:      { max: Math.max(1, Number(process.env.DEMO_MAX_CONCURRENT || 2)) },
};

/* ---- L4: fairness (एक user क़तार highjack न करे) ---- */
const FAIR_ACTIVE_PER_USER = Number(process.env.FAIR_ACTIVE_PER_USER || 1);
const DAILY_BUILD_CAP = Number(process.env.DAILY_BUILD_CAP || 5);
const DEFAULT_AVG_MIN = Number(process.env.DEFAULT_AVG_BUILD_MIN || 8);

const ACTIVE = new Set(['queued', 'dispatched', 'building', 'signing']);

fs.mkdirSync(ART_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });

/* ---------------- store ---------------- */
let builds = [];
try { builds = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { builds = []; }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(builds, null, 2));

const ALLOWED_PERMS = ['NOTIFICATIONS', 'CAMERA', 'MIC', 'LOCATION'];

/* uploaded icons — CI runner यहाँ से curl करके bake करता है */
const ICONS_DIR = path.join(PUBLIC_DIR, 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

/* ---------------- validation ---------------- */
function validate(body) {
  const errors = [];
  const url = String(body.url || '').trim();
  if (!/^https?:\/\/[\w.-]+(?::\d+)?(\/.*)?$/i.test(url)) errors.push('सही URL दें — http:// या https:// सहित');
  let name = String(body.name || '').trim().replace(/["'\\]/g, '').slice(0, 40);
  if (name.length < 2 && url) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      name = h.charAt(0).toUpperCase() + h.slice(1);
    } catch { name = 'My App'; }
  }
  let pkg = String(body.packageId || '').trim().toLowerCase().replace(/["'\\]/g, '');
  if (pkg && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) errors.push('Package ID गलत है — जैसे com.mera.app');
  if (!pkg) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '') || 'app';
      pkg = 'com.appkaro.' + h;
    } catch { pkg = 'com.appkaro.app'; }
  }
  const color = /^#[0-9a-f]{6}$/i.test(body.themeColor || '') ? body.themeColor : '#6C5CE7';
  let permissions = Array.isArray(body.permissions) ? body.permissions.filter(p => ALLOWED_PERMS.includes(p)) : ['NOTIFICATIONS'];
  if (!permissions.length) permissions = ['NOTIFICATIONS'];

  /* 💰 earning + 🔔 push — खाली रखने पर feature पूरी तरह बाहर */
  const ads = /^ca-app-pub-\d{16}~\d{10}$/.test(body.admobAppId || '') ? body.admobAppId : '';
  if (body.admobAppId && !ads) errors.push('AdMob App ID गलत है — ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY format (App ID, unit नहीं)');
  const adUnit = /^ca-app-pub-\d{16}\/\d{10}$/.test(body.admobUnitId || '') ? body.admobUnitId : '';
  if (body.admobUnitId && !adUnit) errors.push('AdMob Unit ID गलत है — ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY format');
  if (adUnit && !ads) errors.push('AdMob Unit दी है पर App ID नहीं — दोनों डालें या दोनों खाली');
  const push = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.oneSignalAppId || '') ? body.oneSignalAppId : '';
  if (body.oneSignalAppId && !push) errors.push('OneSignal App ID गलत है — UUID format (xxxxxxxx-xxxx-…, apps.onesignal.com से)');

  return { errors, cfg: { url, name, pkg, color, permissions, cleartext: body.cleartext === true, ads, adUnit, push } };
}

/* ---------------- L3: config dedup ---------------- */
function buildHash(cfg, iconUrl) {
  return crypto.createHash('sha256').update(JSON.stringify([
    cfg.url, cfg.name, cfg.pkg, cfg.color.toLowerCase(),
    [...cfg.permissions].sort(), cfg.cleartext, iconUrl || '',
    cfg.ads || '', cfg.adUnit || '', cfg.push || '',
  ])).digest('hex');
}
const copyDir = (s, d) => { fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(s, d, { recursive: true }); };

/* ---------------- L1: queue maths ---------------- */
function avgBuildMin() {
  const done = builds.filter(b => b.completedAt && b.createdAt).slice(0, 20);
  if (!done.length) return DEFAULT_AVG_MIN;
  /* stale/restarted builds avg गन्दा न करें — 30 मिनट से लंबी durations ignore */
  const sane = done
    .map(b => (b.completedAt - b.createdAt) / 60000)
    .filter(m => m > 0 && m <= 30);
  if (!sane.length) return DEFAULT_AVG_MIN;
  return Math.max(0.5, sane.reduce((a, m) => a + m, 0) / sane.length);
}
const inFlight = lane => builds.filter(x => x.engine === lane && ['dispatched', 'building'].includes(x.status)).length;
function queueInfo(b) {
  if (b.status !== 'queued') return null;
  const lane = b.engine || 'demo';
  const ahead = builds.filter(x => x.id !== b.id && x.engine === lane && ACTIVE.has(x.status) && x.createdAt <= b.createdAt).length;
  const cap = (LANES[lane] && LANES[lane].max) || 1;
  return {
    position: ahead + 1,
    etaMin: Math.max(1, Math.ceil((ahead * avgBuildMin()) / cap)),
    avgMin: Math.round(avgBuildMin() * 10) / 10,
  };
}

/* ---------------- fairness ---------------- */
function ownerKeyOf(req, sess) {
  if (sess) return 'u:' + sess.sub;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'anon';
  return 'ip:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}
function fairnessCheck(key) {
  const active = builds.filter(x => x.ownerKey === key && ACTIVE.has(x.status) && x.engine !== 'dedup').length;
  if (active >= FAIR_ACTIVE_PER_USER) {
    return 'एक समय पर 1 build — पहले वाली पूरी होने दो। (Hint: Settings से GitHub Turbo जोड़ो — optional — तो क़तार से बाहर)';
  }
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const today = builds.filter(x => x.ownerKey === key && x.createdAt > dayAgo).length;
  if (today >= DAILY_BUILD_CAP) {
    return `आज की free limit (${DAILY_BUILD_CAP} builds) पूरी — कल फिर आना, या कमाई शुरू होने पर Pro plan।`;
  }
  return null;
}

/* ---------------- engine resolution ---------------- */
function resolveEngine(b) {
  if (b.owner) {
    const u = auth.getUser(b.owner);
    if (u && u.gh && u.gh.tokenEnc) return { lane: 'user-gh', repo: u.gh.repo, token: auth.vaultDec(u.gh.tokenEnc) };
  }
  if (CENTRAL_LIVE) return { lane: 'pool', repo: GITHUB_REPO, token: GITHUB_TOKEN };
  return null;
}

/* T1 provisioning hook */
function onGithubConnected(user, token) {
  return github.ensureRepo(token).then(full => {
    console.log(`  ✅ T1 repo ready: ${full} (user ${user.sub})`);
    return full;
  }).catch(e => { console.warn(`  ⚠️  T1 provisioning: ${e.message}`); return null; });
}

/* ---------------- signing (server-side) ---------------- */
const which = cmd => new Promise(ok => execFile('which', [cmd], e => ok(!e)));

async function trySign(b) {
  if (!b.apkFile) return;
  b.apkUnsigned = b.apkFile;   // dedup में दोबारा काम आएगा
  const hasKeytool = await which('keytool');
  const hasApksigner = await which('apksigner');
  const hasJarsigner = await which('jarsigner');
  if (!hasKeytool || (!hasApksigner && !hasJarsigner)) {
    b.signNote = 'signing tools नहीं (keytool/apksigner/jarsigner) — unsigned रखा';
    return;
  }
  const ks = path.join(KEYS_DIR, (b.owner || 'default') + '.keystore');
  const pass = process.env.KEYSTORE_PASS || 'appkaro-' + (b.owner || 'default');
  if (!fs.existsSync(ks)) {
    await new Promise((ok, bad) => execFile('keytool', [
      '-genkeypair', '-v', '-keystore', ks, '-alias', 'appkaro', '-keyalg', 'RSA',
      '-keysize', '2048', '-validity', '10950', '-storepass', pass, '-keypass', pass,
      '-dname', 'CN=AppKaro User, OU=Apps, O=AppKaro, C=IN',
    ], e => (e ? bad(e) : ok())));
  }
  const dir = path.join(ART_DIR, b.id);
  const unsignedPath = path.join(dir, b.apkUnsigned);
  const signedPath = path.join(dir, b.apkUnsigned.replace('-unsigned', '-signed'));
  fs.copyFileSync(unsignedPath, signedPath);
  if (hasApksigner) {
    await new Promise((ok, bad) => execFile('apksigner', [
      'sign', '--ks', ks, '--ks-pass', 'pass:' + pass,
      '--ks-key-alias', 'appkaro', '--key-pass', 'pass:' + pass,
      '--out', signedPath, signedPath,
    ], e => (e ? bad(e) : ok())));
  } else {
    /* fallback: jarsigner (v1) — sideload के लिए valid; production में apksigner (build-tools) लगाएँ */
    await new Promise((ok, bad) => execFile('jarsigner', [
      '-keystore', ks, '-storepass', pass, '-keypass', pass,
      '-signedjar', signedPath, unsignedPath, 'appkaro',
    ], e => (e ? bad(e) : ok())));
    b.signNote = 'v1 (jarsigner) से signed — installable ✅ · production में apksigner recommended';
  }
  b.apkFile = path.basename(signedPath);
  b.signed = true;
}

/* ---------------- queue worker ---------------- */
const DEMO_FLOW = ['queued', 'dispatched', 'building', 'signing', 'demo_ready'];

async function tick() {
  const queue = builds
    .filter(b => !['ready', 'failed', 'demo_ready'].includes(b.status))
    .sort((a, b2) => (b2.engine === 'user-gh') - (a.engine === 'user-gh'));

  for (const b of queue) {
    try {
      const age = Date.now() - (b.statusAt || b.createdAt);

      /* --- L3 instant dedup: सीधे signing --- */
      if (b.engine === 'dedup') {
        await trySign(b);
        b.status = 'ready'; b.statusAt = Date.now(); b.completedAt = Date.now(); save();
        continue;
      }

      /* --- DEMO lane --- */
      if (b.engine === 'demo') {
        if (b.status === 'queued' && inFlight('demo') >= LANES.demo.max) continue; // क़तार
        const stageMs = b.status === 'building' ? DEMO_STEP_MS * 4 : DEMO_STEP_MS;
        if (age >= stageMs) {
          b.status = DEMO_FLOW[DEMO_FLOW.indexOf(b.status) + 1];
          b.statusAt = Date.now();
          if (b.status === 'demo_ready') b.completedAt = Date.now();
          save();
        }
        continue;
      }

      /* --- LIVE lanes (T1 user-gh / T0 pool) --- */
      const eng = resolveEngine(b);
      if (!eng) { b.engine = 'demo'; save(); continue; }    // graceful degrade

      if (b.status === 'queued') {
        if (inFlight(eng.lane) >= ((LANES[eng.lane] && LANES[eng.lane].max) || 99)) continue; // क़तार — 20-limit respect
        if (eng.lane === 'user-gh' && !eng.repo) {
          const full = await github.ensureRepo(eng.token);
          const u = auth.getUser(b.owner);
          auth.upsertUser(b.owner, { gh: { ...u.gh, repo: full } });
          eng.repo = full;
        }
        await github.dispatch(eng.repo, eng.token, {
          build_id: b.id, app_name: b.cfg.name, package_id: b.cfg.pkg,
          start_url: b.cfg.url, theme_color: b.cfg.color, icon_url: b.iconUrl || '',
          permissions: b.cfg.permissions.join(','), cleartext: String(b.cfg.cleartext),
          admob_app_id: b.cfg.ads || '', admob_unit_id: b.cfg.adUnit || '',
          onesignal_app_id: b.cfg.push || '',
        });
        b.engine = eng.lane; b.repo = eng.repo;
        b.status = 'dispatched'; b.statusAt = Date.now(); save();
      } else if (b.status === 'dispatched' || b.status === 'building') {
        if (age > 15 * 60 * 1000) { b.status = 'failed'; b.error = 'CI timeout'; b.completedAt = Date.now(); save(); continue; }
        const run = await github.findRun(b.repo || eng.repo, eng.token, b.id);
        if (!run) continue;
        b.runUrl = run.html_url;
        if (run.status !== 'completed') { if (b.status !== 'building') { b.status = 'building'; save(); } continue; }
        if (run.conclusion !== 'success') { b.status = 'failed'; b.error = 'CI failed: ' + run.conclusion; b.completedAt = Date.now(); save(); continue; }
        const dir = path.join(ART_DIR, b.id);
        fs.rmSync(dir, { recursive: true, force: true });
        const files = await github.downloadArtifact(b.repo || eng.repo, eng.token, run.id, dir);
        b.apkFile = files.find(f => f.endsWith('.apk')) || null;
        b.aabFile = files.find(f => f.endsWith('.aab')) || null;
        b.status = 'signing'; b.statusAt = Date.now(); save();
      } else if (b.status === 'signing') {
        await trySign(b);
        b.status = 'ready'; b.statusAt = Date.now(); b.completedAt = Date.now(); save();
      }
    } catch (e) {
      b.status = 'failed'; b.error = String(e.message || e); b.completedAt = Date.now(); save();
      console.error(`  ❌ build ${b.id} fail:`, e.message);
    }
  }
}
setInterval(tick, 4000);

/* ---------------- ~L2: local artifact hygiene (R2 जुड़ने तक इंतज़ाम) ------------
 * पूरी हो चुकी builds के artifacts ARTIFACT_TTL_DAYS बाद साफ़ — disk कभी न भरे।
 * R2 storage (S3-compatible) Phase 2 में जुड़ेगा — तब ये सीधे bucket में चले जाएँगे। */
const ART_TTL_DAYS = Number(process.env.ARTIFACT_TTL_DAYS || 3);
function sweepArtifacts() {
  const limit = Date.now() - ART_TTL_DAYS * 86400 * 1000;
  let purged = 0;
  for (const b of builds) {
    if (b.purged) continue;
    const doneAt = b.completedAt || b.createdAt || 0;
    if (['ready', 'failed', 'demo_ready'].includes(b.status) && doneAt < limit &&
        fs.existsSync(path.join(ART_DIR, b.id))) {
      fs.rmSync(path.join(ART_DIR, b.id), { recursive: true, force: true });
      b.purged = true; purged++;
    }
  }
  if (purged) { save(); console.log(`  🗑️  artifact sweep: ${purged} build(s) साफ़ (TTL ${ART_TTL_DAYS}d)`); }
}
sweepArtifacts();
setInterval(sweepArtifacts, 3600 * 1000);

/* ---------------- HTTP ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
};
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');

  if (auth.handleAuth(req, res, u, { onGithubConnected })) return;

  if (u.pathname === '/api/health') {
    return json(res, 200, {
      ok: true, mode: CENTRAL_LIVE ? 'live' : 'demo', pool: CENTRAL_LIVE ? GITHUB_REPO : null,
      features: { ads: true, push: true, assetlinks: true, iconBake: true, history: true },
      storage: 'local', artifactTtlDays: ART_TTL_DAYS,
    });
  }

  if (u.pathname === '/api/stats') {
    return json(res, 200, {
      ok: true,
      active: builds.filter(b => ACTIVE.has(b.status)).length,
      avgBuildMin: Math.round(avgBuildMin() * 10) / 10,
      lanes: Object.fromEntries(Object.entries(LANES).map(([k, v]) => [k, { max: v.max, busy: inFlight(k) }])),
      dailyCap: DAILY_BUILD_CAP,
    });
  }

  if (u.pathname === '/api/builds' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2_500_000) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, errors: ['खराब JSON'] }); }
      const { errors, cfg } = validate(body);
      if (errors.length) return json(res, 422, { ok: false, errors });

      const sess = auth.getSession(req);
      const key = ownerKeyOf(req, sess);

      /* icon upload: dataURL → public file → CI runner इसे curl करके bake करता है */
      let iconUrl = String(body.iconUrl || '');
      if (!iconUrl && typeof body.iconData === 'string') {
        const im = body.iconData.match(/^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/);
        if (im) {
          const buf = Buffer.from(im[2], 'base64');
          if (buf.length > 0 && buf.length <= 1_500_000) {
            const fn = 'icon_' + crypto.randomBytes(8).toString('hex') + (im[1] === 'image/png' ? '.png' : '.jpg');
            fs.writeFileSync(path.join(ICONS_DIR, fn), buf);
            const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
            iconUrl = proto + '://' + req.headers.host + '/icons/' + fn;
          }
        }
      }
      const hash = buildHash(cfg, iconUrl);

      /* ⚡ L3 dedup पहले देखो — instant है, fairness की ज़रूरत ही नहीं (cost ₹0) */
      const src = builds.find(x =>
        x.hash === hash && x.status === 'ready' && (x.apkUnsigned || x.apkFile) &&
        fs.existsSync(path.join(ART_DIR, x.id, x.apkUnsigned || x.apkFile)));
      if (!src) {
        const fair = fairnessCheck(key);
        if (fair) return json(res, 429, { ok: false, errors: [fair] });
      }

      const b = {
        id: 'ak_' + crypto.randomBytes(6).toString('hex'),
        cfg, iconUrl, hash,
        owner: sess ? sess.sub : null,
        ownerKey: key,
        engine: null, status: 'queued', statusAt: Date.now(), createdAt: Date.now(),
        signed: false, apkFile: null, aabFile: null, runUrl: null, repo: null,
      };

      if (src) {
        copyDir(path.join(ART_DIR, src.id), path.join(ART_DIR, b.id));
        b.engine = 'dedup';
        b.status = 'signing';
        b.apkFile = src.apkUnsigned || src.apkFile;
        b.aabFile = src.aabFile;
        b.dedupFrom = src.id;
        console.log(`  ⚡ instant dedup: ${b.id} ← ${src.id}`);
      } else {
        const eng = resolveEngine(b);
        b.engine = eng ? eng.lane : 'demo';
      }

      builds.unshift(b); save();
      json(res, 201, { ok: true, build: b });
    });
    return;
  }

  /* मेरी builds (dashboard/history) — ownerKey से */
  if (u.pathname === '/api/my/builds') {
    const sess = auth.getSession(req);
    const key = ownerKeyOf(req, sess);
    const mine = builds.filter(x => x.ownerKey === key).slice(0, 20)
      .map(x => ({ ...x, queue: queueInfo(x) }));
    return json(res, 200, { ok: true, builds: mine });
  }

  const m = u.pathname.match(/^\/api\/builds\/([\w-]+)(\/download)?$/);
  if (m) {
    const b = builds.find(x => x.id === m[1]);
    if (!b) return json(res, 404, { ok: false, error: 'build नहीं मिली' });
    if (m[2]) {
      const wantAab = u.searchParams.get('type') === 'aab';
      const file = wantAab ? b.aabFile : b.apkFile;
      if (b.purged) return json(res, 410, { ok: false, error: `artifacts ${ART_TTL_DAYS} दिन बाद साफ़ हो गए (storage बचाने के लिए) — दोबारा build बनाओ, smart-cache से चुटकियों में तैयार होगी` });
      if (!file || b.status !== 'ready') return json(res, 409, { ok: false, error: 'file अभी तैयार नहीं' });
      const p = path.join(ART_DIR, b.id, file);
      res.writeHead(200, {
        'Content-Type': wantAab ? 'application/octet-stream' : MIME['.apk'],
        'Content-Disposition': `attachment; filename="${b.cfg.name.replace(/\W+/g, '-')}.${wantAab ? 'aab' : 'apk'}"`,
      });
      return fs.createReadStream(p).pipe(res);
    }
    return json(res, 200, { ok: true, build: { ...b, queue: queueInfo(b) } });
  }

  /* 🔗 Deep links: assetlinks.json — signing keystore का SHA-256 से auto (Play deep-link fix) */
  const am = u.pathname.match(/^\/api\/builds\/([\w-]+)\/assetlinks\.json$/);
  if (am) {
    const b = builds.find(x => x.id === am[1]);
    if (!b) return json(res, 404, { ok: false, error: 'build नहीं मिली' });
    const owner = b.owner || 'default';
    const ks = path.join(KEYS_DIR, owner + '.keystore');
    if (!fs.existsSync(ks)) {
      return json(res, 409, {
        ok: false,
        error: 'यह build unsigned थी, इसलिए fingerprint नहीं बन सका। Signed build बनाओ — तब यहाँ तैयार assetlinks.json मिलेगा, जिसे अपनी site के /.well-known/assetlinks.json पर रखना है।',
      });
    }
    const pass = process.env.KEYSTORE_PASS || 'appkaro-' + owner;
    return execFile('keytool', ['-list', '-v', '-keystore', ks, '-storepass', pass, '-alias', 'appkaro'], (e, out) => {
      if (e) return json(res, 500, { ok: false, error: 'keystore पढ़ने में दिक्कत' });
      const fp = (out.match(/SHA256:\s*([0-9A-F:]+)/) || [])[1];
      if (!fp) return json(res, 500, { ok: false, error: 'fingerprint नहीं मिला' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: b.cfg.pkg, sha256_cert_fingerprints: [fp] },
      }], null, 2));
    });
    return;
  }

  /* static */
  let fp = path.normalize(path.join(PUBLIC_DIR, u.pathname === '/' ? 'index.html' : u.pathname));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ AppKaro server चालू: http://0.0.0.0:${PORT}`);
  console.log(`   engine: ${CENTRAL_LIVE ? 'HYBRID (T0 pool live + T1 ' + (auth.githubOauthReady() ? 'ready' : 'pending') + ')' : 'DEMO (pool नहीं जुड़ा)'}`);
  console.log(`   lanes:  pool=${LANES.pool.max} · user-gh=${LANES['user-gh'].max} · demo=${LANES.demo.max} · fairness=${FAIR_ACTIVE_PER_USER}/user, ${DAILY_BUILD_CAP}/day`);
  console.log(`   auth:   google=${auth.googleReady() ? '✅' : '⏳'} · github-oauth=${auth.githubOauthReady() ? '✅' : '⏳'} · demoAuth=${auth.isDemoAuth() ? 'on' : 'off'}`);
});
