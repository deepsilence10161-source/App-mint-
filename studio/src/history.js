/* ============================================================================
   EDIT HISTORY — undo and redo for the screen designer
   ----------------------------------------------------------------------------
   The designer edits the Project Specification directly, which is what makes it
   trustworthy: there is no second model to fall out of step. The price of that
   is that a mistake lands straight in the project, and until now the only way
   back was to remember what the value used to be.

   Repairs made on the Build screen were already journaled and reversible.
   Designer edits were not, which is odd — dragging a component into the wrong
   place is far easier to do by accident than applying a repair, because the
   repair at least asks first.

   The design choice here is snapshots rather than inverse operations. An
   inverse has to be written for every kind of edit and kept correct as new
   edits are added, and the day one is wrong, "undo" quietly does something
   other than what it says. A snapshot cannot be wrong about what the state was.
   A screen is a few hundred bytes, so the cost is nothing next to the risk.

   Scope: one screen, one stack, held in memory for the session. It is
   deliberately not persisted, because an undo history that outlives the editing
   session invites a person to undo changes they made yesterday and cannot see.
   ========================================================================= */

const HISTORY_LIMIT = 60;

/* One stack, addressed by project id, so switching projects cannot offer to
   undo another project's work. */
const HIST = new Map();

function stackFor(projectId) {
  let s = HIST.get(projectId);
  if (!s) { s = { undo: [], redo: [] }; HIST.set(projectId, s); }
  return s;
}

/** A screen list that shares no structure with the original. */
function cloneScreens(screens) {
  return JSON.parse(JSON.stringify(Array.isArray(screens) ? screens : []));
}

/**
 * Call this BEFORE changing anything, with the project and the screen being
 * edited. It returns false when there is no project to record against, so a
 * caller can tell that its edit will not be undoable rather than assuming it is.
 */
function beginEdit(project, screenId, label) {
  if (!project || !project.spec) return false;
  const s = stackFor(project.id);
  s.undo.push({
    screens: cloneScreens(project.spec.screens),
    screenId: screenId || null,
    selected: D.selected || null,
    label: label || 'Change',
  });
  if (s.undo.length > HISTORY_LIMIT) s.undo.shift();
  s.redo.length = 0;              // a new edit ends any redo branch
  return true;
}

/**
 * Put the previous state back. Returns a description of what was undone, or null
 * if there was nothing to undo — the caller shows one or the other, and never
 * claims an undo happened when it did not.
 */
function undoEdit(project) {
  if (!project || !project.spec) return null;
  const s = stackFor(project.id);
  const entry = s.undo.pop();
  if (!entry) return null;
  s.redo.push({
    screens: cloneScreens(project.spec.screens),
    screenId: D.screen,
    selected: D.selected,
    label: entry.label,
  });
  project.spec.screens = entry.screens;
  if (entry.screenId) D.screen = entry.screenId;
  D.selected = entry.selected;
  return entry.label;
}

/** The mirror of undoEdit. */
function redoEdit(project) {
  if (!project || !project.spec) return null;
  const s = stackFor(project.id);
  const entry = s.redo.pop();
  if (!entry) return null;
  s.undo.push({
    screens: cloneScreens(project.spec.screens),
    screenId: D.screen,
    selected: D.selected,
    label: entry.label,
  });
  project.spec.screens = entry.screens;
  if (entry.screenId) D.screen = entry.screenId;
  D.selected = entry.selected;
  return entry.label;
}

function canUndo(project) {
  return Boolean(project && stackFor(project.id).undo.length);
}

function canRedo(project) {
  return Boolean(project && stackFor(project.id).redo.length);
}

/**
 * What the next undo will do, in words. The button says this rather than just
 * "Undo", because "Undo" on a screen full of components does not tell you which
 * of the last sixty things you are about to lose.
 */
function nextUndoLabel(project) {
  if (!project) return null;
  const s = stackFor(project.id);
  return s.undo.length ? s.undo[s.undo.length - 1].label : null;
}

/**
 * Forget a project's history. Called when a project is replaced or removed, so
 * a stack cannot outlive the thing it describes and then be applied to a
 * different project that happens to reuse an id.
 */
function clearHistory(projectId) {
  HIST.delete(projectId);
}

/**
 * Every recorded step, newest first, for a visible history list. Reading this is
 * how a person can see what undo will actually walk back through instead of
 * pressing it repeatedly and watching.
 */
function historyOf(project) {
  if (!project) return [];
  return stackFor(project.id).undo.slice().reverse().map((e) => e.label);
}
