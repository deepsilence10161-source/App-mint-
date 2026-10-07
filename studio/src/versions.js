/* ==================================================================== *
 * VERSION HISTORY  (snapshots, comparison, restore)
 * ====================================================================
 * What this is
 * ------------
 * A list of the states a project has been in, kept inside the project itself.
 * The master prompt asks for three things — view history, compare versions,
 * restore a version — and for the rule that matters more than any of them:
 * never silently overwrite project history.
 *
 * The design choices, and why:
 *
 *   1. SNAPSHOTS, NOT OPERATIONS. A snapshot cannot be wrong about what the
 *      state was. An undo stack of inverse operations can be, quietly, and it
 *      stops being replayable the moment two of them touch the same field.
 *
 *   2. A RESTORE SNAPSHOTS FIRST. Restoring is the one action that can destroy
 *      work, so the state being replaced is recorded before it is replaced. An
 *      undo that can itself be undone is the whole point.
 *
 *   3. THE LIST IS BOUNDED AND SAYS SO. Twelve snapshots per project, oldest
 *      dropped, and the count is on the screen. Silently growing this into the
 *      localStorage quota would turn "saved" into "saved until it wasn't".
 *
 *   4. NOTHING HERE IS SMART. No automatic merging, no guessing which of two
 *      changes was intended. A comparison says what differs; the person decides.
 */

const VERSIONS_LIMIT = 12;

/** The project's list, created on first use. Bounded, newest first. */
function versionsOf(project) {
  if (!project) return [];
  if (!Array.isArray(project.versions)) project.versions = [];
  return project.versions;
}

/** Counts a snapshot can report without running the validator over it. */
function versionStats(spec) {
  let components = 0;
  const walk = (list) => { for (const n of list || []) { components += 1; walk(n.children); } };
  for (const s of (spec.screens || [])) walk(s.components);
  const caps = Object.entries(spec.capabilities || {}).filter(([, v]) => v).map(([k]) => k);
  return { screens: (spec.screens || []).length, components, caps };
}

/**
 * Record the project as it is now. Returns the entry, or null when there is
 * nothing to record — a snapshot of no project would be a lie in a list that
 * claims to hold work.
 */
function snapshotVersion(project, note) {
  if (!project || !project.spec) return null;
  const list = versionsOf(project);
  const entry = {
    at: new Date().toISOString(),
    note: note || 'Saved by hand',
    name: project.spec.identity?.appName || project.name || 'Untitled',
    spec: JSON.parse(JSON.stringify(project.spec)),
  };
  list.unshift(entry);
  while (list.length > VERSIONS_LIMIT) list.pop();
  return entry;
}

/**
 * What differs between two specifications, said in sentences. Deliberately a
 * summary rather than a field-by-field diff: the question a person asks before
 * restoring is "what am I about to lose?", and a hundred lines of JSON is not
 * an answer to that.
 */
function versionDiff(before, after) {
  const lines = [];
  const b = versionStats(before || {});
  const a = versionStats(after || {});

  const bName = (before?.identity?.appName) || '—';
  const aName = (after?.identity?.appName) || '—';
  if (bName !== aName) lines.push(`Application name: “${bName}” → “${aName}”`);

  const bPkg = (before?.identity?.packageName) || '—';
  const aPkg = (after?.identity?.packageName) || '—';
  if (bPkg !== aPkg) lines.push(`Package name: “${bPkg}” → “${aPkg}”`);

  const bScreens = (before?.screens || []).map((s) => s.id);
  const aScreens = (after?.screens || []).map((s) => s.id);
  const added = aScreens.filter((id) => !bScreens.includes(id));
  const removed = bScreens.filter((id) => !aScreens.includes(id));
  if (added.length) lines.push(`Screens added: ${added.join(', ')}`);
  if (removed.length) lines.push(`Screens removed: ${removed.join(', ')}`);
  if (!added.length && !removed.length && b.screens !== a.screens) {
    lines.push(`Screens: ${b.screens} → ${a.screens}`);
  }

  if (b.components !== a.components) lines.push(`Components: ${b.components} → ${a.components}`);

  const capsAdded = a.caps.filter((c) => !b.caps.includes(c));
  const capsRemoved = b.caps.filter((c) => !a.caps.includes(c));
  if (capsAdded.length) lines.push(`Features enabled: ${capsAdded.join(', ')}`);
  if (capsRemoved.length) lines.push(`Features disabled: ${capsRemoved.join(', ')}`);

  const bTheme = before?.theme || {};
  const aTheme = after?.theme || {};
  for (const key of ['primary', 'background', 'surface']) {
    if (bTheme[key] !== aTheme[key]) lines.push(`Theme ${key}: ${bTheme[key] || '—'} → ${aTheme[key] || '—'}`);
  }
  const bMode = (before?.app || {}).mode;
  const aMode = (after?.app || {}).mode;
  if (bMode !== aMode) lines.push(`Architecture: ${bMode || '—'} → ${aMode || '—'}`);
  const bNav = (before?.navigation || {}).type;
  const aNav = (after?.navigation || {}).type;
  if (bNav !== aNav) lines.push(`Navigation: ${bNav || '—'} → ${aNav || '—'}`);

  return lines;
}

/**
 * Put a version back. The current state is snapshotted first, under a note that
 * says what it is, so restoring is itself reversible.
 *
 * Returns a description of what happened, or a reason nothing did — the caller
 * shows one or the other and never claims a restore that did not occur.
 */
function restoreVersion(project, index) {
  if (!project) return { ok: false, reason: 'There is no project open.' };
  const list = versionsOf(project);
  const entry = list[index];
  if (!entry || !entry.spec) return { ok: false, reason: 'That version is no longer in the list.' };

  snapshotVersion(project, `Before restoring “${entry.note}”`);

  const before = JSON.parse(JSON.stringify(project.spec));
  project.spec = JSON.parse(JSON.stringify(entry.spec));
  project.name = project.spec.identity?.appName || project.name;
  project.updatedAt = new Date().toISOString();

  // The designer's undo stack describes a structure that no longer exists, so
  // it is cleared rather than left to walk into a screen id that is gone.
  clearHistory(project.id);
  if (typeof D !== 'undefined') { D.screen = null; D.selected = null; D.adding = false; }

  return { ok: true, changed: versionDiff(before, project.spec), entry };
}
