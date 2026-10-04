/* ============================================================================
   PROJECT HEALTH — a score that can be argued with
   ----------------------------------------------------------------------------
   The design prompt asks for a health dashboard and then says the thing that
   makes it worth building: "Do not invent arbitrary scores. Every score must be
   calculated from measurable checks," and a person must be able to open "Why
   this score?" and see the exact checks.

   So a score here is not a number that was chosen. It is the outcome of a list
   of named checks, each of which passes, warns or fails for a stated reason, and
   the score is derived from that list by one rule that applies to every category
   alike. Two consequences follow, and both are the point:

     · a score can always be explained, because the checks are the explanation;
     · a score can be disagreed with, because the checks are visible and a person
       who thinks a check is wrong can say which one.

   And where there is nothing to measure, the category says so and scores
   nothing. A dashboard full of confident numbers, several of which were made up
   to fill the grid, teaches people to ignore all of them.

   Inputs are the specification and the result of validateSpec — the same call
   the CLI, CI and the Studio already make. Nothing here re-validates, because a
   second validator would eventually disagree with the first and nobody would
   know which to believe.
   ========================================================================= */

/** What a single check decided, and why. */
function pass(name, detail) { return { name, status: 'pass', detail }; }
function warn(name, detail) { return { name, status: 'warn', detail }; }
function fail(name, detail) { return { name, status: 'fail', detail }; }

/** Findings belonging to one validation layer. */
function layerIssues(result, n) {
  return (result.byLayer && result.byLayer[n] && result.byLayer[n].issues) || [];
}

function blockingIn(result, n) {
  return layerIssues(result, n).filter((i) => i.severity === 'critical' || i.severity === 'error');
}

/* ── categories ──────────────────────────────────────────────────────────────
   Each returns a list of checks. A category with no checks scores null, and the
   interface shows "nothing to measure" rather than a reassuring 100.
   ──────────────────────────────────────────────────────────────────────────── */

function buildHealth(spec, result) {
  const checks = [];
  const a = spec.android || {};

  checks.push(result.blocked
    ? fail('The specification validates',
        `${result.blocking.length} blocking problem(s): ${result.blocking.slice(0, 3).map((i) => i.code).join(', ')}`)
    : pass('The specification validates', 'All five validation layers passed.'));

  if (Number.isFinite(a.minSdk) && Number.isFinite(a.targetSdk)) {
    checks.push(a.minSdk <= a.targetSdk
      ? pass('Minimum SDK is not above the target', `minSdk ${a.minSdk} ≤ targetSdk ${a.targetSdk}`)
      : fail('Minimum SDK is not above the target', `minSdk ${a.minSdk} > targetSdk ${a.targetSdk} — no device can install this`));
  }

  // Google Play has required API 36 for new apps and updates since 31 Aug 2026.
  if (Number.isFinite(a.targetSdk)) {
    checks.push(a.targetSdk >= 36
      ? pass('Target SDK meets the Play requirement', `targetSdk ${a.targetSdk}`)
      : warn('Target SDK meets the Play requirement',
          `targetSdk ${a.targetSdk} is below the API 36 that Play requires for new apps and updates`));
  }

  if (spec.identity && spec.identity.packageName) {
    checks.push(pass('Package name is present', spec.identity.packageName));
  } else {
    checks.push(fail('Package name is present', 'No package name is set.'));
  }

  const mode = (spec.app || {}).mode;
  if (mode) checks.push(pass('Architecture is chosen', mode));

  return checks;
}

function securityHealth(spec, result) {
  const checks = [];
  const a = spec.android || {};
  const wv = ((spec.app || {}).webview) || {};

  // Layer 4 is the security layer: unsafe schemes, signing that is not
  // fail-closed, secrets committed into the specification.
  const sec = blockingIn(result, 4);
  checks.push(sec.length
    ? fail('The security layer found nothing blocking', sec.map((i) => i.code).join(', '))
    : pass('The security layer found nothing blocking', 'No unsafe scheme, no fail-open signing, no secret in the specification.'));

  checks.push(a.cleartextTraffic
    ? fail('Cleartext HTTP is off', 'Cleartext traffic is enabled, so traffic can be read or altered in transit.')
    : pass('Cleartext HTTP is off', 'Traffic is required to be encrypted.'));

  checks.push(a.allowBackup
    ? warn('App data is not backed up', 'allowBackup is on: app data can be extracted with adb on a device with USB debugging.')
    : pass('App data is not backed up', 'allowBackup is off.'));

  // The JavaScript bridge is the widest surface in a WebView app, so it is only
  // acceptable when something needs it.
  if (wv.javascriptEnabled) {
    checks.push(warn('The JavaScript bridge is off unless needed',
      'JavaScript is enabled in the WebView. Every method exposed to a page is attack surface.'));
  } else {
    checks.push(pass('The JavaScript bridge is off unless needed', 'JavaScript is disabled.'));
  }

  const hosts = wv.allowedHosts;
  if ((spec.app || {}).mode === 'webview' || (spec.app || {}).mode === 'hybrid') {
    checks.push(Array.isArray(hosts) && hosts.length
      ? pass('Navigation is limited to named hosts', `${hosts.length} host(s) allowlisted`)
      : warn('Navigation is limited to named hosts', 'No allowlist, so any host the app reaches can be loaded.'));
  }

  return checks;
}

function dependencyHealth(spec, result) {
  const checks = [];
  const dep = blockingIn(result, 3);
  checks.push(dep.length
    ? fail('Nothing references a capability or screen that is not there', dep.map((i) => i.code).join(', '))
    : pass('Nothing references a capability or screen that is not there', 'Every capability, screen and navigation target exists.'));

  const caps = Array.isArray(spec.capabilities) ? spec.capabilities : [];
  checks.push(pass('Capabilities are declared', caps.length ? `${caps.length}: ${caps.join(', ')}` : 'none enabled'));
  return checks;
}

function permissionHealth(spec, report) {
  const checks = [];
  if (!report) return checks;

  checks.push(report.total === 0
    ? warn('The app declares the permissions it needs', 'No permissions at all — unusual unless the app does nothing.')
    : pass('The app declares the permissions it needs', `${report.total} permission(s), each traced to a capability.`));

  // Every permission that is not requested is a smaller attack surface, and the
  // engine reports those deliberately rather than staying quiet about them.
  const dropped = Array.isArray(report.dropped) ? report.dropped.length : 0;
  checks.push(dropped
    ? pass('Unneeded permissions are refused', `${dropped} permission(s) deliberately not requested`)
    : warn('Unneeded permissions are refused', 'Nothing was refused — check that capabilities are not over-enabled.'));

  checks.push(report.prompts === 0
    ? pass('No runtime prompt is needed at first launch', 'Nothing is requested at runtime.')
    : warn('No runtime prompt is needed at first launch',
        `${report.prompts} permission(s) prompt the user, and a refusal has to be handled`));

  return checks;
}

function backendHealth(spec) {
  const b = spec.backend;
  if (!b || !b.kind || b.kind === 'none') return [];   // nothing configured: nothing to score
  const checks = [];
  checks.push(pass('A backend is configured', String(b.kind)));
  if (b.url) checks.push(/^https:/i.test(String(b.url))
    ? pass('The backend is reached over HTTPS', String(b.url))
    : fail('The backend is reached over HTTPS', String(b.url)));
  return checks;
}

/* ── scoring ───────────────────────────────────────────────────────────────── */

/**
 * One rule for every category, so a score means the same thing everywhere.
 *
 * A failing check dominates, and deliberately so: a category with one failure
 * lands in the "poor" band however many things passed. The first version of this
 * scaled failures gently by how many checks there were, which let a category
 * with a blocking failure among nine passed checks read as 65 — "fair" — and
 * that is a dashboard telling you something untrue. What passed is not
 * consolation for the one thing that will stop the build.
 */
export function scoreChecks(checks) {
  if (!checks || !checks.length) return null;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  if (failed) return Math.max(0, Math.round(100 * (1 - failed / checks.length) * 0.4));
  if (warned) return Math.round(100 - 60 * (warned / checks.length));
  return 100;
}

export function bandOf(score) {
  if (score === null) return 'none';
  if (score >= 85) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

/**
 * The whole dashboard. `validation` is the result of validateSpec and `report`
 * the result of permissionReport; both are already computed by every caller, so
 * nothing is validated twice and the numbers cannot disagree with the Build
 * screen.
 */
export function projectHealth(spec, validation, report) {
  const s = spec || {};
  const categories = [
    { key: 'build',      label: 'Build',      checks: buildHealth(s, validation) },
    { key: 'security',   label: 'Security',   checks: securityHealth(s, validation) },
    { key: 'dependency', label: 'Dependency', checks: dependencyHealth(s, validation) },
    { key: 'permission', label: 'Permission', checks: permissionHealth(s, report) },
    { key: 'backend',    label: 'Backend',    checks: backendHealth(s) },
  ];

  for (const c of categories) {
    c.score = scoreChecks(c.checks);
    c.band = bandOf(c.score);
    c.failing = c.checks.filter((x) => x.status === 'fail').length;
    c.warning = c.checks.filter((x) => x.status === 'warn').length;
  }

  const scored = categories.filter((c) => c.score !== null);
  return {
    categories,
    // An overall number is the weakest measured category, not the average of
    // them. The first version averaged, and a blank specification — build
    // scoring 0 because it has no package name and will not compile — reported
    // an overall of 65, "fair", because four other categories were happy. A
    // dashboard that can describe a project which cannot build as fair is worse
    // than no dashboard: it has been read and believed.
    //
    // Taking the minimum is also the only rule here that invents nothing. Any
    // weighted average needs weights, and there is no measurement that says
    // security is worth 30% and permissions 10%. The minimum needs no opinion,
    // and it matches the rule already used inside a category, where one failing
    // check dominates the rest.
    overall: scored.length ? Math.min(...scored.map((c) => c.score)) : null,
    weakest: scored.length
      ? scored.reduce((worst, c) => (c.score < worst.score ? c : worst), scored[0]).key
      : null,
    measured: scored.length,
    unmeasured: categories.length - scored.length,
  };
}
