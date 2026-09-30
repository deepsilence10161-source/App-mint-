/**
 * PROJECT1 STUDIO — Project Specification: Schema + 5-Layer Validation
 * =====================================================================
 * The Project Specification is the SINGLE SOURCE OF TRUTH. The visual editor,
 * the generator and the build pipeline all read and write this one object.
 * There is deliberately no second "editor-only" state.
 *
 * Validation layers (spec §BUILD ACCURACY SYSTEM):
 *   L1 SCHEMA     - types, required fields, formats
 *   L2 SEMANTIC   - values that are individually valid but jointly wrong
 *   L3 DEPENDENCY - capabilities/navigation/screens referencing things that
 *                   do not exist; contradictory combinations
 *   L4 SECURITY   - cleartext, exported components, unsafe schemes, secrets
 *   L5 CAPABILITY - what the selected build engine can actually produce
 *
 * Zero dependencies. Deterministic. No AI. Runs offline.
 *
 * Every issue carries: severity, code, field path, message, and (where a
 * deterministic repair exists) a `fix` object that can be applied and undone.
 */

export const SPEC_VERSION = '1.0';

// Re-exported so callers have one import for the whole specification model.
export { COMPONENTS, ACTIONS, EVENTS };

import { TOOLCHAIN_PROFILES, resolveToolchain, profileForCompileSdk } from './toolchain.mjs';
import { validateScreens, COMPONENTS, ACTIONS, EVENTS } from '../components/library.mjs';
import { confidenceOf, isAutoFixable } from './fix-policy.mjs';

/* ------------------------------------------------------------------ *
 * CAPABILITY REGISTRY
 * The single authority for what a capability is, which Android permission
 * it needs, and why. Permissions are DERIVED, never hand-written.
 * ------------------------------------------------------------------ */
export const CAPABILITIES = {
  internet:        { label: 'Internet access',        permissions: ['INTERNET', 'ACCESS_NETWORK_STATE'], reason: 'Required by every network feature', implicit: true },
  notifications:   { label: 'Notifications',          permissions: ['POST_NOTIFICATIONS'], reason: 'Lets the app show reminders and alerts', minSdk: 33 },
  exactAlarms:     { label: 'Exact reminders',        permissions: ['SCHEDULE_EXACT_ALARM', 'RECEIVE_BOOT_COMPLETED'], reason: 'Fires reminders at the exact time, and restores them after reboot' },
  share:           { label: 'Share to other apps',    permissions: [], reason: 'Uses the system share sheet; no permission required' },
  clipboard:       { label: 'Clipboard',              permissions: [], reason: 'Copy/paste text; Android restricts background reads automatically' },
  vibration:       { label: 'Vibration',              permissions: ['VIBRATE'], reason: 'Haptic feedback on interaction' },
  files:           { label: 'File upload/download',   permissions: ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'], reason: 'Reading and saving files the user picks', maxSdk: 32 },
  barcode:         { label: 'Barcode / QR scanning',  permissions: ['CAMERA'], reason: 'Camera is required to scan a code' },
  tts:             { label: 'Text to speech',         permissions: [], reason: 'Reads text aloud via the system TTS engine' },
  mediaSession:    { label: 'Media playback control', permissions: [], reason: 'Lock-screen and notification media controls' },
  deepLinks:       { label: 'Deep links',             permissions: [], reason: 'Opens the app from an https/tel/mailto/upi link' },
  telephone:       { label: 'Tap to call',            permissions: [], reason: 'Opens the dialer; the user still presses call' },
  email:           { label: 'Send email',             permissions: [], reason: 'Opens the mail composer; user still presses send' },
  upi:             { label: 'UPI payments',           permissions: [], reason: 'Hands off to the installed UPI app; no payment data touches this app' },
  screenSecurity:  { label: 'Block screenshots',      permissions: [], reason: 'FLAG_SECURE hides content in screenshots and recents' },
  ads:             { label: 'Advertisements',         permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'AD_ID'], reason: 'Ads require network and the advertising ID', disclosure: 'Adds tracking. Off by default.' },
  payments:        { label: 'In-app purchases',       permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'com.android.vending.BILLING'], reason: 'Play Billing requires the billing permission', requiresServer: true },
  googleAuth:      { label: 'Google Sign-In',         permissions: ['INTERNET', 'ACCESS_NETWORK_STATE'], reason: 'Google identity requires network; signing SHA-1 must be registered', requiresSetup: 'Register your signing SHA-1 in the Google/Firebase console' },
  camera:          { label: 'Camera capture',         permissions: ['CAMERA'], reason: 'Capturing a photo requires the camera' },
  location:        { label: 'Location',               permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'], reason: 'Fine and coarse location are requested together', highRisk: true },
  bootStart:       { label: 'Restore after reboot',   permissions: ['RECEIVE_BOOT_COMPLETED'], reason: 'Re-registers scheduled work after the device restarts' },
};

/* ------------------------------------------------------------------ *
 * SCHEMA (L1) — declarative, dependency-free
 * ------------------------------------------------------------------ */
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESERVED_PACKAGE_WORDS = ['android', 'com.android', 'java', 'javax', 'kotlin', 'kotlinx'];
/* Java reserved words. A package name becomes a Java package, so a segment that
   is a reserved word fails at compile time — with a message that does not
   mention the specification at all. Case-sensitive, because Java is. */
const JAVA_KEYWORDS = new Set([
  'abstract','assert','boolean','break','byte','case','catch','char','class','const','continue',
  'default','do','double','else','enum','extends','final','finally','float','for','goto','if',
  'implements','import','instanceof','int','interface','long','native','new','package','private',
  'protected','public','return','short','static','strictfp','super','switch','synchronized',
  'this','throw','throws','transient','try','void','volatile','while','true','false','null',
  'var','record','sealed','permits','yield','_',
]);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

export const SCHEMA = {
  required: ['specVersion', 'identity', 'android', 'app'],
  fields: {
    specVersion: { type: 'string', oneOf: [SPEC_VERSION], label: 'Specification version' },
    identity: {
      type: 'object', required: ['appName', 'packageName'],
      fields: {
        appName:     { type: 'string', minLength: 1, maxLength: 60, label: 'Application name' },
        packageName: { type: 'string', pattern: PACKAGE_RE, maxLength: 120, label: 'Package name' },
        versionName: { type: 'string', pattern: /^\d+(\.\d+){0,3}$/, label: 'Version name' },
        versionCode: { type: 'integer', min: 1, max: 2100000000, label: 'Version code' },
        versionStrategy: { type: 'string', oneOf: ['manual', 'git-commit-count'], label: 'Version source' },
        description: { type: 'string', maxLength: 4000 },
      },
    },
    android: {
      type: 'object', required: ['minSdk', 'targetSdk'],
      fields: {
        minSdk:   { type: 'integer', min: 21, max: 36, label: 'Minimum Android version' },
        targetSdk: { type: 'integer', min: 21, max: 36, label: 'Target Android version' },
        compileSdk: { type: 'integer', min: 21, max: 36 },
        orientation: { type: 'string', oneOf: ['portrait', 'landscape', 'sensor', 'unspecified'] },
        theme: { type: 'string', oneOf: ['light', 'dark', 'system'] },
        allowBackup: { type: 'boolean' },
        cleartextTraffic: { type: 'boolean' },
      },
    },
    app: {
      type: 'object', required: ['mode'],
      fields: {
        mode: { type: 'string', oneOf: ['webview', 'pwa', 'hybrid', 'native-screens'], label: 'Application architecture' },
        webview: {
          type: 'object',
          fields: {
            startUrl:     { type: 'string', pattern: URL_RE, label: 'Start URL' },
            allowedHosts: { type: 'array', of: 'string', label: 'Allowed hosts' },
            offlinePage:  { type: 'boolean', label: 'Offline fallback page' },
            fileUploads:  { type: 'boolean' },
            zoom:         { type: 'boolean' },
            forceDark:    { type: 'boolean', label: 'Force dark web content' },
            canvasBackground: { type: 'string', pattern: HEX_RE, label: 'Web canvas colour' },
            acceptLanguage: { type: 'string', maxLength: 40, label: 'Accept-Language header' },
            localAsset:   { type: 'string', maxLength: 200, label: 'Bundled start page' },
            userAgentSuffix: { type: 'string', maxLength: 60 },
            javascriptEnabled: { type: 'boolean' },
            domStorage:   { type: 'boolean' },
            externalLinks: { type: 'string', oneOf: ['in-app', 'custom-tab', 'external-browser'] },
          },
        },
        splash: { type: 'object', fields: {
          enabled: { type: 'boolean' },
          backgroundColor: { type: 'string', pattern: HEX_RE },
          durationMs: { type: 'integer', min: 0, max: 5000 },
        } },
      },
    },
    capabilities: { type: 'array', of: 'string', label: 'Native capabilities' },
    theme: {
      type: 'object',
      fields: {
        primary:   { type: 'string', pattern: HEX_RE, label: 'Primary colour' },
        onPrimary: { type: 'string', pattern: HEX_RE },
        background: { type: 'string', pattern: HEX_RE },
        surface:   { type: 'string', pattern: HEX_RE },
        onSurface: { type: 'string', pattern: HEX_RE },
        accent:    { type: 'string', pattern: HEX_RE },
        statusBarStyle: { type: 'string', oneOf: ['light', 'dark'] },
      },
    },
    build: {
      type: 'object',
      fields: {
        engine: { type: 'string', oneOf: ['github-actions', 'local-termux', 'local-desktop'], label: 'Build engine' },
        outputs: { type: 'array', of: 'string', label: 'Requested outputs', members: ['debug-apk', 'release-apk', 'signed-apk', 'aab'] },
        minify: { type: 'boolean' },
        abiSplits: { type: 'boolean' },
        cache: { type: 'boolean' },
        r8: { type: 'boolean' },
        toolchain: { type: 'object', fields: {
          agp: { type: 'string' }, gradle: { type: 'string' }, buildTools: { type: 'string' }, jdk: { type: 'string' },
        } },
      },
    },
    signing: {
      type: 'object',
      fields: {
        mode: { type: 'string', oneOf: ['none', 'debug', 'secret-store'], label: 'Signing' },
        failClosed: { type: 'boolean', label: 'Refuse to build if the keystore is missing' },
        storeFileSecretName: { type: 'string' },
      },
    },
    backend: {
      type: 'object',
      fields: {
        kind: { type: 'string', oneOf: ['none', 'supabase', 'firebase', 'custom-rest'], label: 'Backend' },
        url: { type: 'string' },
        requiresAuth: { type: 'boolean' },
        tablesRequiringRls: { type: 'array', of: 'string' },
      },
    },
    screens: { type: 'array', of: 'object', label: 'Screens' },
    navigation: { type: 'object', fields: {
      type: { type: 'string', oneOf: ['none', 'bottom-tabs', 'drawer', 'stack'] },
    } },
    deepLinks: {
      type: 'object',
      fields: {
        customScheme: { type: 'string', pattern: SCHEME_RE },
        hosts: { type: 'array', of: 'string' },
        allowedSchemes: { type: 'array', of: 'string' },
      },
    },
  },
};

/* ------------------------------------------------------------------ *
 * DEFAULT SPEC — what "start from blank" means
 * ------------------------------------------------------------------ */
export function defaultSpec() {
  return {
    specVersion: SPEC_VERSION,
    identity: {
      appName: 'My App',
      packageName: 'com.example.myapp',
      versionName: '1.0.0',
      versionCode: 1,
      versionStrategy: 'manual',
    },
    android: {
      minSdk: 24,
      targetSdk: 36,
      compileSdk: 36,
      orientation: 'portrait',
      theme: 'system',
      allowBackup: false,
      cleartextTraffic: false,
    },
    app: {
      mode: 'webview',
      webview: {
        startUrl: 'https://example.com',
        allowedHosts: [],
        offlinePage: true,
        fileUploads: true,
        zoom: false,
        forceDark: false,
        canvasBackground: '#FFFFFF',
        javascriptEnabled: true,
        domStorage: true,
        externalLinks: 'custom-tab',
      },
      splash: { enabled: true, backgroundColor: '#0B1020', durationMs: 600 },
    },
    capabilities: [],
    theme: {
      primary: '#2563EB', onPrimary: '#FFFFFF',
      background: '#0B1020', surface: '#151B2E', onSurface: '#E8ECF8',
      accent: '#22D3EE', statusBarStyle: 'dark',
    },
    build: {
      engine: 'github-actions',
      outputs: ['debug-apk'],
      minify: false,
      abiSplits: false,
      cache: true,
      r8: false,
    },
    signing: { mode: 'debug', failClosed: true },
    backend: { kind: 'none' },
    screens: [],
    navigation: { type: 'none' },
    deepLinks: { allowedSchemes: ['https', 'tel', 'mailto', 'upi'] },
  };
}

/* ------------------------------------------------------------------ *
 * HELPERS
 * ------------------------------------------------------------------ */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkType(val, def, path, out) {
  switch (def.type) {
    case 'string':
      if (typeof val !== 'string') { out.push(issue('E_TYPE', 'error', path, `Expected text, got ${Array.isArray(val) ? 'list' : typeof val}.`)); return false; }
      if (def.minLength != null && val.length < def.minLength) out.push(issue('E_MINLEN', 'error', path, `Must be at least ${def.minLength} character(s).`));
      if (def.maxLength != null && val.length > def.maxLength) out.push(issue('E_MAXLEN', 'error', path, `Must be at most ${def.maxLength} characters (currently ${val.length}).`));
      if (def.pattern && !def.pattern.test(val)) out.push(issue('E_FORMAT', 'error', path, `"${val}" is not in the expected format.`));
      if (def.oneOf && !def.oneOf.includes(val)) out.push(issue('E_ENUM', 'error', path, `"${val}" is not one of: ${def.oneOf.join(', ')}.`, { options: def.oneOf }));
      if (def.members && !def.members.includes(val)) out.push(issue('E_ENUM', 'error', path, `"${val}" is not one of: ${def.members.join(', ')}.`));
      return true;
    case 'integer':
      if (!Number.isInteger(val)) { out.push(issue('E_TYPE', 'error', path, `Expected a whole number, got ${typeof val === 'number' ? val : typeof val}.`)); return false; }
      if (def.min != null && val < def.min) out.push(issue('E_RANGE', 'error', path, `${val} is below the minimum of ${def.min}.`, { min: def.min }));
      if (def.max != null && val > def.max) out.push(issue('E_RANGE', 'error', path, `${val} is above the maximum of ${def.max}.`, { max: def.max }));
      return true;
    case 'boolean':
      if (typeof val !== 'boolean') { out.push(issue('E_TYPE', 'error', path, `Expected true or false, got ${typeof val}.`)); return false; }
      return true;
    case 'array': {
      if (!Array.isArray(val)) { out.push(issue('E_TYPE', 'error', path, `Expected a list, got ${typeof val}.`)); return false; }
      if (def.of && def.of !== 'object') val.forEach((v, i) => checkType(v, { type: def.of }, `${path}[${i}]`, out));
      return true;
    }
    case 'object': {
      if (!isObj(val)) { out.push(issue('E_TYPE', 'error', path, `Expected a group of settings, got ${Array.isArray(val) ? 'list' : typeof val}.`)); return false; }
      if (def.required) for (const r of def.required) if (val[r] === undefined) out.push(issue('E_REQUIRED', 'error', `${path}.${r}`, `Missing required value.`));
      if (def.fields) for (const [k, sub] of Object.entries(def.fields)) if (val[k] !== undefined) checkType(val[k], sub, `${path}.${k}`, out);
      return true;
    }
    default: return true;
  }
}

let CODES = 0;
export function issue(code, severity, path, message, extra = {}) {
  return { id: `${code}-${++CODES}`, code, severity, path, message, ...extra };
}

/* ------------------------------------------------------------------ *
 * THE FIVE LAYERS
 * ------------------------------------------------------------------ */

/** L1 — SCHEMA: shape, types, formats, required fields. */
export function layer1Schema(spec, out) {
  if (!isObj(spec)) { out.push(issue('E_NOTOBJECT', 'error', '', 'The project specification must be a group of settings.')); return; }
  for (const r of SCHEMA.required) if (spec[r] === undefined) out.push(issue('E_REQUIRED', 'error', r, `Missing required section "${r}".`));
  for (const [k, def] of Object.entries(SCHEMA.fields)) if (spec[k] !== undefined) checkType(spec[k], def, k, out);
}

/** L2 — SEMANTIC: values valid alone but wrong together. */
export function layer2Semantic(spec, out) {
  const id = spec.identity || {}, a = spec.android || {}, app = spec.app || {}, b = spec.build || {};

  if (id.packageName) {
    const badKeyword = String(id.packageName).split('.').find((seg) => JAVA_KEYWORDS.has(seg));
    if (badKeyword)
      out.push(issue('E_JAVA_KEYWORD_PKG', 'error', 'identity.packageName',
        `The package name contains "${badKeyword}", which is a Java reserved word. Android would compile the generated code into a package that Java cannot name, and the build would fail.`,
        { fix: { kind: 'set', path: 'identity.packageName',
            value: String(id.packageName).split('.').map((seg) => (JAVA_KEYWORDS.has(seg) ? seg + 'app' : seg)).join('.') } }));
  }

  if (id.packageName && RESERVED_PACKAGE_WORDS.some((w) => id.packageName === w || id.packageName.startsWith(w + '.')))
    out.push(issue('E_RESERVED_PKG', 'error', 'identity.packageName',
      `The package name starts with a reserved namespace ("${id.packageName.split('.').slice(0, 2).join('.')}"). Google Play rejects these.`,
      { fix: { kind: 'set', path: 'identity.packageName', value: 'com.example.' + (id.packageName.split('.').pop() || 'app') } }));

  if (id.packageName && /(app|example)$/i.test(id.packageName.split('.').pop()) && id.packageName.startsWith('com.example'))
    out.push(issue('W_DEFAULT_PKG', 'warning', 'identity.packageName',
      'This is still the placeholder package name. It is permanent once published — change it before your first release.'));

  if (a.minSdk && a.targetSdk && a.minSdk > a.targetSdk)
    out.push(issue('E_SDK_ORDER', 'error', 'android.minSdk',
      `Minimum SDK (${a.minSdk}) is higher than target SDK (${a.targetSdk}). No device could ever run this.`,
      { fix: { kind: 'set', path: 'android.minSdk', value: a.targetSdk } }));

  if (a.targetSdk && a.compileSdk && a.targetSdk > a.compileSdk)
    out.push(issue('E_COMPILE_BELOW_TARGET', 'error', 'android.compileSdk',
      `Target SDK (${a.targetSdk}) is higher than compile SDK (${a.compileSdk}). You cannot target what you do not compile against.`,
      { fix: { kind: 'set', path: 'android.compileSdk', value: a.targetSdk } }));

  // Play compliance — verified against the 2026 policy (API 36 for new apps/updates).
  if (a.targetSdk && a.targetSdk < 35 && (b.outputs || []).some((o) => o !== 'debug-apk'))
    out.push(issue('E_PLAY_TARGET', 'error', 'android.targetSdk',
      `Target SDK ${a.targetSdk} cannot be published to Google Play. Since 31 Aug 2026 new apps and all updates must target 36 (Android 16); 35 is the minimum to stay visible to new users.`,
      { fix: { kind: 'set', path: 'android.targetSdk', value: 36 } }));
  else if (a.targetSdk && a.targetSdk < 36 && (b.outputs || []).some((o) => o !== 'debug-apk'))
    out.push(issue('W_PLAY_TARGET', 'warning', 'android.targetSdk',
      `Target SDK ${a.targetSdk} is below 36. Google Play has required API 36 for new apps and updates since 31 Aug 2026.`));

  if (a.cleartextTraffic === true)
    out.push(issue('W_CLEARTEXT', 'warning', 'android.cleartextTraffic',
      'Plain HTTP traffic is allowed. Any network the user is on can read or change it. Only enable this for a legacy site with no HTTPS.',
      { fix: { kind: 'set', path: 'android.cleartextTraffic', value: false } }));

  if (a.allowBackup === true)
    out.push(issue('W_BACKUP', 'warning', 'android.allowBackup',
      'Android backup is on. If the app stores sign-in tokens, an unscoped backup can carry them off the device.',
      { fix: { kind: 'set', path: 'android.allowBackup', value: false } }));

  const insets = [];
  if (app.mode === 'webview' || app.mode === 'pwa' || app.mode === 'hybrid') {
    if (!app.webview || !app.webview.startUrl) insets.push(issue('E_NO_URL', 'error', 'app.webview.startUrl', `Mode "${app.mode}" needs a start URL.`));
  }
  if (app.mode === 'native-screens' && (!Array.isArray(spec.screens) || spec.screens.length === 0))
    insets.push(issue('E_NO_SCREENS', 'error', 'screens', 'Native-screens mode needs at least one screen.'));
  out.push(...insets);

  if (id.versionName && id.versionCode) {
    const patch = Number((id.versionName.split('.')[2] || id.versionName.split('.')[1] || '0'));
    if (Number.isFinite(patch) && patch > id.versionCode && id.versionCode === 1)
      out.push(issue('I_VERSION', 'info', 'identity.versionCode', 'Version code is still 1. Play requires a strictly increasing code on every upload.'));
  }
  if (id.versionStrategy === 'git-commit-count' && b.engine !== 'github-actions')
    out.push(issue('W_VERSION_STRATEGY', 'warning', 'identity.versionStrategy',
      'Version from git commit count needs the repository history. The GitHub Actions engine fetches it; other engines may not.'));
}

/** L3 — DEPENDENCY: things referencing things that do not exist. */
export function layer3Dependency(spec, out) {
  const caps = spec.capabilities || [];
  const seen = new Set();
  for (const c of caps) {
    if (seen.has(c)) out.push(issue('E_DUP_CAP', 'error', 'capabilities',
      `Capability "${c}" is listed twice.`, { fix: { kind: 'removeArrayItem', path: 'capabilities', value: c } }));
    seen.add(c);
    if (!CAPABILITIES[c]) {
      const near = Object.keys(CAPABILITIES).filter((k) => k.toLowerCase().startsWith(String(c).slice(0, 3).toLowerCase())).slice(0, 3);
      out.push(issue('E_UNKNOWN_CAP', 'error', 'capabilities',
        `"${c}" is not a known capability.`, { options: near.length ? near : Object.keys(CAPABILITIES) }));
    }
  }

  const app = spec.app || {};
  const wv = app.webview || {};
  if (wv.fileUploads === true && !caps.includes('files'))
    out.push(issue('W_UPLOAD_NO_CAP', 'warning', 'app.webview.fileUploads',
      'File uploads need the "files" capability, otherwise the upload button will do nothing on the phone.',
      { fix: { kind: 'addArrayItem', path: 'capabilities', value: 'files' } }));

  if (app.mode === 'pwa' && !caps.includes('internet'))
    out.push(issue('W_PWA_NET', 'warning', 'app.mode',
      'PWA mode still loads its shell from the network on first run; the internet capability is recommended.',
      { fix: { kind: 'addArrayItem', path: 'capabilities', value: 'internet' } }));

  if (caps.includes('exactAlarms') && !caps.includes('notifications') && !caps.includes('bootStart'))
    out.push(issue('W_ALARM_ORPHAN', 'warning', 'capabilities',
      'Exact alarms are enabled but nothing uses them. This makes Android ask for a special "alarms and reminders" permission for no reason.',
      { fix: { kind: 'removeArrayItem', path: 'capabilities', value: 'exactAlarms' } }));

  if (caps.includes('payments') && (spec.backend || {}).kind === 'none')
    out.push(issue('E_PAY_NO_BACKEND', 'error', 'capabilities',
      'In-app purchases need a backend to verify the receipt server-side. Without it, the client would be trusted to say "paid" — which anyone can fake.',
      { hint: 'Set backend.kind to supabase or custom-rest.' }));

  if (caps.includes('googleAuth') && !caps.includes('internet'))
    out.push(issue('W_AUTH_NO_NET', 'warning', 'capabilities', 'Google Sign-In needs internet.',
      { fix: { kind: 'addArrayItem', path: 'capabilities', value: 'internet' } }));

  if (caps.includes('barcode') && !(wv.startUrl || (spec.screens || []).length))
    out.push(issue('W_BARCODE_UNUSED', 'info', 'capabilities', 'Barcode scanning is enabled but no screen uses it yet.'));

  const nav = spec.navigation || {};
  if (nav.type === 'bottom-tabs' && (spec.screens || []).length < 2)
    out.push(issue('W_NAV_THIN', 'warning', 'navigation.type', 'Bottom tabs with fewer than two screens leaves empty tabs.'));

  // Screens are structures: every reference inside them must resolve, and every
  // action must be able to run. This is where a half-built screen gets caught,
  // rather than at runtime on a user's phone.
  validateScreens(spec, out);
}

/** L4 — SECURITY: the gate. Critical findings block the build unless overridden. */
export function layer4Security(spec, out) {
  const caps = spec.capabilities || [];
  const dl = spec.deepLinks || {};
  const b = spec.build || {};

  // Unsafe URL schemes must never be routed to a raw Intent (the exact defect
  // found in ff-user-panel/MainActivity.java).
  const DANGEROUS = ['intent', 'file', 'content', 'javascript', 'data', 'jar'];
  const offered = dl.allowedSchemes || [];
  for (const s of offered) {
    if (DANGEROUS.includes(String(s).toLowerCase()))
      out.push(issue('E_UNSAFE_SCHEME', 'critical', 'deepLinks.allowedSchemes',
        `Scheme "${s}" is unsafe to route automatically. It can launch arbitrary components or read local files.`,
        { fix: { kind: 'removeArrayItem', path: 'deepLinks.allowedSchemes', value: s } }));
  }

  if ((spec.signing || {}).mode === 'secret-store' && (spec.signing || {}).failClosed === false)
    out.push(issue('E_SIGNING_NOT_FAILCLOSED', 'critical', 'signing.failClosed',
      'Signing is set to a secret store but fail-closed is off. If the keystore is missing, a new one would be generated — which silently changes your app identity and permanently breaks Google Sign-In and every future update.',
      { fix: { kind: 'set', path: 'signing.failClosed', value: true } }));

  if ((b.outputs || []).some((o) => o !== 'debug-apk') && (spec.signing || {}).mode === 'none')
    out.push(issue('E_RELEASE_UNSIGNED', 'critical', 'signing.mode',
      'A release or AAB build was requested with signing disabled. The output could not be installed on any device.',
      { fix: { kind: 'set', path: 'signing.mode', value: 'secret-store' } }));

  if (caps.includes('ads') && (spec.build || {}).outputs?.length)
    out.push(issue('W_ADS_TRACKING', 'warning', 'capabilities',
      'Advertisements add a tracking identifier and are off for a reason. Enable only if you truly need them.'));

  if (caps.includes('location'))
    out.push(issue('W_LOCATION_HIGH_RISK', 'warning', 'capabilities',
      'Location is a high-risk permission. Google Play requires a written justification and, for background use, a review.'));

  // Secret-looking values inside the spec itself.
  const raw = JSON.stringify(spec);
  const SECRET_PATTERNS = [
    { re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, what: 'a JWT (possibly a service_role key)' },
    { re: /sk-[A-Za-z0-9]{20,}/g, what: 'an OpenAI-style secret key' },
    { re: /AIza[A-Za-z0-9_-]{30,}/g, what: 'a Google API key' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: 'a private key' },
    { re: /(?:password|passwd|secret|service_role)\s*[:=]\s*["'][^"']{8,}["']/gi, what: 'a hard-coded password or secret' },
  ];
  for (const { re, what } of SECRET_PATTERNS) {
    const m = raw.match(re);
    if (m) out.push(issue('E_SECRET_IN_SPEC', 'critical', 'spec',
      `The specification appears to contain ${what}. Remove it and keep it in the build engine's secret store — this file is committed to a repository.`,
      { redactedSample: String(m[0]).slice(0, 4) + '…redacted' }));
  }

  if (spec.backend && spec.backend.kind !== 'none' && (spec.backend.tablesRequiringRls || []).length === 0 && spec.backend.requiresAuth)
    out.push(issue('W_RLS_UNSPECIFIED', 'warning', 'backend.tablesRequiringRls',
      'Authentication is on, but no tables are listed as needing row-level security. RLS is the only thing standing between one signed-in user and another user\'s rows.'));
}

/** L5 — CAPABILITY: can the chosen engine actually produce this? */
export function layer5Capability(spec, out) {
  const ENGINE = {
    'github-actions': { aab: true, signedApk: true, emulator: true, label: 'GitHub Actions (free, unlimited on public repos)' },
    'local-termux':   { aab: true, signedApk: true, emulator: false, label: 'Termux on the phone' },
    'local-desktop':  { aab: true, signedApk: true, emulator: true, label: 'This desktop' },
  };
  const b = spec.build || {};
  const e = ENGINE[b.engine || 'github-actions'];
  if (!e) { out.push(issue('E_UNKNOWN_ENGINE', 'error', 'build.engine', `Unknown build engine "${b.engine}".`)); return; }

  for (const o of b.outputs || []) {
    if (o === 'aab' && !e.aab) out.push(issue('E_ENGINE_NO_AAB', 'error', 'build.outputs', `${e.label} cannot produce an AAB.`));
    if ((o === 'signed-apk' || o === 'release-apk') && !e.signedApk) out.push(issue('E_ENGINE_NO_SIGN', 'error', 'build.outputs', `${e.label} cannot sign a release build.`));
  }

  const a = spec.android || {};
  // Toolchain compatibility is data-driven (engine/spec/toolchain.mjs) so the
  // validator and the generator can never disagree about what an AGP version
  // can actually compile.
  const effective = resolveToolchain(spec);
  const compileSdk = a.compileSdk ?? effective.maxCompileSdk;
  if (compileSdk > effective.maxCompileSdk) {
    const better = profileForCompileSdk(compileSdk);
    const bt = TOOLCHAIN_PROFILES[better];
    out.push(issue('E_TOOLCHAIN_TOO_OLD', 'error', 'build.toolchain.agp',
      `compileSdk ${compileSdk} cannot be compiled by AGP ${effective.agp} (it stops at SDK ${effective.maxCompileSdk}). ` +
      `Switch to the "${better}" profile: AGP ${bt.agp} with Gradle ${bt.gradle}.`,
      {
        fix: { kind: 'set', path: 'build.toolchain.agp', value: bt.agp },
        alsoNeeds: { 'build.toolchain.gradle': bt.gradle, 'build.toolchain.buildTools': bt.buildTools },
      }));
  }
  if (a.minSdk != null && a.minSdk < 21) out.push(issue('E_MIN_TOO_LOW', 'error', 'android.minSdk', 'Android 5.0 (API 21) is the oldest version still worth supporting.'));
  if (spec.app && spec.app.mode === 'pwa' && spec.build && spec.build.engine === 'local-termux')
    out.push(issue('W_PWA_TERMUX', 'warning', 'app.mode', 'PWA mode works, but offline caching behaves differently on the phone-based engine. Test on a real device.'));
}

/* ------------------------------------------------------------------ *
 * MAIN ENTRY
 * ------------------------------------------------------------------ */
export const LAYERS = [
  { n: 1, name: 'Schema',     fn: layer1Schema },
  { n: 2, name: 'Semantic',   fn: layer2Semantic },
  { n: 3, name: 'Dependency', fn: layer3Dependency },
  { n: 4, name: 'Security',   fn: layer4Security },
  { n: 5, name: 'Capability', fn: layer5Capability },
];

/**
 * Run all five layers.
 * @returns {{ok:boolean, blocked:boolean, issues:Array, byLayer:Object, counts:Object}}
 * `blocked` is the gate: critical or error severities stop the build unless the
 * caller supplies an explicit, visible, logged override.
 */
export function validateSpec(spec, opts = {}) {
  CODES = 0;
  const issues = [];
  const byLayer = {};
  for (const L of LAYERS) {
    const before = issues.length;
    L.fn(spec, issues);
    byLayer[L.n] = { name: L.name, issues: issues.slice(before) };
  }
  const overrides = opts.overrides || [];
  const isOverridden = (i) => overrides.some((o) => o.code === i.code);
  const blocking = issues.filter((i) => (i.severity === 'critical' || i.severity === 'error') && !isOverridden(i));
  const counts = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return {
    ok: blocking.length === 0,
    blocked: blocking.length > 0,
    issues,
    blocking,
    byLayer,
    counts,
    overridesApplied: issues.filter((i) => (i.severity === 'critical' || i.severity === 'error') && isOverridden(i)).map((i) => i.code),
  };
}

/* ------------------------------------------------------------------ *
 * DETERMINISTIC REPAIR (rule-based only — never AI)
 * Applies ONLY high-confidence fixes that carry an explicit `fix` object,
 * records every change so it can be rolled back, and re-validates.
 * ------------------------------------------------------------------ */
export function applyFixes(spec, issues, { onlyCodes = null, maxRounds = 5 } = {}) {
  const clone = JSON.parse(JSON.stringify(spec));
  const applied = [];
  let current = clone;
  let result = validateSpec(current);

  for (let round = 0; round < maxRounds; round++) {
    const candidates = result.issues.filter((i) =>
      i.fix && (onlyCodes ? onlyCodes.includes(i.code) : true) &&
      (i.severity === 'critical' || i.severity === 'error' || i.severity === 'warning'));
    if (candidates.length === 0) break;

    const chosen = candidates[0];
    const undo = setPath(current, chosen.fix);
    if (!undo) break;
    applied.push({ code: chosen.code, path: chosen.path, fix: chosen.fix, message: chosen.message, undo });
    result = validateSpec(current);
  }
  return { spec: current, applied, result, rolledBack: false };
}

function getParent(obj, path) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) { if (cur == null) return null; cur = cur[p]; }
  return { parent: cur, key: last };
}

/** Apply one fix, returning the inverse operation so it can be rolled back. */
function setPath(spec, fix) {
  const loc = getParent(spec, fix.path);
  if (!loc || loc.parent == null) return null;
  const { parent, key } = loc;
  switch (fix.kind) {
    case 'set': {
      const had = key in parent;
      const prev = parent[key];
      parent[key] = fix.value;
      if (fix.alsoNeeds) for (const [p, v] of Object.entries(fix.alsoNeeds)) { const l = getParent(spec, p); if (l && l.parent) l.parent[l.key] = v; }
      return { kind: 'set', path: fix.path, had, prev };
    }
    case 'addArrayItem': {
      if (!Array.isArray(parent)) return null;
      const arr = parent[key] || (parent[key] = []);
      if (arr.includes(fix.value)) return null;
      arr.push(fix.value);
      return { kind: 'removeArrayItem', path: fix.path, value: fix.value };
    }
    case 'removeArrayItem': {
      const arr = parent[key];
      if (!Array.isArray(arr)) return null;
      const idx = arr.indexOf(fix.value);
      if (idx < 0) return null;
      arr.splice(idx, 1);
      return { kind: 'insertArrayItem', path: fix.path, value: fix.value, at: idx };
    }
    default: return null;
  }
}

/** Undo a previously applied fix. Guarantees automatic repairs are reversible. */
export function rollbackFix(spec, entry) {
  const u = entry.undo, loc = getParent(spec, u.path);
  if (!loc || loc.parent == null) return false;
  const { parent, key } = loc;
  if (u.kind === 'set') { if (u.had) parent[key] = u.prev; else delete parent[key]; return true; }
  if (u.kind === 'removeArrayItem' && Array.isArray(parent[key])) { parent[key] = parent[key].filter((v) => v !== u.value); return true; }
  if (u.kind === 'insertArrayItem' && Array.isArray(parent[key])) { parent[key].splice(u.at, 0, u.value); return true; }
  return false;
}


/* ══════════════════════════════════════════════════════════════════════════
   REPAIR PLANNING
   ══════════════════════════════════════════════════════════════════════════

   applyFixes() above answers "make it valid". This answers the question that
   comes first: "what exactly would change, and am I allowed to do that on my
   own?"

   It works on a copy, so nothing is altered until the caller decides. Every
   step it returns carries the value before and the value after, because a
   repair nobody can inspect is a repair nobody can refuse.
   ══════════════════════════════════════════════════════════════════════════ */

/** The value at a dotted path, or undefined. Arrays use the usual [i] form. */
function readPath(obj, path) {
  if (!path) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * What one repair would do, in the terms a person reads.
 *
 * The `before` and `after` are taken from the real specification rather than
 * composed from the finding's text, so what the screen shows is what the
 * engine would actually write.
 */
function describeFix(spec, issue) {
  const fix = issue.fix;
  // Read from the specification as it stands now, never from the post-repair
  // copy: "before" has to mean what the owner has, or the screen would show a
  // change from the repaired value to itself.
  const before = readPath(spec, fix.path);
  let next;
  if (fix.kind === 'set') next = fix.value;
  else if (fix.kind === 'addArrayItem') next = [...(Array.isArray(before) ? before : []), fix.value];
  else if (fix.kind === 'removeArrayItem') next = (Array.isArray(before) ? before : []).filter((v) => v !== fix.value);
  else next = undefined;

  const policy = confidenceOf(issue.code);
  return {
    code: issue.code,
    severity: issue.severity,
    path: fix.path,
    message: issue.message,
    kind: fix.kind,
    before,
    after: next,
    alsoNeeds: fix.alsoNeeds ? Object.entries(fix.alsoNeeds).map(([p, v]) => ({ path: p, value: v })) : [],
    confidence: policy.confidence,
    why: policy.why,
  };
}

/** A short "a → b" rendering of a value, for the screen. */
export function showValue(v) {
  if (v === undefined) return 'not set';
  if (v === null) return 'nothing';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'empty';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Apply every forced repair, repeating until nothing is left to force.
 *
 * Two things make this less simple than it looks.
 *
 * First, one pass is not enough. Repairs have consequences: raising the compile
 * version to match the target version can leave the build tool too old for it,
 * a second problem that only exists because the first one was fixed.
 *
 * Second — and this is the part that matters — a repair offered by the engine is
 * not automatically a repair that works. The engine's own rule for a mismatched
 * SDK pair is "set compile to target", which is right until the target itself is
 * out of range, at which point carrying it out moves the value somewhere the
 * schema forbids and turns one error into two. A repair that makes the
 * specification worse is not a repair, and it is not applied here however
 * confidently it was proposed.
 *
 * So each round is judged on its result: it is kept only if it strictly reduces
 * the number of errors. Otherwise it is discarded, the loop stops, and the
 * reason is handed back for the screen to explain.
 */
function autoRepairAll(spec, maxRounds = 6) {
  const errorsIn = (r) => r.issues.filter((i) => i.severity === 'critical' || i.severity === 'error').length;

  let current = JSON.parse(JSON.stringify(spec));
  const applied = [];
  const refused = [];
  let result = validateSpec(current);
  let stopped = 'nothing-to-do';

  for (let round = 0; round < maxRounds; round++) {
    const codes = result.issues.filter((i) => i.fix && isAutoFixable(i.code)).map((i) => i.code);
    if (!codes.length) { stopped = 'settled'; break; }

    const step = applyFixes(current, result.issues, { onlyCodes: codes });
    if (!step.applied.length) { stopped = 'settled'; break; }

    const after = validateSpec(step.spec);
    if (errorsIn(after) >= errorsIn(result) && errorsIn(after) > 0) {
      // Kept nothing: say which repair was refused and what it would have cost.
      refused.push({
        code: step.applied[0].code,
        path: step.applied[0].path,
        message: step.applied[0].message,
        why: 'Carrying this out would leave more problems than it solves, so it was left alone.',
        wouldGive: errorsIn(after),
        had: errorsIn(result),
      });
      stopped = 'refused';
      break;
    }

    applied.push(...step.applied);
    current = step.spec;
    result = after;
  }

  return { spec: current, applied, result, refused, stopped };
}

/**
 * Plan the repairs for a specification.
 *
 * Returns three things:
 *   steps         — every repair available, each with its before and after
 *   stepsAuto     — the subset that may be done without asking
 *   stepsReview   — the subset that changes something the owner chose
 *
 * `preview.spec` is the specification you would get from doing the automatic
 * repairs, worked out on a copy. `preview.result` is what the validator says
 * about that outcome, which is how a caller can tell the honest truth — "this
 * fixes 3 of 5 problems" — instead of implying that every repair succeeds.
 */
export function planFixes(spec, issues = null, { onlyCodes = null } = {}) {
  const findings = issues || validateSpec(spec).issues;
  const withFix = findings.filter((i) => i && i.fix && (!onlyCodes || onlyCodes.includes(i.code)));

  // Only forced repairs take the automatic pass. A repair that changes a
  // decision the owner made is never in it, whatever its severity: severity
  // says how bad the problem is, not how safe the answer is.
  const preview = autoRepairAll(spec);

  const steps = withFix.map((i) => describeFix(spec, i));

  // A forced repair can be discovered by another forced repair — the toolchain
  // step above only exists once the compile version has moved. Those are real
  // steps, so they are listed too, marked as automatic.
  const known = new Set(steps.map((x) => x.code));
  for (const a of preview.applied) {
    if (known.has(a.code)) continue;
    known.add(a.code);
    steps.push({
      code: a.code,
      severity: 'error',
      path: a.path,
      message: a.message,
      kind: (a.fix || {}).kind || 'set',
      before: a.undo && a.undo.kind === 'set' ? a.undo.prev : undefined,
      after: (a.fix || {}).value,
      alsoNeeds: [],
      confidence: 'high',
      why: confidenceOf(a.code).why,
      discovered: true,
    });
  }

  return {
    steps,
    stepsAuto: steps.filter((s) => s.confidence === 'high'),
    stepsReview: steps.filter((s) => s.confidence !== 'high'),
    preview: {
      spec: preview.spec,
      applied: preview.applied.map((a) => ({ code: a.code, path: a.path, message: a.message, undo: a.undo })),
      result: preview.result,
      // Repairs the engine declined to make, and why. Empty is the normal case;
      // when it is not empty the screen says so rather than pretending the
      // problem was handled.
      refused: preview.refused || [],
      stopped: preview.stopped,
    },
    changed: preview.applied.length,
  };
}

/**
 * Apply the repairs a person has agreed to, and report what changed.
 *
 * `codes` names the findings to repair; leaving it out means "everything that
 * may be done without asking". Each entry in `applied` carries the inverse
 * operation, so the whole thing can be undone by walking backwards through it
 * with rollbackFix().
 */
export function repair(spec, { codes = null, issues = null } = {}) {
  const before = validateSpec(spec);
  const chosen = codes || before.issues.filter((i) => i.fix && isAutoFixable(i.code)).map((i) => i.code);
  if (!chosen.length) return { spec, applied: [], before, after: before, changed: 0 };

  const reviewCodes = chosen.filter((c) => !isAutoFixable(c));
  const wantsAuto = chosen.some((c) => isAutoFixable(c));

  // The forced repairs run to completion, including any they reveal along the
  // way. A repair that needed a decision is applied exactly as asked, one code
  // at a time, with its own undo entry — recorded with the same honesty.
  const first = wantsAuto
    ? autoRepairAll(spec)
    : { spec: JSON.parse(JSON.stringify(spec)), applied: [], result: before };

  let current = first.spec;
  const applied = [...first.applied];

  for (const code of reviewCodes) {
    const result = applyFixes(current, validateSpec(current).issues, { onlyCodes: [code] });
    current = result.spec;
    applied.push(...result.applied);
  }

  const after = validateSpec(current);
  return { spec: current, applied, before, after, changed: applied.length };
}
