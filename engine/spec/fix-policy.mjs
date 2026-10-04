/**
 * WHICH REPAIRS MAY BE MADE WITHOUT ASKING, AND WHICH MAY NOT
 * ==========================================================
 *
 * The engine can repair a specification by itself. The question this file
 * answers is narrower, and it is the one that decides whether that is a
 * kindness or a betrayal: given a finding and the change that would resolve it,
 * is the change *certainly* right, or is it merely *reasonable*?
 *
 * Those are not the same thing, and the difference is not cosmetic. A package
 * name containing a Java keyword cannot compile — renaming it is the only way
 * forward and no one's opinion enters into it. Turning off plain-HTTP traffic,
 * by contrast, is good advice that will silently break a small business whose
 * supplier still runs an http:// site. Applying the first without being asked is
 * helpful. Applying the second without being asked destroys work.
 *
 * So every repairable finding is classified here, once, with the reason written
 * down:
 *
 *   high    — the value cannot work, or the outcome is forced. Applied on
 *             request by "repair everything safe".
 *   review  — a valid answer to a real problem, but it changes behaviour the
 *             owner may have intended. Only ever applied by explicit choice,
 *             one at a time.
 *
 * Two rules keep this honest over time:
 *
 *   1. The default is `review`. A finding whose code has no entry here — a new
 *      one, added by someone who did not read this file — is never applied
 *      automatically. Silence is not consent.
 *   2. `tools/tests/fix-policy.test.mjs` reads the engine's own source, finds
 *      every finding that carries a repair, and fails if any of them is missing
 *      from this table. A code cannot quietly acquire auto-repair powers.
 *
 * Reasons are written for the person reading the repair screen on a phone, not
 * for a developer. They say what the change does, and what it costs.
 */

/** @type {Record<string, { confidence: 'high'|'review', why: string }>} */
export const FIX_POLICY = {
  /* ── repairs that are forced: the current value cannot work ─────────── */

  E_JAVA_KEYWORD_PKG: {
    confidence: 'high',
    why: 'A package name containing a Java keyword cannot compile at all. The keyword is renamed to the same word with "app" appended; nothing else about the name changes.',
  },
  E_RESERVED_PKG: {
    confidence: 'high',
    why: 'Google Play rejects this namespace outright, so the app could never be published under it. The name is moved under com.example, which is a placeholder — you will still want to set a real one before release.',
  },
  E_SDK_ORDER: {
    confidence: 'high',
    why: 'The minimum Android version was set higher than the target version, which describes no device that could ever exist. The minimum is lowered to match the target.',
  },
  E_COMPILE_BELOW_TARGET: {
    confidence: 'high',
    why: 'The code cannot be compiled against a version older than the one it targets. The compile version is raised to match the target.',
  },
  E_TOOLCHAIN_TOO_OLD: {
    confidence: 'high',
    why: 'The build tool in the specification is older than the compile version it must handle, so the build would stop with a version error. The toolchain is moved to the profile that matches.',
  },
  E_DUP_CAP: {
    confidence: 'high',
    why: 'The same feature is listed twice. A duplicate in a list of on-or-off features is a mistake rather than a setting; the second copy is removed and the first is kept.',
  },
  E_COMP_DUP_ID: {
    confidence: 'high',
    why: 'Two parts of one screen share a name, so the second silently takes over the first one\'s behaviour. The duplicate is renamed — it is the newcomer, so the original keeps the name you gave it.',
  },
  E_UNSAFE_SCHEME: {
    confidence: 'high',
    why: 'This link scheme can launch other apps or read local files just by being opened, and there is no ordinary reason for an app to accept it. It is removed from the allowed list.',
  },
  E_SIGNING_NOT_FAILCLOSED: {
    confidence: 'high',
    why: 'With fail-closed off, a missing keystore makes the build quietly generate a new one — which changes the app\'s identity permanently and breaks every future update. Turning it on makes the build stop and tell you instead.',
  },
  E_RELEASE_UNSIGNED: {
    confidence: 'high',
    why: 'A release build with signing switched off produces a file that cannot be installed anywhere. There is no other correct answer here.',
  },
  E_BACKEND_NOT_HTTPS: {
    confidence: 'review',
    why: 'Rewriting the scheme to https is the right answer almost always, and wrong in the case that matters: if the backend does not actually serve https, the app stops reaching it at all and every screen that needed data goes blank. That is a fact about their server which the engine cannot check from here, so it offers the change and lets the owner make it.',
  },

  /* ── repairs forced by something you built in the app ──────────────── */
  /* These add a feature the app demonstrably needs. They can add an Android
     permission, so the repair screen shows the permission change before you
     accept it — the change follows from your app, but the cost is yours to
     see. */

  W_NAV_MISSING: {
    confidence: 'high',
    why: 'The app has screens but no way to move between them, so nothing on them can be reached. Navigation is switched on — tabs when there is more than one screen, a simple stack when there is only one.',
  },
  W_ACTION_NEEDS_CAP: {
    confidence: 'high',
    why: 'A button on one of your screens uses this feature, but the feature is off, so the button would do nothing when tapped. Switching it on is what the screen was already asking for.',
  },
  W_UPLOAD_NO_CAP: {
    confidence: 'high',
    why: 'File upload is turned on but the feature that performs it is off, so the upload button would do nothing on the phone.',
  },
  W_PWA_NET: {
    confidence: 'high',
    why: 'In PWA mode the app fetches its own shell from the network on first run. Without internet access it would open to a blank screen.',
  },
  W_AUTH_NO_NET: {
    confidence: 'high',
    why: 'Signing in with a Google account is a network operation. Without internet access the sign-in button could never succeed.',
  },

  /* ── repairs that are advice: they change something you chose ───────── */

  E_PLAY_TARGET: {
    confidence: 'review',
    why: 'Target SDK sets which Android behaviour rules the app runs under, so raising it changes how the app behaves on newer phones — and the version required by Play moves over time. It is required to publish, but when you accept that is your call.',
  },
  W_CLEARTEXT: {
    confidence: 'review',
    why: 'Plain HTTP allows any network the user is on to read or alter what passes through it. Turning it off is safer, but if your site is only served over http:// it would stop loading entirely. Only you know whether your address has HTTPS.',
  },
  W_BACKUP: {
    confidence: 'review',
    why: 'Android backup copies the app\'s data to the user\'s cloud account. Turning it off stops sign-in tokens travelling off the device, but it also means someone changing phones loses their saved data. That is a decision about your product, not a correction.',
  },
  W_ALARM_ORPHAN: {
    confidence: 'review',
    why: 'Exact alarms are switched on but nothing in the app uses them, so Android would ask the user for a special "alarms and reminders" permission for no reason. Removing it is tidy — unless a screen you are about to build is going to use it.',
  },
};

/**
 * The policy entry for a finding code.
 *
 * Anything not listed is treated as needing a decision. That default is the
 * whole point of this file: a repair the maintainer never thought about must
 * not become automatic just because the code happened to carry a fix object.
 */
export function confidenceOf(code) {
  return FIX_POLICY[code] || {
    confidence: 'review',
    why: 'There is no standing decision about this one, so it is left for you to judge rather than applied automatically.',
  };
}

/** True only when the repair is forced, not merely advisable. */
export function isAutoFixable(code) {
  return confidenceOf(code).confidence === 'high';
}

/** Every code this file knows about, in the order they are declared. */
export function policyCodes() {
  return Object.keys(FIX_POLICY);
}
