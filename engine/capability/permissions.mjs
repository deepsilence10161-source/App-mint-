/**
 * PERMISSION MINIMIZATION ENGINE
 * ==============================
 * Android permissions are DERIVED from enabled capabilities — never written by
 * hand, never inherited "just in case". Disable a capability and its permission
 * disappears from the manifest. This is enforced by the generator.
 *
 * Every derived permission carries the capability that caused it and a
 * human-readable reason, so the Studio can show the user the exact table:
 *
 *   PERMISSION              WHY                        FEATURE
 *   POST_NOTIFICATIONS      Reminders and alerts       Notifications
 *   CAMERA                  Needed to scan a code      Barcode / QR
 *
 * Just as important: this module reports permissions the generated app does NOT
 * need, and permissions that were *requested by a capability but dropped as
 * unnecessary* (e.g. WRITE_EXTERNAL_STORAGE on modern Android, where it is a
 * no-op). Fewer permissions = smaller attack surface + a smaller APK.
 */

import { CAPABILITIES } from '../spec/spec.mjs';

/** Android permission -> manifest declaration attributes. */
const PERMISSION_META = {
  INTERNET:                    { protectionLevel: 'normal' },
  ACCESS_NETWORK_STATE:        { protectionLevel: 'normal' },
  POST_NOTIFICATIONS:          { protectionLevel: 'dangerous', runtime: true, since: 33 },
  SCHEDULE_EXACT_ALARM:        { protectionLevel: 'special', runtime: true, since: 31 },
  RECEIVE_BOOT_COMPLETED:      { protectionLevel: 'normal' },
  VIBRATE:                     { protectionLevel: 'normal' },
  CAMERA:                      { protectionLevel: 'dangerous', runtime: true },
  READ_EXTERNAL_STORAGE:       { protectionLevel: 'dangerous', runtime: true, maxSdk: 32, replacedBy: 'READ_MEDIA_* (33+)' },
  WRITE_EXTERNAL_STORAGE:      { protectionLevel: 'dangerous', runtime: true, maxSdk: 28, note: 'Ignored on Android 11+; kept only for Android 9 and below.' },
  ACCESS_FINE_LOCATION:        { protectionLevel: 'dangerous', runtime: true },
  ACCESS_COARSE_LOCATION:      { protectionLevel: 'dangerous', runtime: true },
  AD_ID:                       { protectionLevel: 'normal' },
  'com.android.vending.BILLING': { protectionLevel: 'normal' },
};

/**
 * Derive the minimal permission set for a spec.
 * @param {object} spec
 * @returns {{permissions:Array<{name:string,reason:string,feature:string,attrs:object}>,
 *            dropped:Array<{name:string,reason:string}>,
 *            unknownCapabilities:string[]}}
 */
export function derivePermissions(spec) {
  const caps = Array.isArray(spec.capabilities) ? spec.capabilities : [];
  const android = spec.android || {};
  const app = spec.app || {};
  const targetSdk = android.targetSdk ?? 36;

  // internet is implicit: any networked app needs it, but we still show it.
  const active = new Set(['internet', ...caps]);

  // ---- collect ---------------------------------------------------------
  const wanted = new Map(); // name -> { reason, features:Set }
  for (const capId of active) {
    const cap = CAPABILITIES[capId];
    if (!cap) continue;
    for (const p of cap.permissions) {
      if (!wanted.has(p)) wanted.set(p, { reason: cap.reason, features: new Set() });
      wanted.get(p).features.add(cap.label);
    }
  }

  // Internet already answered by a richer reason above? keep the specific one.

  // ---- drop what is genuinely unnecessary ------------------------------
  const dropped = [];
  for (const [name, meta] of Object.entries(PERMISSION_META)) {
    if (meta.maxSdk != null && targetSdk > meta.maxSdk && wanted.has(name)) {
      // Still emit, but capped with android:maxSdkVersion — the generator does that.
      // We only fully DROP when the app never touches the disk at all.
    }
  }

  // If the app has no file-upload capability, storage permissions are dead weight.
  if (!active.has('files')) {
    for (const s of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']) {
      if (wanted.has(s)) { wanted.delete(s); dropped.push({ name: s, reason: 'No file capability is enabled' }); }
    }
  }
  // Camera without barcode or camera capability is dead weight.
  if (!active.has('barcode') && !active.has('camera') && wanted.has('CAMERA')) {
    wanted.delete('CAMERA'); dropped.push({ name: 'CAMERA', reason: 'Neither barcode scanning nor camera capture is enabled' });
  }
  // Boot-completed is only meaningful if something must survive a reboot.
  if (!active.has('bootStart') && !active.has('exactAlarms') && wanted.has('RECEIVE_BOOT_COMPLETED')) {
    wanted.delete('RECEIVE_BOOT_COMPLETED'); dropped.push({ name: 'RECEIVE_BOOT_COMPLETED', reason: 'Nothing is scheduled to survive a restart' });
  }
  // Location is never implied.
  if (!active.has('location')) {
    for (const s of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
      if (wanted.has(s)) { wanted.delete(s); dropped.push({ name: s, reason: 'Location capability is disabled' }); }
    }
  }
  // Ads off => advertising ID must not be requested.
  if (!active.has('ads') && wanted.has('AD_ID')) {
    wanted.delete('AD_ID'); dropped.push({ name: 'AD_ID', reason: 'Advertisements are disabled' });
  }

  // ---- build the report ------------------------------------------------
  const permissions = [];
  for (const [name, info] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const meta = PERMISSION_META[name] || {};
    const attrs = {};
    if (meta.maxSdk != null) attrs.maxSdkVersion = meta.maxSdk;
    permissions.push({
      name: `android.permission.${name}`,
      short: name,
      reason: info.reason,
      feature: [...info.features].join(' + '),
      attrs,
      runtime: !!meta.runtime,
      since: meta.since || null,
      note: meta.note || null,
    });
  }

  const unknownCapabilities = caps.filter((c) => !CAPABILITIES[c]);

  return { permissions, dropped, unknownCapabilities };
}

/**
 * Which permissions the user will actually be PROMPTED for at runtime.
 * Shown before every build so there are no surprises on the phone.
 */
export function runtimePrompts(spec) {
  const { permissions } = derivePermissions(spec);
  const targetSdk = (spec.android || {}).targetSdk ?? 36;
  return permissions.filter((p) => p.runtime && (!p.since || targetSdk >= p.since));
}

/** Human-readable summary block used by both the CLI and the Studio UI. */
export function permissionReport(spec) {
  const { permissions, dropped } = derivePermissions(spec);
  const rows = permissions.map((p) => ({
    permission: p.short,
    why: p.reason,
    feature: p.feature,
    prompt: p.runtime ? 'Yes' : 'No',
    scope: p.attrs.maxSdkVersion ? `Android ≤ ${p.attrs.maxSdkVersion}` : 'All versions',
  }));
  return {
    rows,
    dropped,
    total: rows.length,
    prompts: rows.filter((r) => r.prompt === 'Yes').length,
  };
}
