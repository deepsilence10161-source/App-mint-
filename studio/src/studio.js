/* ============================================================================
   App Mint Studio
   ---------------------------------------------------------------------------
   A phone-first visual editor for the Project Specification.

   The important architectural point: this file IMPORTS the same validator and
   permission engine that CI and the CLI use. It does not reimplement them. If
   it did, the Studio and the build would eventually disagree about what is
   valid, and the user would be told "looks fine" by one and "refused" by the
   other. One engine, three front ends (CLI, CI, Studio).

   No dependencies. No network except the GitHub API, and only when you press a
   button that says it will contact GitHub.
   ========================================================================= */

import {
  validateSpec, applyFixes, defaultSpec, CAPABILITIES, SPEC_VERSION, LAYERS,
} from '../../engine/spec/spec.mjs';
import { isAutoFixable } from '../../engine/spec/fix-policy.mjs';
import { permissionReport, derivePermissions } from '../../engine/capability/permissions.mjs';
import { viewRepairs, journalOf } from './repairs.js';
import { TOOLCHAIN_PROFILES } from '../../engine/spec/toolchain.mjs';

/* ── tiny DOM helpers ──────────────────────────────────────────────────── */
/**
 * Count something that may not be the shape it was assumed to be.
 * Returns null rather than undefined, so the interface can tell "none" apart
 * from "I could not work it out".
 */
function count(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Nothing in this interface may ever print the word "undefined", "NaN" or
 * "[object Object]". They are how a program tells the user it has lost track of
 * its own state, and they are always a bug rather than a value. When a number is
 * not known, say so in words instead; when it is known, agree with the noun.
 */
function say(n, noun) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return `— ${noun}s`;
  const v = Number(n);
  return `${v} ${noun}${v === 1 ? '' : 's'}`;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/* ── icons (inline SVG, so nothing loads from the network) ─────────────── */
const I = {
  layers: '<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/>',
  // section icons
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  palette: '<circle cx="13.5" cy="6.5" r="2"/><circle cx="17.5" cy="12.5" r="2"/><circle cx="8.5" cy="7.5" r="2"/><circle cx="6.5" cy="14" r="2"/><path d="M12 22a5 5 0 0 1 0-10h1.5a2.5 2.5 0 0 0 0-5H11"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>',
  download: '<path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"/>',
  code: '<path d="m9 8-5 4 5 4M15 8l5 4-5 4"/>',
  palette2: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9.5" cy="15" r="1.2"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  design: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
  caps: '<path d="M12 3l8 4v6c0 4-3.4 6.6-8 8-4.6-1.4-8-4-8-8V7z"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
  gauge: '<path d="M20 15a8 8 0 1 0-16 0"/><path d="m12 15 3.5-4.5"/><circle cx="12" cy="15" r="1.4"/>',
  build: '<path d="M12 3v11"/><path d="M7.5 9.5L12 14l4.5-4.5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l4.5-4.5L13 17"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M3 4h2l2.2 10.2A2 2 0 009.2 16h8.4a2 2 0 002-1.6L21 8H6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/>',
  rss: '<path d="M5 19h.01"/><path d="M5 12a7 7 0 017 7"/><path d="M5 5a14 14 0 0114 14"/>',
  trophy: '<path d="M8 4h8v6a4 4 0 01-8 0z"/><path d="M8 6H5.5A2.5 2.5 0 008 10.5"/><path d="M16 6h2.5A2.5 2.5 0 0116 10.5"/><path d="M12 14v3"/><path d="M9 20h6l-.6-3H9.6z"/>',
  wrench: '<path d="M15.5 3.5a5 5 0 00-6 6.6L4 15.6 8.4 20l5.5-5.5a5 5 0 006.6-6z"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="14" width="3" height="3"/>',
};
const svg = (d, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/* ── storage ───────────────────────────────────────────────────────────── */
const LS_PROJECTS = 'appmint.projects.v1';
const LS_ACTIVE = 'appmint.active.v1';
const LS_TOKEN = 'appmint.token.v1';       // lives only in this browser
const LS_REPO = 'appmint.repo.v1';
const LS_THEME = 'appmint.theme.v1';      // 'auto' | 'dark' | 'light'

const store = {
  load() {
    try { return JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]'); } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(LS_PROJECTS, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  },
  token() { try { return localStorage.getItem(LS_TOKEN) || ''; } catch { return ''; } },
  setToken(t) { try { t ? localStorage.setItem(LS_TOKEN, t) : localStorage.removeItem(LS_TOKEN); } catch { /* ignore */ } },
  repo() { try { return localStorage.getItem(LS_REPO) || ''; } catch { return ''; } },
  setRepo(r) { try { localStorage.setItem(LS_REPO, r); } catch { /* ignore */ } },
  theme() { try { return localStorage.getItem(LS_THEME) || 'auto'; } catch { return 'auto'; } },
  setTheme(t) { try { localStorage.setItem(LS_THEME, t); } catch { /* ignore */ } },
};

/* ── theme ───────────────────────────────────────────────────────────────
   The whole palette is a set of tokens, so switching theme is one attribute on
   the root element and nothing else — no second stylesheet, no redraw, no
   component that has to be told.

   The default is the system setting rather than a house preference: someone who
   has their phone in light mode should not have to find a toggle to stop this
   tool glaring at them, and someone in dark mode should not get a white screen
   at night. The override exists because a preference is not a prediction. */
const systemTheme = () => (
  window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
);

function applyTheme(choice) {
  const resolved = choice === 'auto' ? systemTheme() : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
  const btn = document.getElementById('themebtn');
  if (btn) {
    const next = resolved === 'light' ? 'dark' : 'light';
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.textContent = next === 'light' ? 'Light mode' : 'Dark mode';
  }
  return resolved;
}

function cycleTheme() {
  const now = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  store.setTheme(now);
  applyTheme(now);
  toast(now === 'light' ? 'Light mode' : 'Dark mode');
}

/* ── application state ─────────────────────────────────────────────────── */
const S = {
  templates: { templates: [] },
  projects: [],
  active: null,        // { id, name, spec, updatedAt }
  tab: 'design',
  preview: { orientation: 'portrait', theme: 'auto' },
  lastRun: null,
  dirty: false,
};

/* ── project helpers ───────────────────────────────────────────────────── */
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Deep merge a template's partial spec over the defaults. */
function mergeSpec(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object') {
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const [k, v] of Object.entries(over)) {
      out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? mergeSpec(out[k], v) : (Array.isArray(v) ? v.slice() : v);
    }
    return out;
  }
  return over === undefined ? base : over;
}

function specFromTemplate(tpl, name) {
  const spec = mergeSpec(defaultSpec(), tpl.spec || {});
  spec.specVersion = SPEC_VERSION;
  const slug = (name || tpl.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  spec.identity.appName = name || tpl.name;
  spec.identity.packageName = 'com.example.' + (slug.slice(0, 20) || 'myapp');
  return spec;
}

function persist() {
  const idx = S.projects.findIndex((p) => p.id === S.active.id);
  if (idx >= 0) S.projects[idx] = S.active; else S.projects.push(S.active);
  const ok = store.save(S.projects);
  try { localStorage.setItem(LS_ACTIVE, S.active.id); } catch { /* ignore */ }
  return ok;
}

function touch() {
  S.active.updatedAt = new Date().toISOString();
  if (!persist()) toast('Warning: could not save to this browser\'s storage.');
}

/* ── validation ────────────────────────────────────────────────────────── */
function check() {
  return validateSpec(S.active ? S.active.spec : {});
}

/* ── toast ─────────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ── views ─────────────────────────────────────────────────────────────── */

function viewDesign() {
  const spec = S.active.spec;
  const id = spec.identity;
  const th = spec.theme;
  const a = spec.android;
  const wv = spec.app.webview || (spec.app.webview = {});

  const mode = spec.app.mode || 'webview';

  return [
    // First, because "where does this app come from" is the first question, and
    // because a website can answer most of the rest of this screen.
    websiteSection(),
    section('How this app is built', {
      icon: I.spark,
      id: 'arch',
      open: true,
      summary: () => (spec.app.mode === 'native-screens' ? 'Screens you design — no website' : 'A website shown in the app'),
      children: [
      fieldBox('Architecture', kvSelect(
        mode,
        [
          ['native-screens', 'Screens I design here — no website needed'],
          ['webview', 'A website shown inside the app'],
          ['pwa', 'A website that also works offline'],
          ['hybrid', 'A website plus some native features'],
        ],
        (v) => {
          spec.app.mode = v;
          // A designed app needs screens; a website app needs an address. Rather
          // than refusing the build later, put the right fields in front of the
          // person now.
          // Screens with no navigation are unreachable, so the navigation is
          // set at the same time rather than left for the user to discover from
          // a warning. One screen gets a back stack; more get tabs.
          const nav = spec.navigation || (spec.navigation = {});
          if (v === 'native-screens' && (!nav.type || nav.type === 'none')) {
            nav.type = (spec.screens || []).length > 1 ? 'bottom-tabs' : 'stack';
          }
          if (v === 'native-screens' && !(spec.screens || []).length) {
            spec.screens = [{
              id: 'home', name: 'Home', title: spec.identity.appName || 'Home', showInTabs: true,
              components: [
                { id: 'heading', type: 'Heading', props: { text: spec.identity.appName || 'Home' } },
                { id: 'intro', type: 'Text', props: { text: 'This screen is drawn by the app itself. Add to it in the Screens section.' } },
              ],
            }];
            toast('A first screen was created in the Screens section.');
          }
          touch();
          hardUpdate();
        },
        'Architecture',
      ), mode === 'native-screens'
        ? 'The app draws its own screens. Nothing is downloaded, so it opens instantly and works with no internet at all. Build the screens in the Screens section.'
        : 'The app shows a web page. Its screens come from the address below.'),
      ],
    }),

    section('Application', {
      icon: I.tag,
      id: 'app',
      open: true,
      summary: () => id.appName ? `${id.appName} · ${id.packageName}` : 'Not named yet',
      children: [
      field('Application name', el('input', {
        type: 'text', value: id.appName, maxlength: 60, 'aria-label': 'Application name',
        oninput: (e) => { id.appName = e.target.value; touch(); softUpdate(); },
      }), 'Shown under the launcher icon. It can be changed at any time.'),

      field('Package name', el('input', {
        type: 'text', value: id.packageName, spellcheck: 'false', autocapitalize: 'off',
        'aria-label': 'Package name',
        oninput: (e) => { id.packageName = e.target.value.trim(); touch(); softUpdate(); },
      }), 'Permanent once published. Google Play rejects names starting with com.example.'),
      ],
    }),

    section('Appearance', {
      icon: I.palette,
      id: 'look',
      summary: () => `${th.primary} · ${th.background}`,
      children: [
        colourField('Primary', 'primary', th),
        colourField('Accent', 'accent', th),
        colourField('Background', 'background', th),
        colourField('Surface', 'surface', th),
        colourField('Text on surface', 'onSurface', th),
      ],
    }),

    mode === 'native-screens' ? el('p', { class: 'hint' },
      'This app draws its own screens, so there is no web page to configure. Build them in the Screens section.') : null,

    mode === 'native-screens' ? null : section('Web content', {
      icon: I.code,
      id: 'web',
      summary: () => (wv.localAsset || wv.startUrl || 'No address set'),
      children: [
      field('Content source', el('div', { class: 'selectwrap' }, el('select', {
        'aria-label': 'Content source',
        onchange: (e) => {
          if (e.target.value === 'bundled') { if (!wv.localAsset) wv.localAsset = 'index.html'; }
          else { wv.localAsset = undefined; }
          touch(); hardUpdate();
        },
      },
        el('option', { value: 'url', selected: !wv.localAsset }, 'A website address'),
        el('option', { value: 'bundled', selected: !!wv.localAsset }, 'A page bundled inside the app'),
      )), 'A bundled page works with no internet at all and cannot be changed by a third party.'),

      wv.localAsset
        ? field('Bundled page file', el('input', {
            type: 'text', value: wv.localAsset, spellcheck: 'false',
            'aria-label': 'Bundled page file',
            oninput: (e) => { wv.localAsset = e.target.value.trim(); touch(); softUpdate(); },
          }), 'Put your files in a folder called web next to the specification file.')
        : field('Website address', el('input', {
            type: 'url', value: wv.startUrl || '', inputmode: 'url', spellcheck: 'false',
            autocapitalize: 'off', 'aria-label': 'Website address',
            oninput: (e) => { wv.startUrl = e.target.value.trim(); touch(); softUpdate(); },
          }), 'Must start with https://'),

      field('Links that leave the app', el('div', { class: 'selectwrap' }, el('select', {
        'aria-label': 'External link handling',
        onchange: (e) => { wv.externalLinks = e.target.value; touch(); softUpdate(); },
      },
        el('option', { value: 'custom-tab', selected: wv.externalLinks === 'custom-tab' }, 'Keep it in the app (recommended)'),
        el('option', { value: 'external-browser', selected: wv.externalLinks === 'external-browser' }, 'Open the browser'),
        el('option', { value: 'in-app', selected: wv.externalLinks === 'in-app' }, 'Always inside the app'),
      )), 'Payment and login pages usually need to hand off to another app.'),
      ],
    }),

    section('Advanced appearance', {
      icon: I.sliders,
      id: 'adv',
      summary: () => `Android ${a.minSdk}+ · ${a.orientation}`,
      children: [
      field('Minimum Android version', kvSelect(
        a.minSdk,
        [[24, 'Android 7.0 — widest reach'], [26, 'Android 8.0'], [28, 'Android 9'], [29, 'Android 10'], [31, 'Android 12'], [33, 'Android 13']],
        (v) => { a.minSdk = v; touch(); hardUpdate(); },
        'Minimum Android version',
      ), 'Devices older than this cannot install the app.'),
      field('Screen orientation', kvSelect(
        a.orientation, [['portrait', 'Portrait'], ['landscape', 'Landscape'], ['sensor', 'Follow the device']],
        (v) => { a.orientation = v; touch(); softUpdate(); }, 'Screen orientation',
      )),
      field('Force dark on web content', el('div', { class: 'sw' }, [
        el('input', {
          type: 'checkbox', checked: wv.forceDark === true, role: 'switch',
          'aria-label': 'Force dark on web content',
          onchange: (e) => { wv.forceDark = e.target.checked; touch(); hardUpdate(); },
        }),
        el('span', { class: 'track' }), el('span', { class: 'knob' }),
      ]), 'Off is safer. Turning it on can make a page unreadable if the page was not built for dark mode.'),
      ],
    }),
  ];
}

function viewCaps() {
  const spec = S.active.spec;
  const on = new Set(spec.capabilities || []);
  const rep = permissionReport(spec);
  const derived = derivePermissions(spec);

  const toggles = Object.entries(CAPABILITIES)
    .filter(([, c]) => !c.implicit)
    .map(([key, cap]) => el('label', { class: 'opt' }, [
      el('div', { class: 'txt' }, [
        el('div', { class: 'name' }, cap.label),
        el('div', { class: 'why' }, cap.reason),
        cap.disclosure ? el('span', { class: 'cost' }, cap.disclosure) : null,
        cap.requiresSetup ? el('span', { class: 'cost' }, 'Needs setup: ' + cap.requiresSetup) : null,
        cap.highRisk ? el('span', { class: 'cost' }, 'High risk: Google Play requires a written justification.') : null,
      ]),
      el('div', { class: 'sw' }, [
        el('input', {
          type: 'checkbox', checked: on.has(key), role: 'switch',
          'aria-label': cap.label,
          onchange: (e) => {
            const s = new Set(spec.capabilities || []);
            e.target.checked ? s.add(key) : s.delete(key);
            spec.capabilities = [...s];
            touch(); hardUpdate();
          },
        }),
        el('span', { class: 'track' }), el('span', { class: 'knob' }),
      ]),
    ]));

  const permRows = rep.rows.length
    ? rep.rows.map((r) => el('div', { class: 'perm' }, [
        el('div', { class: 'top' }, [
          el('span', { class: 'pname' }, r.permission),
          el('span', { class: 'chip' }, r.scope),
          r.prompt === 'Yes' ? el('span', { class: 'chip warn' }, 'asks the user') : null,
        ]),
        el('div', { class: 'why' }, r.why),
        el('div', { class: 'feat' }, 'needed by: ' + r.feature),
      ]))
    : [el('p', { class: 'hint' }, 'No permissions are required by this configuration.')];

  return [
    card('What this app can do', toggles,
      'Turn a feature on and its Android permission appears automatically. Turn it off and the permission is removed from the app.'),

    card('Permissions this app will request', [
      el('p', { class: 'hint' },
        `${rep.total} permission${rep.total === 1 ? '' : 's'}, of which ${rep.prompts} will ask the user directly. Everything below is derived from the capabilities above.`),
      ...permRows,
    ]),

    // Kept in its own card on purpose: mixing "what it asks for" with "what it
    // refuses to ask for" makes the permission table unreadable, and the
    // refusal list is the actual evidence that minimisation is working.
    derived.dropped.length
      ? card('Deliberately not requested', [
          el('p', { class: 'hint' },
            'Every one of these is something this app could have asked for and does not. Fewer permissions means a smaller app, fewer Play Store questions and less to explain to your users.'),
          ...derived.dropped.map((d) => el('div', { class: 'dropped' }, [
            el('code', {}, d.name), ' — ' + d.reason,
          ])),
        ])
      : null,
  ].filter(Boolean);
}

function viewPreview() {
  const spec = S.active.spec;
  const th = spec.theme;
  const isDark = S.preview.theme === 'dark'
    || (S.preview.theme === 'auto' && relLuminance(th.background) < 0.5);
  const bg = isDark ? th.background : lighten(th.background);
  const fg = isDark ? th.onSurface : darken(th.onSurface);

  /* `app-screen` is what separates this frame — which is standing in for YOUR
     app and must wear its colours — from `.screen` elsewhere in the Studio,
     which is a panel of the tool itself and must not. */
  const screen = el('div', { class: 'screen app-screen' }, [
    el('div', { class: 'sbar' },
      el('span', {}, '9:41'),
      el('span', { class: 'icons' }, [
        el('i', { class: 'sig' }), el('i', { class: 'batt' }),
      ])),
    el('div', { class: 'pv-body' }, [
      el('div', { class: 'pv-h1' }, spec.identity.appName),
      el('p', { class: 'pv-p' }, spec.app.webview?.localAsset
        ? 'A page bundled inside the app. No internet needed.'
        : (spec.app.webview?.startUrl || 'Set a website address to see it here.')),
      el('div', { class: 'pv-card' }, [
        el('p', { class: 't' }, 'Your content appears here'),
        el('p', { class: 'd' }, 'This frame shows the app shell around your page: the theme colours, the status bar and the navigation you chose.'),
      ]),
      el('button', { class: 'pv-btn' }, 'Primary action'),
      el('div', { class: 'pv-card' }, [
        el('div', { class: 'skel', style: 'height:11px;width:72%' }),
        el('div', { class: 'skel', style: 'height:9px;width:94%' }),
        el('div', { class: 'skel', style: 'height:9px;width:83%;margin-bottom:0' }),
      ]),
      el('button', { class: 'pv-btn ghost' }, 'Secondary action'),
      el('div', { class: 'skel', style: 'height:42px' }),
    ]),
    spec.navigation?.type === 'bottom-tabs'
      ? el('div', { class: 'pv-tabs' }, [
          el('div', { class: 'on' }, 'Home'), el('div', {}, 'Search'), el('div', {}, 'You'),
        ])
      : el('div', { class: 'pv-nav' }),
  ]);

  screen.style.setProperty('--pv-bg', bg);
  screen.style.setProperty('--pv-fg', fg);
  screen.style.setProperty('--pv-primary', th.primary);
  screen.style.setProperty('--pv-onprimary', th.onPrimary || '#fff');
  screen.style.setProperty('--pv-sb', isDark ? bg : '#111');
  /* The frame has to be dressed in the APP's palette, not this tool's. These
     were already being set, but no rule read them, so the preview drew the
     tool's grey surfaces inside a frame that was supposed to be showing your
     app — the one screen where that mistake is most expensive, because the
     whole point of it is to show what you chose. */
  screen.style.setProperty('--pv-surface', th.surface || '#F9FAFB');
  screen.style.setProperty('--pv-line', withAlpha(fg, 0.14));
  screen.style.setProperty('--pv-muted', withAlpha(fg, 0.62));
  screen.style.setProperty('--pv-wash', withAlpha(fg, 0.08));

  const device = el('div', {
    class: 'device' + (S.preview.orientation === 'landscape' ? ' landscape' : ''),
    role: 'img',
    'aria-label': `Preview of ${spec.identity.appName}`,
  }, el('div', { class: 'notch' }), screen);

  return [
    card('Preview', [
      el('div', { class: 'chips', style: 'margin-bottom:var(--s4)' }, [
        chipBtn('Portrait', S.preview.orientation === 'portrait', () => { S.preview.orientation = 'portrait'; hardUpdate(); }),
        chipBtn('Landscape', S.preview.orientation === 'landscape', () => { S.preview.orientation = 'landscape'; hardUpdate(); }),
        el('span', { style: 'flex:1' }),
        chipBtn('Light', S.preview.theme === 'light', () => { S.preview.theme = 'light'; hardUpdate(); }),
        chipBtn('Dark', S.preview.theme === 'dark', () => { S.preview.theme = 'dark'; hardUpdate(); }),
        chipBtn('Auto', S.preview.theme === 'auto', () => { S.preview.theme = 'auto'; hardUpdate(); }),
      ]),
      el('div', { class: 'stage' }, device),
      el('p', { class: 'pv-note' },
        'This shows the app shell around your content — the real thing drawn by Android. '
        + 'It is not a running app: scrolling, gestures, downloads and how a specific website behaves '
        + 'can only be seen by building it and running it on a device.'),
    ]),
  ];
}

function viewBuild() {
  const spec = S.active.spec;
  const r = check();
  const repo = store.repo();
  const token = store.token();

  const layers = LAYERS.map((L) => {
    const found = r.byLayer[L.n]?.issues || [];
    const bad = found.filter((i) => i.severity === 'critical' || i.severity === 'error').length;
    return el('div', { class: 'layerline' }, [
      el('span', { class: bad ? 'chip fail' : (found.length ? 'chip warn' : 'chip pass') }, bad ? 'FAIL' : (found.length ? 'WARN' : 'PASS')),
      el('span', { class: 'nm' }, `Layer ${L.n} — ${L.name}`),
      // The count sits at the far end of the row, where a stray gap between the
      // layer name and the number cannot read as part of the name itself
      // ("Layer 2 — Semantic1 finding" was exactly that).
      el('span', { class: 'n' }, found.length ? say(found.length, 'finding') : ''),
    ]);
  });

  const findings = r.issues.map((i) => el('div', { class: 'finding' }, [
    el('span', { class: 'dot ' + i.severity }),
    el('div', {}, [
      el('div', { class: 'msg' }, i.message),
      el('div', { class: 'meta' }, `${i.code} · ${i.path || '(root)'}`),
      // Where the repair happens is stated here and performed in the repair
      // card above, so there is exactly one place in the app that changes a
      // specification on your behalf.
      i.fix ? el('span', {
        class: 'chip ' + (isAutoFixable(i.code) ? 'pass' : 'warn'),
      }, isAutoFixable(i.code) ? 'ready to repair' : 'your call') : null,
    ]),
  ]));

  const statusBanner = r.blocked
    ? el('div', { class: 'banner fail' }, el('div', {}, [
        el('strong', {}, 'Build blocked. '),
        `${r.blocking.length} problem${r.blocking.length === 1 ? '' : 's'} must be fixed first. A build is never started on a configuration that cannot work.`,
      ]))
    : (r.counts.warning
        ? el('div', { class: 'banner warn' }, el('div', {}, [
            el('strong', {}, r.counts.warning === 1 ? 'Ready to build, with 1 warning.' : `Ready to build, with ${r.counts.warning} warnings.`),
            ' Nothing here stops the build, but each one is worth a look before you release.'
          ]))
        : el('div', { class: 'banner pass' }, el('div', {}, [
            el('strong', {}, 'Specification is valid. '), 'All five validation layers passed.',
          ])));

  const buildBtn = el('button', {
    class: 'btn primary', disabled: r.blocked,
    onclick: () => startBuild(),
  }, svg(I.build) + ' Start build');

  // The repair screen sits directly under the verdict, because "fix it" is the
  // question that follows "is it broken" — and it is built from the same
  // validation result shown below it, not from a second opinion.
  const repairs = viewRepairs({
    project: S.active,
    spec,
    result: r,
    recheck: (s) => validateSpec(s),
    onSpecChange: (next) => { S.active.spec = next; touch(); },
    onSay: (msg) => { toast(msg, 4200); hardUpdate(); },
  });

  return [
    card('Validation layers', [statusBanner, ...layers], null),

    ...repairs,

    r.issues.length
      ? card('What needs attention', findings, 'Every finding names the exact field, so nothing is vague.')
      : card('What needs attention', el('p', { class: 'hint' }, 'Nothing to report.'), null),

    card('Build', [
      el('p', { class: 'hint' },
        'A build runs on GitHub Actions: it compiles the app, checks the finished file, then installs it on a real Android emulator and takes screenshots.'),
      field('Repository', el('input', {
        type: 'text', value: repo || 'deepsilence10161-source/App-mint-',
        spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Repository',
        oninput: (e) => { store.setRepo(e.target.value.trim()); },
      })),
      token
        ? buildBtn
        : el('div', {}, [
            el('p', { class: 'hint' }, 'Connect GitHub to start builds from here.'),
            el('button', { class: 'btn ghost', onclick: () => openTokenSheet() }, 'Connect GitHub'),
          ]),
      el('div', { class: 'row', style: 'margin-top:var(--s3)' }, [
        el('button', { class: 'btn ghost', onclick: () => downloadSpec() }, 'Save spec file'),
        el('button', { class: 'btn ghost', onclick: () => copySpec() }, 'Copy as text'),
      ]),
      S.lastRun ? el('div', { style: 'margin-top:var(--s4)' },
        el('h2', {}, 'Last build'),
        el('div', { class: 'runrow' }, [
          el('span', { class: 'rname' }, 'Run #' + S.lastRun.run_number),
          el('span', { class: 'rstate ' + (S.lastRun.conclusion || S.lastRun.status) }, (S.lastRun.conclusion || S.lastRun.status || '').toUpperCase()),
        ]),
        el('a', { class: 'btn ghost', href: S.lastRun.html_url, target: '_blank', rel: 'noopener', style: 'margin-top:var(--s2)' }, 'Open build results'),
      ) : null,
    ]),

    detailsAdvanced('Advanced', [
      field('Android Gradle Plugin', el('input', {
        type: 'text', value: spec.build.toolchain?.agp || TOOLCHAIN_PROFILES.modern.agp, spellcheck: 'false',
        oninput: (e) => { spec.build.toolchain = { ...(spec.build.toolchain || {}), agp: e.target.value.trim() }; touch(); },
      }), 'Must match Gradle. See the profiles below.'),
      el('div', { class: 'chips', style: 'margin-bottom:var(--s4)' },
        Object.entries(TOOLCHAIN_PROFILES).map(([k, p]) => el('span', { class: 'chip' },
          `${k}: AGP ${p.agp} / Gradle ${p.gradle} / SDK ≤ ${p.maxCompileSdk}`))),
      field('Signing', el('div', { class: 'selectwrap' }, el('select', {
        onchange: (e) => { spec.signing = { ...(spec.signing || {}), mode: e.target.value }; touch(); hardUpdate(); },
      },
        el('option', { value: 'debug', selected: spec.signing?.mode === 'debug' }, 'Debug only (test on your phone)'),
        el('option', { value: 'secret-store', selected: spec.signing?.mode === 'secret-store' }, 'Release key from GitHub secrets'),
      )), 'Release signing needs a keystore stored as a repository secret. It never goes in the code.'),
      el('button', { class: 'btn ghost', onclick: () => { openTokenSheet(); } }, 'Manage GitHub connection'),
      el('button', { class: 'btn danger', style: 'margin-top:var(--s2)', onclick: () => { store.setToken(''); toast('GitHub connection removed.'); hardUpdate(); } }, 'Disconnect GitHub'),
    ]),
  ];
}

/* ── view helpers ──────────────────────────────────────────────────────── */

/**
 * A plain card: a heading and its contents, always visible.
 * Kept for the sections where nothing is gained by folding them away.
 */
function card(title, kids, hint) {
  return el('section', { class: 'card' }, [
    title ? el('h2', {}, title) : null,
    hint ? el('p', { class: 'hint' }, hint) : null,
    ...(Array.isArray(kids) ? kids : [kids]).filter(Boolean),
  ]);
}

/* Which sections a person has opened. Kept for the life of the page rather than
   saved, so reopening the Studio always starts from the same tidy state. */
const OPEN = new Set();

/**
 * A section that folds away, showing its current value when closed.
 *
 * This is the shape most of the interface uses, and the reason is comfort on a
 * phone: a settings page that opens everything at once is a long scroll, and
 * whatever you came for is always below the fold. Closed, this shows what is
 * inside ("Application · Phone Test App"), so most of the time the answer is
 * readable without opening anything.
 *
 * The contents stay in the document while closed — hidden, not removed — so
 * searching the page and the automated tests both still see them.
 */
function section(name, { icon, summary, open = false, id, children } = {}) {
  const key = id || name;
  const isOpen = open || OPEN.has(key);
  const body = el('div', { class: 'sec-body' }, ...(children || []).filter(Boolean));
  const sub = el('span', { class: 'sec-sub' }, typeof summary === 'function' ? summary() : (summary || ''));

  const head = el('button', {
    class: 'sec-head',
    type: 'button',
    'aria-expanded': isOpen ? 'true' : 'false',
    onclick: () => {
      const nowOpen = !sec.dataset.open || sec.dataset.open === '0';
      sec.dataset.open = nowOpen ? '1' : '0';
      head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      if (nowOpen) OPEN.add(key); else OPEN.delete(key);
    },
  }, [
    el('span', { class: 'sec-ico', html: svg(icon || I.sliders) }),
    el('span', { class: 'sec-text' }, [
      el('span', { class: 'sec-name' }, name),
      sub,
    ]),
    el('span', { class: 'chev', html: svg('<path d="m6 9 6 6 6-6"/>') }),
  ]);

  const sec = el('section', { class: 'sec', id: `sec-${key}`, 'data-open': isOpen ? '1' : '0' }, [head, body]);
  // Keep the summary function on the element so a later edit can refresh it.
  sec.__summary = typeof summary === 'function' ? summary : () => (summary || '');
  return sec;
}

/**
 * One labelled control.
 *
 * The label is wrapped around the control rather than given a `for`, so
 * tapping the words focuses the field even when the control is a group of
 * things rather than a single input.
 */
function field(label, control, sub) {
  return el('label', { class: 'field' }, [
    el('span', {}, label),
    control,
    sub ? el('span', { class: 'sub' }, sub) : null,
  ].filter(Boolean));
}

/** The same, but for a control that must not be a nested label target. */
function fieldBox(label, control, sub) {
  return el('div', { class: 'field' }, [
    el('label', {}, label),
    control,
    sub ? el('span', { class: 'sub' }, sub) : null,
  ].filter(Boolean));
}

function colourField(label, key, theme) {
  const val = theme[key] || '#000000';
  const picker = el('input', {
    type: 'color', value: /^#[0-9a-f]{6}$/i.test(val) ? val : '#000000',
    'aria-label': label,
    oninput: (e) => { theme[key] = e.target.value.toUpperCase(); text.value = theme[key]; touch(); softUpdate(); },
  });
  const text = el('input', {
    type: 'text', value: val, spellcheck: 'false', maxlength: 9,
    'aria-label': label + ' value',
    oninput: (e) => {
      const v = e.target.value.trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) { theme[key] = v.toUpperCase(); picker.value = v.length === 7 ? v : picker.value; touch(); softUpdate(); }
    },
  });
  return field(label, el('div', { class: 'swatch' }, [picker, text]));
}

/**
 * A dropdown for a fixed set of choices, used all over the Studio.
 *
 * A browser only ever carries strings out of a <select>, so the value is looked
 * back up in the list it came from and returned as it was written. The earlier
 * version ran every value through Number(), which turned "portrait" into NaN:
 * choosing a screen orientation silently wrote NaN into the specification and
 * the app became "Blocked" for no reason the user could see.
 */
function kvSelect(current, pairs, onchange, ariaLabel) {
  const sel = el('select', {
    'aria-label': ariaLabel,
    onchange: (e) => {
      const i = pairs.findIndex(([v]) => String(v) === e.target.value);
      onchange(i >= 0 ? pairs[i][0] : e.target.value);
    },
  }, pairs.map(([v, l]) => el('option', { value: String(v), selected: String(current) === String(v) }, l)));
  return el('div', { class: 'selectwrap' }, sel);
}

function chipBtn(label, on, onclick) {
  const b = el('button', { class: 'chip' + (on ? ' pass' : ''), style: 'cursor:pointer;min-height:34px', onclick }, label);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  return b;
}

function detailsAdvanced(summary, kids) {
  return el('details', { class: 'adv' }, el('summary', {}, summary), ...kids);
}

function relLuminance(hex) {
  const c = String(hex || '#ffffff').replace('#', '');
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return 1;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const lighten = (hex) => {
  const c = String(hex).replace('#', ''); const n = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16);
  const f = (v) => Math.round(v + (255 - v) * 0.92).toString(16).padStart(2, '0');
  return Number.isFinite(n) ? `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}` : '#ffffff';
};
const darken = (hex) => {
  const c = String(hex).replace('#', ''); const n = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16);
  const f = (v) => Math.round(v * 0.18).toString(16).padStart(2, '0');
  return Number.isFinite(n) ? `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}` : '#111111';
};

/* ── rendering ─────────────────────────────────────────────────────────── */
/* The section list, declared once. The command palette offers "go to" for
   every entry, and it used to carry its own copy of these ids — in which
   Features was written as 'features' rather than the real 'caps', so running
   that command set a tab that does not exist and the Studio quietly fell back
   to the Design section. A command that says "Go to Features" and shows you
   Design is worse than no command at all. */
const TAB_DEFS = [
  ['design', 'Design', I.design, 'identity, colours, architecture, content source'],
  ['screens', 'Screens', I.layers, 'screen designer, components, layout'],
  ['caps', 'Features', I.caps, 'capabilities and the permissions they need'],
  ['preview', 'Preview', I.eye, 'the app drawn in your theme'],
  ['health', 'Health', I.gauge, 'score rings, and the checks behind each one'],
  ['build', 'Build', I.build, 'validation findings, repairs, start a build'],
];

function renderTabs() {
  const defs = TAB_DEFS;
  const inner = $('.tabbar .inner');
  inner.replaceChildren(...defs.map(([id, label, icon]) =>
    el('button', {
      class: 'tab', role: 'tab', 'aria-selected': S.tab === id ? 'true' : 'false',
      onclick: () => { S.tab = id; hardUpdate(); },
    }, el('span', { html: svg(icon) }), el('span', {}, label))));
}

function renderHealth() {
  const r = check();
  const node = $('#health');
  const total = r.counts.critical + r.counts.error + r.counts.warning;
  const caps = (S.active.spec.capabilities || []).length;

  // The verdict is the first thing on the page, because the only question that
  // really matters is "will this build?" — and if it will not, how many things
  // are in the way.
  const verdict = r.blocked
    ? `Blocked · ${r.counts.critical + r.counts.error} to fix`
    : (total ? `Ready · ${total} warning${total === 1 ? '' : 's'}` : 'Ready to build');

  // The permission count is the number people care about most, because it is the
  // one Google Play shows to everyone who installs the app.
  //
  // derivePermissions returns { permissions, dropped, unknownCapabilities }, not
  // an array. Reading .length off it gave undefined, and the strip cheerfully
  // printed "undefined permissions" — so this reads the field, and everything
  // below goes through the same helper that refuses to print nothing.
  const perms = count(derivePermissions(S.active.spec).permissions);
  const right = `${say(perms, 'permission')} · ${say(caps, 'feature')}`;

  node.replaceChildren(
    el('span', { class: 'pill ' + (r.blocked ? 'fail' : (total ? 'warn' : 'pass')) }, verdict),
    el('span', { class: 'spacer' }),
    el('span', { class: 'val' }, right),
  );
}

/** The one-line description of the project under its name. */
function projectMeta(spec) {
  const mode = (spec.app || {}).mode || 'webview';
  const bits = [];
  if (mode === 'native-screens') {
    const n = (spec.screens || []).length;
    bits.push(n ? `${n} screen${n === 1 ? '' : 's'}` : 'no screens yet');
  } else {
    bits.push((spec.app?.webview?.localAsset || spec.app?.webview?.startUrl || 'no address').replace(/^https?:\/\//, '').slice(0, 34));
  }
  bits.push(spec.android.theme === 'dark' ? 'dark' : 'light');
  return bits.join(' · ');
}

function renderActive() {
  $('#projname').textContent = S.active.spec.identity.appName || 'Untitled';
  $('#projmeta').textContent = projectMeta(S.active.spec);
  const pages = { design: viewDesign, screens: viewScreens, caps: viewCaps, preview: viewPreview, health: viewHealth, build: viewBuild };
  const page = pages[S.tab] || viewDesign;
  main.replaceChildren(el('div', { class: 'tabpage on' }, ...page().filter(Boolean)));
  renderTabs();
  renderHealth();
}

/** Light refresh for typing: a full redraw would steal focus mid-keystroke. */
function softUpdate() {
  renderHealth();
  // The title bar shows the app name and its one-line description, so both have
  // to follow what is being typed. Previously the name was written once and then
  // kept showing whatever the project was called when it was created.
  const t = $('#projname');
  const m = $('#projmeta');
  if (!S.active) return;
  if (t) t.textContent = S.active.spec.identity.appName || 'Untitled';
  if (m) m.textContent = projectMeta(S.active.spec);
  // and any section that shows a summary of the thing being typed
  refreshSectionSummaries();
}

/**
 * Sections show their current value while closed, so a change made inside one
 * has to be reflected on its closed header. Without this the summary keeps
 * describing what the value used to be, which is worse than showing nothing.
 */
function refreshSectionSummaries() {
  for (const sec of $$('.sec')) {
    const fn = sec.__summary;
    if (!fn) continue;
    const sub = sec.querySelector('.sec-sub');
    if (sub) sub.textContent = fn();
  }
}
/** Full redraw. */
function hardUpdate() { renderActive(); }

// Created as a real <main> element. An earlier version built a <div> here, which
// silently stopped every `main { ... }` rule from applying — including the
// clearance that keeps content out from under the fixed bottom navigation.
const main = el('main');

/* ── project picker ────────────────────────────────────────────────────── */
function renderPicker() {
  $('#projname').textContent = 'New project';
  const tpls = S.templates.templates || [];
  main.replaceChildren(
    el('div', { class: 'tabpage on' }, [
      card('Start a project', [
        el('p', { class: 'hint' }, 'Pick a starting point. Every template is an ordinary specification you can change completely.'),
        ...tpls.map((t) => el('button', {
          class: 'tpl', onclick: () => createProject(t),
        }, [
          el('span', { class: 'tmark', html: svg(I[t.mark] || I.square) }),
          el('span', { style: 'flex:1;min-width:0' }, [
            el('div', { class: 'tname' }, t.name),
            el('div', { class: 'ttag' }, t.tagline),
          ]),
        ])),
      ]),
      S.projects.length ? card('Your projects', S.projects.map((p) => el('button', {
        class: 'tpl', onclick: () => { S.active = p; touch(); renderActive(); },
      }, [
        el('span', { class: 'tmark', html: svg(I.square) }),
        el('span', { style: 'flex:1;min-width:0' }, [
          el('div', { class: 'tname' }, p.spec.identity.appName),
          el('div', { class: 'ttag' }, p.spec.identity.packageName),
        ]),
      ]))) : null,
    ].filter(Boolean)));

  // tabs are meaningless before a project exists
  $('.tabbar .inner').replaceChildren();
  $('#health').replaceChildren(el('span', { class: 'chip' }, `${tpls.length} templates`), el('span', { class: 'spacer' }));
}

function createProject(tpl) {
  const spec = specFromTemplate(tpl, tpl.id === 'blank' ? 'My App' : tpl.name + ' App');
  S.active = { id: uid(), name: spec.identity.appName, spec, updatedAt: new Date().toISOString() };
  persist();
  S.tab = 'design';
  renderActive();
}

/* ── import / export ───────────────────────────────────────────────────── */
function downloadSpec() {
  const blob = new Blob([JSON.stringify(S.active.spec, null, 2) + '\n'], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'spec.json' });
  document.body.append(a); a.click(); a.remove();
  toast('Saved spec.json');
}

async function copySpec() {
  const text = JSON.stringify(S.active.spec, null, 2);
  try { await navigator.clipboard.writeText(text); toast('Specification copied'); }
  catch { toast('Copy failed — select the text manually.'); }
}

function importSpec() {
  const input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const spec = JSON.parse(await f.text());
      S.active = { id: uid(), name: spec.identity?.appName || 'Imported', spec, updatedAt: new Date().toISOString() };
      persist(); renderActive();
      const r = check();
      toast(r.blocked ? `Imported with ${r.blocking.length} blocking problem(s).` : 'Imported and valid.');
    } catch (e) {
      toast('That file is not valid JSON.');
    }
    input.remove();
  });
  document.body.append(input); input.click();
}

/* ── GitHub connection + build ─────────────────────────────────────────── */
function openTokenSheet() {
  const dlg = el('div', { class: 'card', style: 'position:fixed;inset:auto var(--s4) var(--s4);z-index:70;box-shadow:0 20px 60px rgba(0,0,0,.6);margin:0' }, [
    el('h2', {}, 'Connect GitHub'),
    el('p', { class: 'hint' },
      'To start a build from your phone, the Studio needs permission to commit the specification to your repository. '
      + 'Use a fine-grained token limited to that one repository, with Contents: Read and write and Actions: Read and write. '
      + 'It is stored only in this browser and is only ever sent to api.github.com.'),
    field('Token', el('input', {
      type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'GitHub token',
    })),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn primary', onclick: () => {
        const v = $('input[type=password]', dlg).value.trim();
        if (!v) { toast('Paste a token first.'); return; }
        store.setToken(v);
        dlg.remove();
        hardUpdate();
        toast('Connected. Starting builds from here is now possible.');
      } }, 'Save'),
      el('button', { class: 'btn ghost', onclick: () => dlg.remove() }, 'Cancel'),
    ]),
  ]);
  document.body.append(dlg);
}

async function startBuild() {
  const token = store.token();
  const repo = store.repo() || 'deepsilence10161-source/App-mint-';
  if (!token) { openTokenSheet(); return; }

  const path = `apps/studio/${(S.active.spec.identity.packageName || 'app').split('.').pop()}/spec.json`;
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
  toast('Sending the specification…');

  try {
    // Read the current file first so we send the correct sha. Without it GitHub
    // rejects the write, and a blind overwrite is not something to attempt.
    let sha;
    const head = await fetch(api + '?ref=main', { headers });
    if (head.ok) sha = (await head.json()).sha;
    else if (head.status !== 404) throw new Error(`GitHub returned ${head.status} while reading the file.`);

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(S.active.spec, null, 2) + '\n')));
    const body = { message: `spec: update ${S.active.spec.identity.appName} from the Studio`, content, branch: 'main' };
    if (sha) body.sha = sha;

    const res = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.message || `GitHub returned ${res.status}.`);
    }

    toast('Committed. The build is starting…');

    // Watch the run so the screen shows something real instead of a static claim.
    const since = Date.now() - 5000;
    for (let i = 0; i < 40; i++) {
      await new Promise((r2) => setTimeout(r2, 3000));
      const runs = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?per_page=5&event=push`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
      ).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      const run = runs?.workflow_runs?.find((x) => new Date(x.created_at).getTime() > since);
      if (run) { S.lastRun = run; hardUpdate(); break; }
    }
  } catch (e) {
    toast(e.message || 'Could not reach GitHub.', 5000);
  }
}

/* ── boot ──────────────────────────────────────────────────────────────── */
async function boot(templatesData) {
  S.templates = templatesData || { templates: [] };
  // Saved projects may predate a schema change, so they are re-validated on
  // load rather than trusted. An old project that no longer fits simply shows
  // its findings instead of failing silently or crashing the Studio.
  S.projects = (store.load() || []).map((p) => {
    const d = defaultSpec();
    const merged = mergeSpec(d, p.spec || {});
    merged.specVersion = SPEC_VERSION;
    return { ...p, spec: merged };
  });

  const shell = $('#main');
  shell.replaceWith(main);
  main.id = 'main';

  let activeId = null;
  try { activeId = localStorage.getItem(LS_ACTIVE); } catch { /* ignore */ }
  const found = S.projects.find((p) => p.id === activeId) || S.projects[0];
  if (found) { S.active = found; renderActive(); } else { renderPicker(); }

  $('#newproj').addEventListener('click', () => { renderPicker(); });
  $('#importproj').addEventListener('click', importSpec);
  $('#themebtn').addEventListener('click', cycleTheme);
  $('#palbtn').addEventListener('click', togglePalette);

  /* Ctrl+K is the convention people arrive expecting, and Escape is the one
     that must never trap anyone inside an overlay. The palette also has a
     button, because on a phone, which is how this is mostly used, there is no
     keyboard to press. */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      togglePalette();
    } else if (e.key === 'Escape' && PAL.open) {
      e.preventDefault();
      closePalette();
    }
  });

  // Follow the system until the person says otherwise, then remember what they
  // said — including across a reload, which is when an unremembered preference
  // is most annoying.
  applyTheme(store.theme());
  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: light)')
        .addEventListener('change', () => { if (store.theme() === 'auto') applyTheme('auto'); });
    } catch { /* older browsers: the initial read still applies */ }
  }
}

window.__appmintBoot = boot;

// The Health screen prints a score for every category. A test can only check
// those numbers against the engine if it can reach the engine, so the functions
// behind the rings are exposed here — the same way boot is. Without this the
// only available test is "a number was printed", which passes just as happily
// once the UI and the engine have quietly drifted apart.
window.__appmintHealth = () => {
  const spec = S.active ? S.active.spec : {};
  return projectHealth(spec, check(), permissionReport(spec));
};

export { boot };
