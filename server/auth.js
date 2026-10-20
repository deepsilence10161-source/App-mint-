/**
 * 🔐 AppKaro auth module — zero-dependency (Node 18+)
 *
 *  · Google OAuth (यूज़र login)
 *  · Optional GitHub OAuth connect ("अपना GitHub जोड़ें" — T1 priority lane)
 *  · HMAC-signed session cookie + AES-256-GCM token vault
 *
 * सब secrets केवल env में:
 *   GOOGLE_CLIENT_ID/SECRET, GH_CLIENT_ID/SECRET, SERVER_SECRET, BASE_URL
 *   (कोई भी env न हो → DEMO auth mode, flow test हो सकता है)
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let users = [];
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = []; }
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const SECRET = process.env.SERVER_SECRET || 'dev-secret-change-me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GH_CLIENT_ID = process.env.GH_CLIENT_ID || '';
const GH_CLIENT_SECRET = process.env.GH_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const GOOGLE_READY = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const GITHUB_OAUTH_READY = !!(GH_CLIENT_ID && GH_CLIENT_SECRET);
/* Google env न हो → demo login चालू, ताकि पूरा flow आज़माया जा सके */
const DEMO_AUTH = process.env.DEMO_AUTH === '1' || !GOOGLE_READY;

if (!process.env.SERVER_SECRET) {
  console.warn('⚠️  SERVER_SECRET env set नहीं है — production में ज़रूर दें');
}

/* ---------------- helpers ---------------- */
const b64u = b => Buffer.from(b).toString('base64url');

function signToken(payload, ttlSec = 600) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + ttlSec * 1000 }));
  const sig = crypto.createHmac('sha256', SECRET).update('ak.' + body).digest();
  return body + '.' + sig.toString('base64url');
}
function verifyToken(t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update('ak.' + body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!data.exp || data.exp < Date.now()) return null;
  return data;
}

/* AES-256-GCM vault — यूज़र के GitHub tokens कभी plaintext save न हो */
const VAULT_KEY = crypto.createHash('sha256').update('vault:' + SECRET).digest();
function vaultEnc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
function vaultDec(packed) {
  const [iv, tag, enc] = String(packed).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

function getUser(sub) { return users.find(u => u.sub === sub); }
function upsertUser(sub, patch) {
  let u = getUser(sub);
  if (!u) { u = { sub, createdAt: Date.now() }; users.push(u); }
  Object.assign(u, patch);
  saveUsers();
  return u;
}

/* ---------------- session ---------------- */
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function getSession(req) {
  const t = parseCookies(req)['ak_sess'];
  const d = verifyToken(t);
  return d && d.sub ? { sub: d.sub } : null;
}
function setSessionCookie(res, sub) {
  const t = signToken({ sub }, 30 * 24 * 3600);
  const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ak_sess=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ak_sess=; Path=/; HttpOnly; Max-Age=0');
}

function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); }
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ---------------- oauth exchanges ---------------- */
async function googleExchange(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: BASE_URL + '/auth/google/callback', grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();
  if (!j.id_token) throw new Error('google token fail');
  const v = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + j.id_token)).json();
  if (v.aud !== GOOGLE_CLIENT_ID) throw new Error('aud mismatch');
  return v; // { sub, email, name, picture }
}

async function githubExchange(code) {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code, client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET,
      redirect_uri: BASE_URL + '/auth/github/callback',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('github token fail: ' + (j.error || 'unknown'));
  return j.access_token;
}

/* ---------------- route handler ----------------
 * index.js इसे हर request पर सबसे पहले बुलाता है।
 * संभाल लिया तो true, वरना false।
 * opts.onGithubConnected(user) — repo provisioning के लिए hook।
 */
function handleAuth(req, res, u, opts = {}) {
  const p = u.pathname;

  if (p === '/auth/config') {
    return json(res, 200, { ok: true, google: GOOGLE_READY, github: GITHUB_OAUTH_READY, demoAuth: DEMO_AUTH }), true;
  }

  if (p === '/api/me') {
    const s = getSession(req);
    if (!s) return json(res, 200, { ok: false }), true;
    const usr = getUser(s.sub) || {};
    return json(res, 200, {
      ok: true,
      user: {
        name: usr.name || 'User', email: usr.email || '', avatar: usr.avatar || '',
        gh: usr.gh ? { login: usr.gh.login, avatar: usr.gh.avatar, repo: usr.gh.repo || null } : null,
      },
    }), true;
  }

  if (p === '/auth/logout') { clearSessionCookie(res); return redirect(res, '/'), true; }

  /* --- demo login (सिर्फ़ DEMO_AUTH में) --- */
  if (p === '/auth/demo' && DEMO_AUTH) {
    const sub = 'demo-' + crypto.randomBytes(4).toString('hex');
    upsertUser(sub, { name: 'Demo User', email: 'demo@appkaro.local', avatar: '' });
    setSessionCookie(res, sub);
    return redirect(res, '/?login=demo'), true;
  }

  /* --- Google OAuth --- */
  if (p === '/auth/google') {
    if (!GOOGLE_READY) return redirect(res, '/?login=unavailable'), true;
    const state = signToken({ n: crypto.randomBytes(8).toString('hex') });
    const q = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, redirect_uri: BASE_URL + '/auth/google/callback',
      response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
    });
    return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + q), true;
  }

  if (p === '/auth/google/callback') {
    (async () => {
      try {
        if (!verifyToken(u.searchParams.get('state'))) throw new Error('bad state');
        const v = await googleExchange(u.searchParams.get('code') || '');
        upsertUser(v.sub, { name: v.name, email: v.email, avatar: v.picture });
        setSessionCookie(res, v.sub);
        redirect(res, '/?login=ok');
      } catch (e) { redirect(res, '/?login=error&why=' + encodeURIComponent(e.message)); }
    })();
    return true;
  }

  /* --- GitHub connect (T1 optional) --- */
  if (p === '/auth/github') {
    const s = getSession(req);
    if (!s) return redirect(res, '/?login=needed'), true;
    if (!GITHUB_OAUTH_READY) return redirect(res, '/?gh=setup_needed'), true;
    const state = signToken({ sub: s.sub, n: crypto.randomBytes(8).toString('hex') });
    const q = new URLSearchParams({
      client_id: GH_CLIENT_ID, redirect_uri: BASE_URL + '/auth/github/callback',
      scope: 'workflow public_repo', state,
    });
    return redirect(res, 'https://github.com/login/oauth/authorize?' + q), true;
  }

  if (p === '/auth/github/callback') {
    (async () => {
      try {
        const st = verifyToken(u.searchParams.get('state'));
        if (!st || !st.sub) throw new Error('bad state');
        const token = await githubExchange(u.searchParams.get('code') || '');
        const me = await (await fetch('https://api.github.com/user', {
          headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'appkaro', Accept: 'application/vnd.github+json' },
        })).json();
        if (!me.login) throw new Error('github user नहीं मिला');
        const usr = upsertUser(st.sub, {
          gh: { login: me.login, avatar: me.avatar_url, tokenEnc: vaultEnc(token), connectedAt: Date.now(), repo: null },
        });
        if (opts.onGithubConnected) {
          /* repo auto-provision — background में, redirect रोकना नहीं */
          Promise.resolve()
            .then(() => opts.onGithubConnected(usr, token))
            .then(repo => { if (repo) upsertUser(st.sub, { gh: { ...getUser(st.sub).gh, repo } }); })
            .catch(() => {});
        }
        redirect(res, '/?gh=connected');
      } catch (e) { redirect(res, '/?gh=error&why=' + encodeURIComponent(e.message)); }
    })();
    return true;
  }

  if (p === '/auth/github/disconnect') {
    const s = getSession(req);
    if (s) { const usr = getUser(s.sub); if (usr && usr.gh) { delete usr.gh; saveUsers(); } }
    return redirect(res, '/?gh=disconnected'), true;
  }

  return false;
}

module.exports = {
  handleAuth, getSession, getUser, upsertUser, vaultDec,
  isDemoAuth: () => DEMO_AUTH,
  googleReady: () => GOOGLE_READY,
  githubOauthReady: () => GITHUB_OAUTH_READY,
};
