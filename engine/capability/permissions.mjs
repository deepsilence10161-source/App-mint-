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

  // ---- what a careless implementation would have requested ----------------
  //
  // The first version of this tried to drop permissions *after* collecting
  // them, which could never fire: only an enabled capability can contribute a
  // permission, so the condition "the capability is off" was unreachable. The
  // feature that was supposed to prove permission minimisation never produced
  // any output at all. Found by the browser test that asserted on it.
  //
  // The honest version compares against everything ANY capability could ask
  // for, and reports the difference. That is a real, checkable claim: this app
  // is not requesting these, and here is why.
  const couldAsk = new Map(); // permission -> Set of capability labels
  for (const cap of Object.values(CAPABILITIES)) {
    for (const p of cap.permissions) {
      if (!couldAsk.has(p)) couldAsk.set(p, new Set());
      couldAsk.get(p).add(cap.label);
    }
  }

  const dropped = [];
  for (const [name, features] of couldAsk) {
    if (wanted.has(name)) continue;
    const names = [...features];
    dropped.push({
      name,
      reason: `capability "${names.join(' / ')}" is turned off`,
    });
  }
  dropped.sort((a, b) => a.name.localeCompare(b.name));

  // ---- build the report ------------------------------------------------
  const permissions = [];
  for (const [name, info] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const meta = PERMISSION_META[name] || {};
    const attrs = {};
    // Some permissions are meaningless on newer Android; those are capped with
    // android:maxSdkVersion rather than requested on every device.
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
