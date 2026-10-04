/* ==================================================================== *
 * THE SCREEN DESIGNER  (M5)
 * ====================================================================
 * What this is
 * ------------
 * A phone-first editor for the screens of an app. It edits the same
 * specification object that the generator reads, so what is designed here is
 * what the APK contains — there is no second format and no export step.
 *
 * Three things are deliberately true of everything below:
 *
 *   1. THE PALETTE IS NOT WRITTEN HERE. Every component, every property, its
 *      type, its default, whether it may hold children and whether it needs a
 *      screen-reader label comes from engine/components/library.mjs. Adding a
 *      component there makes it appear here with an editor and validation,
 *      with nothing in this file to update.
 *
 *   2. THE PREVIEW IS NOT A PICTURE. It is drawn from the same numbers the
 *      Android renderer uses (engine/components/scales.mjs) and from the same
 *      component descriptions, so it is a drawing of the app rather than an
 *      impression of it.
 *
 *   3. IT IS HONEST ABOUT ITSELF. The preview is drawn with HTML in a browser;
 *      it is not the compiled APK. It says so, once, in plain words, rather
 *      than pretending to be a device.
 *
 * Editing model: the tree is the truth. Selecting a component shows its
 * properties; changing a property edits the tree; the preview redraws.
 */

const D = {
  screen: null,     // id of the screen being edited
  selected: null,   // id of the selected component
  group: null,      // which palette group is open
  adding: false,    // is the palette showing
  depth: 0,         // recursion guard for the preview
  dragging: null,   // id of the component being dragged
  dragOver: null,   // id of the component the drop line is drawn above
};

const MAX_PREVIEW_DEPTH = 12;

/* ── the specification's screens ────────────────────────────────────────── */

function screensOf(spec) {
  if (!Array.isArray(spec.screens)) spec.screens = [];
  return spec.screens;
}

/** A new screen with a sensible id that does not collide with an existing one. */
function makeScreen(spec, name) {
  const base = (name || 'Screen').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'screen';
  let id = base;
  let n = 2;
  const taken = new Set(screensOf(spec).map((s) => s.id));
  while (taken.has(id)) id = base + (n++);
  return { id, name: name || 'Screen', title: name || 'Screen', showInTabs: true, components: [] };
}

/** A brand new screen with a heading and a sentence, so it is never blank. */
function starterScreen(spec, name, index) {
  const s = makeScreen(spec, name || `Screen ${index + 1}`);
  s.components = [
    { id: nid(s, 'heading'), type: 'Heading', props: { text: s.name } },
    { id: nid(s, 'text'), type: 'Text', props: { text: 'Say what this screen is for. Tap it, then edit its text on the right.' } },
  ];
  return s;
}

/** A component id that is unique inside its screen. */
function nid(screen, prefix) {
  const base = (prefix || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'item';
  const taken = new Set();
  (function walk(list) {
    for (const n of list || []) { if (n && n.id) taken.add(n.id); walk(n.children); }
  })(screen ? screen.components : []);
  let id = base;
  let n = 2;
  while (taken.has(id)) id = base + (n++);
  return id;
}

/** locate() without the side effect, for callers that only want to look. */
function found0(screen, id) {
  return locate(screen, id);
}

function activeScreen(spec) {
  const list = screensOf(spec);
  if (!list.length) return null;
  const found = list.find((s) => s.id === D.screen);
  if (found) return found;
  D.screen = list[0].id;
  return list[0];
}

/* ── finding and moving components ──────────────────────────────────────── */

/**
 * Locate a component by id anywhere in a screen.
 * Returns the node, the list it lives in, its position, and the screen.
 */
function locate(screen, id) {
  let hit = null;
  (function walk(list, parent) {
    if (hit || !list) return;
    for (const [i, node] of list.entries()) {
      if (!node) continue;
      if (node.id === id) { hit = { node, list, index: i, parent }; return; }
      walk(node.children, node);
      if (hit) return;
    }
  })(screen.components, null);
  return hit;
}

/** Where a new component should go: inside the selection if it can hold children. */
function insertTarget(screen) {
  const found = D.selected ? locate(screen, D.selected) : null;
  if (found) {
    const def = COMPONENTS[found.node.type];
    if (def && def.container && !def.single) return { list: found.node.children, parent: found.node.id };
  }
  if (!screen.components) screen.components = [];
  return { list: screen.components, parent: null };
}

function addComponent(screen, type) {
  const def = COMPONENTS[type];
  if (!def) return;
  const { list, parent } = insertTarget(screen);
  if (!list) return;
  const node = { id: nid(screen, type), type, props: {} };
  // Start from the defaults the library declares, so the preview and the app
  // begin in the same place rather than each applying its own fallbacks.
  for (const [key, prop] of Object.entries(def.props || {})) {
    if ('default' in prop) node.props[key] = prop.default;
  }
  if (def.events && def.events.length && !def.a11y?.requiresLabel) {
    node.events = {}; // ready for the action editor, but nothing is chosen yet
  }
  list.push(node);
  D.selected = node.id;
  D.adding = false;
  if (parent) D.selected = node.id;
  return node;
}

function removeComponent(screen, id) {
  const found = locate(screen, id);
  if (!found) return false;
  found.list.splice(found.index, 1);
  D.selected = null;
  return true;
}

function duplicateComponent(screen, id) {
  const found = locate(screen, id);
  if (!found) return false;
  const copy = structuredClone(found.node);
  renameTree(copy, screen);
  found.list.splice(found.index + 1, 0, copy);
  D.selected = copy.id;
  return true;
}

/** Give a copied branch fresh ids, because two components may not share a name. */
function renameTree(node, screen) {
  node.id = nid(screen, node.type);
  for (const child of node.children || []) renameTree(child, screen);
}

function moveComponent(screen, id, delta) {
  const found = locate(screen, id);
  if (!found) return false;
  const next = found.index + delta;
  if (next < 0 || next >= found.list.length) return false;
  const [node] = found.list.splice(found.index, 1);
  found.list.splice(next, 0, node);
  return true;
}

/** Move a component one level out, keeping it directly after its parent. */
function outdentComponent(screen, id) {
  const found = locate(screen, id);
  if (!found || !found.parent) return false;
  const parentFound = locate(screen, found.parent.id);
  if (!parentFound) return false;
  found.list.splice(found.index, 1);
  parentFound.list.splice(parentFound.index + 1, 0, found.node);
  return true;
}

/* ── undo, and moving a component somewhere specific ─────────────────────── */

/**
 * Run a designer edit with the previous state recorded first.
 * Every mutation in this file goes through here, so undo covers all of them
 * rather than the ones someone remembered to wrap.
 */
function editScreen(screen, label, fn) {
  beginEdit(S.active, screen.id, label);
  const out = fn();
  touch();
  hardUpdate();
  return out;
}

/**
 * Move a component to a position in another list — which is what dragging does,
 * and what the arrow buttons cannot express. Refuses the two moves that would
 * corrupt the tree: dropping a container inside itself, and dropping a node
 * exactly where it already is.
 *
 * Returns a string describing why it refused, or null when it moved. The caller
 * shows that string, because a drag that silently does nothing teaches a person
 * that dragging is broken.
 */
function moveNodeTo(screen, id, targetParentId, index) {
  const found = locate(screen, id);
  if (!found) return 'That component is no longer on this screen.';

  // Walk up from the destination. If the node being dragged is on the way, the
  // drop would put a container inside its own descendant and the preview's
  // recursion guard would be the only thing stopping an infinite loop.
  if (targetParentId) {
    let cursor = locate(screen, targetParentId);
    while (cursor) {
      if (cursor.node.id === id) return 'A component cannot be placed inside itself.';
      cursor = cursor.parent ? locate(screen, cursor.parent.id) : null;
    }
  }

  const dest = targetParentId ? locate(screen, targetParentId) : null;
  if (targetParentId && !dest) return 'That destination no longer exists.';
  if (dest && !(COMPONENTS[dest.node.type] || {}).container) {
    return `${(COMPONENTS[dest.node.type] || {}).label || dest.node.type} cannot contain other components.`;
  }

  const list = dest ? dest.node.children : screen.components;
  if (!Array.isArray(list)) return 'That destination cannot hold components.';

  const sameList = list === found.list;
  const at = Math.max(0, Math.min(list.length, Number.isFinite(index) ? index : list.length));
  if (sameList && (at === found.index || at === found.index + 1)) return null; // already there

  found.list.splice(found.index, 1);
  // Removing first shifts the destination index down when moving within one list.
  const insertAt = sameList && at > found.index ? at - 1 : at;
  list.splice(Math.max(0, Math.min(list.length, insertAt)), 0, found.node);
  return null;
}

/* ── the tab ────────────────────────────────────────────────────────────── */

/**
 * The shell expects every section to hand back a list of nodes. Returning the
 * wrapper directly used to throw "page(...).filter is not a function" and left
 * the tab showing the previous section, which is a confusing way to fail.
 */
function viewScreens() {
  return [screenDesignerView()];
}

function screenDesignerView() {
  const spec = S.active.spec;
  const list = screensOf(spec);
  const screen = activeScreen(spec);

  const wrap = el('div', { class: 'designer' }, [screensForTabsNote(spec, list)]);

  // With nothing built yet, the page offers one thing to do. The screen picker
  // would only add a second button for the same action, which on an otherwise
  // empty page reads as two different choices.
  if (!screen) {
    if (list.length) wrap.append(screenPicker(spec, list));
    wrap.append(el('div', { class: 'empty' }, [
      el('button', {
        class: 'btn primary',
        onclick: () => { screensOf(spec).push(starterScreen(spec, 'Home', 0)); touch(); hardUpdate(); },
      }, 'Build the first screen'),
      el('p', { class: 'sub' }, 'This app draws its own screens, so it needs at least one before it can build. Tapping here starts you with a Home screen you can fill in.'),
    ]));
    return wrap;
  }

  wrap.append(screenPicker(spec, list));

  const findings = screenFindings(spec, screen);

  wrap.append(
    el('div', { class: 'd-cell' }, [
      el('div', { class: 'd-head' }, [
        el('span', { class: 'd-title' }, 'Preview'),
        el('span', { class: 'd-note' }, 'Drawn in the browser from the same numbers the app uses. The installed app is what settles it.'),
      ]),
      renderPreview(screen, spec),
    ]),
    el('div', { class: 'd-cell' }, [
      el('div', { class: 'd-head' }, [
        el('span', { class: 'd-title' }, `Contents of ${screen.name}`),
        el('div', { class: 'd-tools' }, [
          /* Undo says what it will undo. On a screen full of components a
             button labelled only "Undo" does not tell you which of the last
             sixty edits you are about to lose. */
          el('button', {
            class: 'btn small',
            id: 'undo-edit',
            disabled: !canUndo(S.active),
            title: nextUndoLabel(S.active) ? `Undo: ${nextUndoLabel(S.active)}` : 'Nothing to undo',
            'aria-label': nextUndoLabel(S.active) ? `Undo ${nextUndoLabel(S.active)}` : 'Nothing to undo',
            onclick: () => {
              const what = undoEdit(S.active);
              touch(); hardUpdate();
              toast(what ? `Undid: ${what}` : 'Nothing to undo.');
            },
          }, 'Undo'),
          el('button', {
            class: 'btn small',
            id: 'redo-edit',
            disabled: !canRedo(S.active),
            'aria-label': canRedo(S.active) ? 'Redo the last undone change' : 'Nothing to redo',
            onclick: () => {
              const what = redoEdit(S.active);
              touch(); hardUpdate();
              toast(what ? `Redid: ${what}` : 'Nothing to redo.');
            },
          }, 'Redo'),
          el('button', {
            class: 'btn small' + (D.adding ? ' primary' : ''),
            onclick: () => { D.adding = !D.adding; hardUpdate(); },
            'aria-expanded': D.adding ? 'true' : 'false',
          }, D.adding ? 'Close' : '+ Add'),
        ]),
      ]),
      D.adding ? palette(screen) : outline(screen),
    ]),
  );

  wrap.append(findingsCell(screen, findings));

  if (D.selected) {
    const found = locate(screen, D.selected);
    if (found) wrap.append(el('div', { class: 'd-cell' }, [
      el('div', { class: 'd-head' }, [
        el('span', { class: 'd-title' }, `Edit ${(COMPONENTS[found.node.type] || {}).label || found.node.type}`),
        el('button', { class: 'btn small', onclick: () => { D.selected = null; hardUpdate(); } }, 'Deselect'),
      ]),
      inspector(screen, found),
    ]));
  }

  return wrap;
}

/** Warn when the navigation setting and the screen list disagree. */
function screensForTabsNote(spec, list) {
  const nav = (spec.navigation || {}).type;
  const tabs = list.filter((s) => s.showInTabs !== false);
  if (nav === 'bottom-tabs' && list.length < 2) {
    return el('p', { class: 'd-alert' }, 'Bottom tabs are selected but there is only one screen, so a tab bar would have nothing in it. Either add a screen or change the navigation in the Design tab.');
  }
  if (nav === 'bottom-tabs' && tabs.length > 5) {
    return el('p', { class: 'd-alert' }, `${tabs.length} screens are marked to appear in the tab bar, which holds five. Only the first five will be shown.`);
  }
  if (nav === 'none' && list.length) {
    return el('p', { class: 'd-alert' }, 'This app has screens but no navigation, so nothing can reach them. Choose a navigation style in the Design tab.');
  }
  return el('span', {});
}

/* ── the screen picker ──────────────────────────────────────────────────── */

function screenPicker(spec, list) {
  const row = el('div', { class: 'screen-chips', role: 'tablist', 'aria-label': 'Screens' });
  for (const s of list) {
    const on = s.id === D.screen;
    row.append(el('button', {
      class: 'chip' + (on ? ' on' : ''),
      role: 'tab',
      'aria-selected': on ? 'true' : 'false',
      onclick: () => { D.screen = s.id; D.selected = null; D.adding = false; hardUpdate(); },
    }, [
      el('span', {}, s.name || s.id),
      el('span', { class: 'chip-n' }, String((s.components || []).length)),
    ]));
  }
  row.append(el('button', {
    class: 'chip add',
    onclick: () => {
      const s = starterScreen(spec, null, list.length);
      screensOf(spec).push(s);
      D.screen = s.id;
      D.selected = null;
      touch();
      hardUpdate();
    },
  }, '+ Screen'));
  return row;
}

/* ── the outline ────────────────────────────────────────────────────────── */

function outline(screen) {
  if (!screen.components || !screen.components.length) {
    return el('div', { class: 'empty' }, [
      el('p', {}, 'This screen is empty.'),
      el('button', { class: 'btn primary', onclick: () => { D.adding = true; hardUpdate(); } }, 'Add the first component'),
    ]);
  }
  const tree = el('ul', { class: 'tree', role: 'tree' });
  const rows = [];
  (function walk(list, depth) {
    for (const node of list) {
      if (!node) continue;
      const def = COMPONENTS[node.type] || {};
      const on = node.id === D.selected;
      /* Dragging is the fast path; the arrow buttons stay, because a drag on a
         touchscreen is not something everyone can do and the buttons are the
         same operation with a label. The drop line is drawn with a class rather
         than an inserted element: a stray node in the tree would be read as a
         component by anything that counts them. */
      const row = el('li', {
        class: 'node' + (on ? ' on' : '') + (D.dragOver === node.id ? ' drop-before' : ''),
        style: `--depth:${depth}`,
        draggable: 'true',
        'data-node': node.id,
        ondragstart: (e) => {
          D.dragging = node.id;
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', node.id); } catch { /* older browsers */ }
          row.classList.add('dragging');
        },
        ondragend: () => {
          D.dragging = null; D.dragOver = null;
          row.classList.remove('dragging');
          $$('.tree .node.drop-before').forEach((n) => n.classList.remove('drop-before'));
        },
        ondragover: (e) => {
          if (!D.dragging || D.dragging === node.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (D.dragOver !== node.id) {
            D.dragOver = node.id;
            $$('.tree .node.drop-before').forEach((n) => n.classList.remove('drop-before'));
            row.classList.add('drop-before');
          }
        },
        ondragleave: () => {
          if (D.dragOver === node.id) { D.dragOver = null; row.classList.remove('drop-before'); }
        },
        ondrop: (e) => {
          e.preventDefault();
          const dragged = D.dragging;
          D.dragging = null; D.dragOver = null;
          if (!dragged || dragged === node.id) return;
          /* The destination is worked out before anything is recorded, then the
             move happens inside editScreen so the previous state is captured
             first. Doing it the other way round would leave an undo step for an
             edit that never happened. */
          const target = found0(screen, node.id);
          if (!target) return;
          const parentId = target.parent ? target.parent.id : null;
          let reason = 'That move was not possible.';
          editScreen(screen, 'Reorder', () => { reason = moveNodeTo(screen, dragged, parentId, target.index); });
          if (reason) toast(reason);
        },
      }, [
        el('button', {
          class: 'node-main',
          role: 'treeitem',
          'aria-selected': on ? 'true' : 'false',
          onclick: () => { D.selected = on ? null : node.id; D.adding = false; hardUpdate(); },
        }, [
          el('span', { class: 'node-name' }, def.label || node.type),
          el('span', { class: 'node-id' }, labelFor(node)),
        ]),
      ]);
      const acts = el('div', { class: 'node-acts' }, [
        iconBtn('↑', 'Move up', () => editScreen(screen, 'Move up', () => moveComponent(screen, node.id, -1))),
        iconBtn('↓', 'Move down', () => editScreen(screen, 'Move down', () => moveComponent(screen, node.id, 1))),
        def.container && depth > 0 ? iconBtn('←', 'Move out one level', () => editScreen(screen, 'Move out one level', () => outdentComponent(screen, node.id))) : null,
        iconBtn('⧉', 'Duplicate', () => editScreen(screen, `Duplicate ${def.label || node.type}`, () => duplicateComponent(screen, node.id))),
        iconBtn('✕', 'Delete', () => editScreen(screen, `Delete ${def.label || node.type}`, () => removeComponent(screen, node.id))),
      ]);
      row.append(acts);
      rows.push(row);
      if (node.children && node.children.length) walk(node.children, depth + 1);
    }
  })(screen.components, 0);
  tree.append(...rows);
  return tree;
}

/** The short line of text that identifies a component in a list. */
function labelFor(node) {
  const props = node.props || {};
  for (const key of ['text', 'label', 'title', 'message', 'fallback', 'placeholder']) {
    if (props[key]) return String(props[key]).slice(0, 34);
  }
  if (props.items) return `${String(props.items).split('\n').length} items`;
  return node.id || node.type;
}

function iconBtn(glyph, label, onclick) {
  return el('button', { class: 'ibtn', 'aria-label': label, title: label, onclick }, glyph);
}

/* ── the palette ────────────────────────────────────────────────────────── */

function palette(screen) {
  const groups = GROUPS;
  const open = D.group || groups[0];
  const wrap = el('div', { class: 'palette' }, [
    el('div', { class: 'palette-groups', role: 'tablist', 'aria-label': 'Component groups' },
      groups.map((g) => el('button', {
        class: 'chip' + (g === open ? ' on' : ''),
        role: 'tab',
        'aria-selected': g === open ? 'true' : 'false',
        onclick: () => { D.group = g; hardUpdate(); },
      }, g))),
  ]);
  const items = componentList().filter((c) => c.group === open);
  const grid = el('div', { class: 'palette-grid' });
  for (const c of items) {
    grid.append(el('button', {
      class: 'pitem',
      onclick: () => {
        editScreen(screen, `Add ${c.label}`, () => addComponent(screen, c.name));
        toast(`${c.label} added.`);
      },
    }, [
      el('span', { class: 'pitem-name' }, c.label),
      el('span', { class: 'pitem-sub' }, c.container ? 'holds children' : (c.requiresLabel ? 'needs a label' : c.role)),
    ]));
  }
  const target = insertTarget(screen);
  const targetName = target.parent
    ? ((COMPONENTS[(locate(screen, target.parent) || {}).node?.type] || {}).label || target.parent)
    : 'the screen';
  wrap.append(el('p', { class: 'sub' }, `New components are added inside ${targetName}.`));
  wrap.append(grid);
  return wrap;
}

/* ── the inspector ──────────────────────────────────────────────────────── */

function inspector(screen, found) {
  const node = found.node;
  const def = COMPONENTS[node.type] || {};
  const box = el('div', { class: 'inspector' });

  const nameError = el('p', { class: 'sub err', id: 'node-name-err', hidden: true },
    'Another component in this screen already has that name.');
  box.append(el('div', { class: 'field' }, [
    el('label', { for: 'node-name' }, 'Name for reports'),
    el('input', {
      id: 'node-name', type: 'text', value: node.id || '', autocomplete: 'off',
      oninput: (e) => {
        const v = e.target.value.replace(/[^A-Za-z0-9_-]/g, '');
        const other = v ? locate(screen, v) : null;
        const clash = Boolean(other && other.node !== node);
        e.target.setAttribute('aria-invalid', clash ? 'true' : 'false');
        nameError.hidden = !clash;
        // Two components with one name would make the second take over the
        // first one's behaviour in the app, so the change is refused here with
        // the reason shown. Silently ignoring the keystroke would be worse.
        if (clash) return;
        node.id = v;
        touch();
        redrawPreview();
        refreshFindings();
      },
    }),
    nameError,
    el('p', { class: 'sub' }, 'Used in reports and in the action editor. Letters, numbers, dashes.'),
  ]));

  // properties, generated from the library
  for (const [key, prop] of Object.entries(def.props || {})) {
    if (key === 'visible') continue;
    box.append(propField(screen, node, key, prop));
  }

  // events and their actions
  for (const ev of def.events || []) {
    box.append(eventEditor(screen, node, ev));
  }

  if (def.a11y?.requiresLabel && !(node.a11yLabel || node.props?.a11yLabel)) {
    box.append(el('p', { class: 'd-alert' }, 'This component must carry a screen-reader label before the app will build. Add one above.'));
  }

  box.append(el('div', { class: 'field' }, [
    el('label', { for: 'node-visible' }, 'Visible'),
    el('button', {
      id: 'node-visible', class: 'toggle' + (node.props?.visible !== false ? ' on' : ''),
      'aria-pressed': node.props?.visible !== false ? 'true' : 'false',
      onclick: (e) => {
        node.props = node.props || {};
        node.props.visible = node.props.visible === false;
        touch();
        hardUpdate();
      },
    }, node.props?.visible !== false ? 'Shown' : 'Hidden'),
  ]));

  return box;
}

/** One property control, chosen from the type the library declares. */
function propField(screen, node, key, prop) {
  const value = node.props?.[key] ?? (key === 'a11yLabel' ? node.a11yLabel : undefined);
  const id = `prop-${key}`;
  const set = (v, rerender) => {
    node.props = node.props || {};
    if (v === '' || v === undefined) delete node.props[key];
    else node.props[key] = v;
    touch();
    if (rerender) hardUpdate(); else { redrawPreview(); refreshFindings(); }
  };

  const label = el('label', { for: id }, prop.label || key);
  if (prop.help) label.append(el('span', { class: 'help', title: prop.help }, ' ?'));

  let control;
  switch (prop.type) {
    case 'choice':
      control = kvSelect(String(value ?? prop.default ?? ''), (prop.options || []).map((o) => (Array.isArray(o) ? o : [o, o])), (v) => set(v, false), prop.label || key);
      break;
    case 'boolean':
      control = el('button', {
        id, class: 'toggle' + ((value ?? prop.default) ? ' on' : ''),
        'aria-pressed': (value ?? prop.default) ? 'true' : 'false',
        onclick: () => set(!(value ?? prop.default), true),
      }, (value ?? prop.default) ? 'On' : 'Off');
      break;
    case 'number':
      control = el('input', {
        id, type: 'number', inputmode: 'numeric', value: value ?? prop.default ?? '',
        min: prop.min ?? undefined, max: prop.max ?? undefined,
        oninput: (e) => set(e.target.value === '' ? '' : Number(e.target.value), false),
      });
      break;
    case 'color':
      control = colourInput(id, String(value ?? prop.default ?? ''), (v) => set(v, true));
      break;
    case 'icon':
      control = iconSelect(id, String(value ?? prop.default ?? ''), (v) => set(v, true));
      break;
    case 'list':
      control = el('textarea', {
        id, rows: 4, value: value ?? '',
        oninput: (e) => set(e.target.value, false),
      });
      break;
    default:
      control = el('input', {
        id, type: 'text', value: value ?? prop.default ?? '', placeholder: prop.placeholder || '',
        autocomplete: 'off',
        oninput: (e) => set(e.target.value, false),
      });
  }

  const field = el('div', { class: 'field' }, [label, control]);
  if (prop.required) field.append(el('p', { class: 'sub' }, 'Required. The app will not build without it.'));
  else if (prop.help) field.append(el('p', { class: 'sub' }, prop.help));
  return field;
}

function colourInput(id, value, onchange) {
  const row = el('div', { class: 'colour-row' });
  const swatch = el('input', {
    id, type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#2563EB', onchange: (e) => onchange(e.target.value),
  });
  const text = el('input', {
    type: 'text', value, placeholder: 'Theme default', 'aria-label': id + ' as text', autocomplete: 'off',
    oninput: (e) => onchange(e.target.value),
  });
  row.append(swatch, text);
  return row;
}

function iconSelect(id, value, onchange) {
  const pairs = [['', 'No icon'], ...ICON_NAMES.map((n) => [n, `${iconGlyph(n)}  ${n}`])];
  return kvSelect(value, pairs, onchange, id);
}

/* ── events and actions ─────────────────────────────────────────────────── */

function eventEditor(screen, node, ev) {
  const nodeDef = COMPONENTS[node.type] || {};
  const current = (node.events || {})[ev] || { kind: 'none', props: {} };
  const evLabel = (EVENTS[ev] || {}).label || ev;
  const box = el('div', { class: 'field event' }, [el('label', {}, `When: ${evLabel}`)]);

  const choices = [['none', 'Do nothing'], ...(nodeDef.actions || []).map((a) => [a, ACTIONS[a].label || a])];
  box.append(kvSelect(current.kind || 'none', choices, (kind) => {
    node.events = node.events || {};
    node.events[ev] = kind === 'none' ? { kind: 'none', props: {} } : { kind, props: {} };
    touch();
    hardUpdate();
  }, `${ev} action`));

  if (current.kind && current.kind !== 'none' && ACTIONS[current.kind]) {
    const action = ACTIONS[current.kind];
    for (const [key, prop] of Object.entries(action.props || {})) {
      const id = `act-${ev}-${key}`;
      let control;
      const set = (v) => {
        node.events[ev].props = node.events[ev].props || {};
        if (v === '') delete node.events[ev].props[key]; else node.events[ev].props[key] = v;
        touch();
        redrawPreview();
      };
      if (prop.type === 'choice') control = kvSelect(String(current.props?.[key] ?? ''), (prop.options || []).map((o) => (Array.isArray(o) ? o : [o, o])), set, prop.label || key);
      else control = el('input', { id, type: 'text', value: current.props?.[key] ?? '', placeholder: prop.placeholder || '', autocomplete: 'off', oninput: (e) => set(e.target.value) });
      box.append(el('div', { class: 'sub-field' }, [
        el('label', { for: id }, prop.label || key + (prop.required ? ' (required)' : '')),
        control,
      ]));
    }
    if (action.needsCapability) {
      const has = (screen.__capabilities || []);
      void has;
    }
  }
  return box;
}

/* ── findings for this screen ───────────────────────────────────────────── */

/**
 * The list of things that need attention.
 *
 * It carries an id so it can be replaced on its own: while a property is being
 * typed the whole page must not be redrawn, because that would take the cursor
 * out of the field — but the findings must still change the moment the problem
 * is fixed. Leaving a solved error on screen teaches people to ignore errors.
 */
function findingsCell(screen, findings) {
  const cell = el('div', { class: 'd-cell', id: 'designer-findings' }, [
    el('div', { class: 'd-head' }, [
      el('span', { class: 'd-title' }, findings.length
        ? `What needs attention (${findings.length})`
        : 'Nothing needs attention here'),
    ]),
  ]);
  if (findings.length) cell.append(el('div', { class: 'findings' }, findings.slice(0, 12).map(findingRow(screen))));
  else cell.append(el('p', { class: 'sub' }, 'No problems found in this screen.'));
  return cell;
}

function refreshFindings() {
  const cell = document.getElementById('designer-findings');
  if (!cell) return;
  const spec = S.active.spec;
  const screen = activeScreen(spec);
  if (!screen) return;
  const findings = screenFindings(spec, screen);
  const fresh = findingsCell(screen, findings);
  cell.replaceWith(fresh);
}

function screenFindings(spec, screen) {
  const out = [];
  validateScreens(spec, out);
  const prefix = `screens[${screensOf(spec).indexOf(screen)}].components`;
  return out.filter((f) => String(f.path || '').startsWith(prefix));
}

function findingRow(screen) {
  return (f) => {
    const row = el('div', { class: 'finding ' + (f.severity === 'error' ? 'err' : 'warn') }, [
      el('p', { class: 'finding-msg' }, f.message),
      el('p', { class: 'sub' }, f.path),
    ]);
    const actions = el('div', { class: 'finding-acts' });
    if (f.fix && f.fix.value !== undefined) {
      actions.append(el('button', {
        class: 'btn small', onclick: () => {
          // The fix says exactly which property to set. Applying it is a single
          // assignment, so it cannot surprise anyone.
          const node = locateById(screen, (f.reveal || {}).nodeId);
          if (!node) return;
          const parts = String(f.fix.path).split('.');
          if (parts[parts.length - 1] === 'type') node.type = f.fix.value;
          else {
            node.props = node.props || {};
            const key = parts[parts.length - 1] === 'a11yLabel' ? 'a11yLabel' : parts[parts.length - 1];
            node.props[key] = f.fix.value;
          }
          touch(); hardUpdate();
        },
      }, f.fix.label || 'Apply the fix'));
    }
    if (f.reveal && f.reveal.nodeId) {
      actions.append(el('button', {
        class: 'btn small', onclick: () => { D.selected = f.reveal.nodeId; hardUpdate(); },
      }, 'Show me'));
    }
    if (actions.childNodes.length) row.append(actions);
    return row;
  };
}

function locateById(screen, id) {
  if (!id) return null;
  const found = locate(screen, id);
  return found ? found.node : null;
}

/* ── the preview ────────────────────────────────────────────────────────── */
/*
 * A drawing of the screen, built from the same component descriptions and the
 * same scale numbers as the Android renderer. Kept deliberately close to the
 * Android layout rules: a column of blocks, the same spacing scale, the same
 * text sizes, the same corner radii. Where the two can differ — fonts, exact
 * metrics — the preview does not pretend otherwise.
 */

function renderPreview(screen, spec) {
  const th = spec.theme || {};
  const dark = (spec.android || {}).theme === 'dark' || luminance(th.background || '#FFFFFF') < 0.5;
  const host = el('div', { class: 'device' + (dark ? ' dark' : '') });
  const frame = el('div', { class: 'device-screen', id: 'preview-root', style: `background:${th.background || '#FFFFFF'};color:${th.onSurface || '#111827'}` });

  // status bar, matching what the app actually reserves
  frame.append(el('div', { class: 'sbar', style: `color:${th.onSurface || '#111827'}` }, [
    el('span', {}, '9:41'),
    el('span', { class: 'icons' }, [el('i', { class: 'sig' }), el('i', { class: 'batt' })]),
  ]));

  const body = el('div', { class: 'pv-body' });
  if (!screen.components || !screen.components.length) {
    body.append(el('p', { class: 'pv-empty' }, 'This screen is empty.'));
  } else {
    for (const node of screen.components) body.append(previewNode(node, spec, 0));
  }
  frame.append(body);

  // the navigation the app will show, drawn so it is not a surprise
  const nav = (spec.navigation || {}).type;
  if (nav === 'bottom-tabs') {
    const tabs = screensOf(spec).filter((s) => s.showInTabs !== false).slice(0, 5);
    const bar = el('div', { class: 'pv-nav', style: `background:${th.surface || '#F9FAFB'};color:${th.onSurface || '#111827'}` });
    for (const t of tabs) {
      bar.append(el('span', { class: 'pv-nav-item' + (t.id === screen.id ? ' on' : '') }, t.name || t.id));
    }
    frame.append(bar);
  }
  host.append(frame);
  host.append(el('p', { class: 'pv-caption' }, `Preview of “${screen.name}” as the app will draw it. This is a browser drawing: check the real screen on your phone before you rely on it.`));
  return host;
}

/** Remove and re-add just the device body, so typing does not lose focus. */
function redrawPreview() {
  const root = $('#preview-root');
  if (!root) return;
  const spec = S.active.spec;
  const screen = activeScreen(spec);
  if (!screen) return;
  const body = $('.pv-body', root) || root;
  body.textContent = '';
  if (!screen.components || !screen.components.length) {
    body.append(el('p', { class: 'pv-empty' }, 'This screen is empty.'));
    return;
  }
  for (const node of screen.components) body.append(previewNode(node, spec, 0));
}

const SP = SPACINGS;
const TS = TEXT_SIZES;
const RD = RADII;
const HT = HEIGHTS;

function px(n) { return `${n}px`; }

function previewNode(node, spec, depth) {
  if (!node || depth > MAX_PREVIEW_DEPTH) return el('span', {});
  const th = spec.theme || {};
  const p = node.props || {};
  if (p.visible === false) return el('span', {}, '');
  const label = node.a11yLabel || p.a11yLabel;
  const wrap = el('div', { class: 'pv-node', 'data-type': node.type, 'data-id': node.id });
  if (label) wrap.setAttribute('aria-label', label);
  const pad = p.padding && p.padding !== 'none' ? px(SP[p.padding] || 0) : '';
  const mar = p.margin && p.margin !== 'none' ? px(SP[p.margin] || 0) : '';
  if (mar) wrap.style.margin = `${mar} 0`;
  const kids = () => (node.children || []).map((c) => previewNode(c, spec, depth + 1));

  switch (node.type) {
    case 'Screen':
      break;
    case 'Container': {
      wrap.style.display = 'flex';
      wrap.style.flexDirection = p.direction === 'row' ? 'row' : 'column';
      wrap.style.gap = px(SP[p.gap] ?? SP.md);
      if (pad) wrap.style.padding = pad;
      if (p.backgroundColor) wrap.style.background = p.backgroundColor;
      wrap.append(...kids());
      break;
    }
    case 'Card': {
      wrap.style.background = th.surface || '#F9FAFB';
      wrap.style.borderRadius = px(RD[p.radius] ?? RD.lg);
      wrap.style.padding = pad || px(SP.md);
      if (p.elevated !== false) wrap.style.boxShadow = '0 2px 10px rgba(0,0,0,.12)';
      wrap.append(...kids());
      break;
    }
    case 'Divider':
      wrap.style.height = p.thickness === 'thick' ? '3px' : '1px';
      wrap.style.background = withAlpha(th.onSurface || '#111827', 0.25);
      break;
    case 'Spacer':
      wrap.style.height = px(HT[p.height] ?? 0) && px(SP[p.height] ?? SP.md);
      break;
    case 'Text':
      wrap.textContent = p.text ?? '';
      wrap.style.fontSize = px(TS[p.size] ?? TS.md);
      wrap.style.color = p.color || th.onSurface || '#111827';
      wrap.style.fontWeight = p.weight ? '600' : '400';
      wrap.style.textAlign = p.align || 'left';
      break;
    case 'Heading': {
      wrap.textContent = p.text ?? '';
      const size = p.size === '2xl' ? 26 : p.size === 'xl' ? 23 : TS.lg;
      wrap.style.fontSize = px(size);
      wrap.style.fontWeight = '700';
      wrap.style.color = p.color || th.onSurface || '#111827';
      wrap.style.textAlign = p.align || 'left';
      break;
    }
    case 'Badge': {
      wrap.textContent = p.text ?? '';
      const tones = { neutral: ['#E5E7EB', '#111827'], info: ['#DBEAFE', '#1E3A8A'], success: ['#DCFCE7', '#14532D'], warning: ['#FEF3C7', '#78350F'], danger: ['#FEE2E2', '#7F1D1D'] };
      const [bg, fg] = tones[p.tone] || tones.neutral;
      wrap.style.cssText += `background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:999px;display:inline-block;`;
      break;
    }
    case 'Chip':
      wrap.textContent = p.text ?? '';
      wrap.style.cssText += `display:inline-block;padding:6px 12px;border-radius:999px;font-size:13px;border:1px solid ${p.selected ? (th.primary || '#2563EB') : withAlpha(th.onSurface || '#111827', .3)};background:${p.selected ? withAlpha(th.primary || '#2563EB', .14) : 'transparent'};`;
      break;
    case 'Image': {
      wrap.style.height = px(HT[p.height] ?? HT.md);
      wrap.style.borderRadius = px(RD.md);
      if (p.source && /^https?:/.test(p.source)) {
        // The preview iframe has no network, so the frame is drawn rather than
        // fetched, and says which address it stands for.
        wrap.style.cssText += `background:repeating-linear-gradient(45deg,${withAlpha(th.onSurface || '#111827', .06)} 0 10px,transparent 10px 20px);border:1px dashed ${withAlpha(th.onSurface || '#111827', .3)};display:flex;align-items:center;justify-content:center;font-size:11px;color:${withAlpha(th.onSurface || '#111827', .7)};`;
        wrap.textContent = 'image';
      } else {
        wrap.style.background = withAlpha(th.primary || '#2563EB', .18);
      }
      break;
    }
    case 'Avatar':
      wrap.textContent = p.fallback || p.source ? (p.fallback || '\u25CF') : '\u25CF';
      wrap.style.cssText += `width:${p.size === 'lg' ? 72 : p.size === 'sm' ? 36 : 52}px;height:${p.size === 'lg' ? 72 : p.size === 'sm' ? 36 : 52}px;border-radius:999px;background:${withAlpha(th.primary || '#2563EB', .22)};display:inline-flex;align-items:center;justify-content:center;font-weight:700;`;
      break;
    case 'Progress': {
      const pct = Math.max(0, Math.min(100, Number(p.value) || 0));
      const track = el('div', { class: 'pv-track', style: `background:${withAlpha(th.onSurface || '#111827', .18)}` });
      track.append(el('div', { class: 'pv-fill', style: `width:${pct}%;background:${th.primary || '#2563EB'}` }));
      wrap.append(track);
      if (p.showLabel) wrap.append(el('p', { class: 'pv-cap' }, `${pct}%`));
      break;
    }
    case 'Loading': {
      wrap.append(el('div', { class: 'pv-spin' }));
      if (p.label) wrap.append(el('p', { class: 'pv-cap' }, p.label));
      break;
    }
    case 'Button': {
      const style = p.style === 'ghost' ? 'ghost' : p.style === 'danger' ? 'danger' : 'primary';
      wrap.append(el('button', {
        class: 'pv-btn ' + style + (p.fullWidth ? ' full' : ''),
        disabled: p.disabled ? true : undefined,
        onclick: (e) => { e.preventDefault(); showActionToast(node, 'onClick'); },
      }, `${p.icon ? iconGlyph(p.icon) + ' ' : ''}${p.text || 'Button'}`));
      break;
    }
    case 'IconButton':
      wrap.append(el('button', { class: 'pv-btn primary round', 'aria-label': label || p.icon || 'button', onclick: (e) => { e.preventDefault(); showActionToast(node, 'onClick'); } }, iconGlyph(p.icon)));
      break;
    case 'Input':
    case 'PasswordInput':
    case 'Search': {
      const type = node.type === 'PasswordInput' ? 'password' : node.type === 'Search' ? 'search' : (p.inputType === 'email' ? 'email' : p.inputType === 'phone' ? 'tel' : p.inputType === 'number' ? 'number' : 'text');
      const id = `pv-${screen_safe(node.id)}`;
      if (p.label) wrap.append(el('label', { for: id, class: 'pv-label' }, p.label + (p.required ? ' *' : '')));
      const input = p.inputType === 'multiline'
        ? el('textarea', { id, class: 'pv-input', rows: 3, placeholder: p.placeholder || '' })
        : el('input', { id, class: 'pv-input', type, placeholder: p.placeholder || '' });
      wrap.append(input);
      if (p.helper) wrap.append(el('p', { class: 'sub' }, p.helper));
      break;
    }
    case 'Dropdown': {
      if (p.label) wrap.append(el('label', { class: 'pv-label' }, p.label));
      const opts = String(p.options || '').split('\n').filter(Boolean);
      const sel = el('select', { class: 'pv-input' });
      for (const o of opts) sel.append(el('option', {}, o));
      wrap.append(sel);
      break;
    }
    case 'Checkbox':
      wrap.append(el('label', { class: 'pv-check' }, [el('input', { type: 'checkbox', checked: p.checked ? true : undefined }), el('span', {}, p.text || 'Option')]));
      break;
    case 'Switch':
      wrap.append(el('div', { class: 'pv-switch-row' }, [
        el('div', {}, [el('p', {}, p.text || 'Option'), p.subtitle ? el('p', { class: 'sub' }, p.subtitle) : null]),
        el('span', { class: 'pv-switch' + (p.checked ? ' on' : '') }),
      ]));
      break;
    case 'Slider': {
      if (p.label) wrap.append(el('label', { class: 'pv-label' }, p.label));
      const range = el('input', { type: 'range', min: p.min ?? 0, max: p.max ?? 100, value: p.value ?? 50, class: 'pv-range' });
      wrap.append(range);
      break;
    }
    case 'Form': {
      if (pad && p.padding !== 'none') wrap.style.padding = pad;
      wrap.append(...kids());
      wrap.append(el('button', { class: 'pv-btn primary full', onclick: (e) => { e.preventDefault(); showActionToast(node, 'onSubmit'); } }, p.submitLabel || 'Submit'));
      break;
    }
    case 'List': {
      const items = String(p.items || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const box = el('div', { class: 'pv-list', style: `border:1px solid ${withAlpha(th.onSurface || '#111827', .16)};border-radius:${px(RD.md)};overflow:hidden;` });
      items.slice(0, 60).forEach((raw, i) => {
        const [title, sub] = raw.split('|').map((s) => (s || '').trim());
        const row = el('div', { class: 'pv-list-row', onclick: () => showActionToast(node, 'onClick') }, [
          el('p', {}, title || raw),
          sub ? el('p', { class: 'sub' }, sub) : null,
        ]);
        if (i > 0 && p.dividers !== false) row.style.borderTop = `1px solid ${withAlpha(th.onSurface || '#111827', .12)}`;
        box.append(row);
      });
      if (!items.length) box.append(el('p', { class: 'pv-empty' }, 'No items yet. Add one per line.'));
      wrap.append(box);
      break;
    }
    case 'Grid': {
      const items = String(p.items || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const cols = Math.max(1, Math.min(4, Number(p.columns) || 2));
      const grid = el('div', { style: `display:grid;grid-template-columns:repeat(${cols},1fr);gap:${px(SP.sm)};` });
      for (const raw of items.slice(0, 24)) {
        grid.append(el('div', { class: 'pv-cell', onclick: () => showActionToast(node, 'onClick') }, raw));
      }
      if (!items.length) grid.append(el('p', { class: 'pv-empty' }, 'No cells yet.'));
      wrap.append(grid);
      break;
    }
    case 'Tabs': {
      const tabs = String(p.tabs || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const row = el('div', { class: 'pv-tabs' });
      tabs.forEach((t, i) => row.append(el('span', { class: 'pv-tab' + (i === 0 ? ' on' : '') }, t)));
      wrap.append(row);
      break;
    }
    case 'AppBar':
      wrap.append(el('div', { class: 'pv-appbar', style: `background:${th.primary || '#2563EB'};color:${th.onPrimary || '#fff'}` }, [
        p.showMenu ? el('span', {}, iconGlyph('menu')) : null,
        el('span', { class: 'pv-appbar-title' }, p.title || (activeScreen(spec) || {}).name || ''),
        p.actionIcon ? el('span', {}, iconGlyph(p.actionIcon)) : null,
      ]));
      break;
    case 'BottomNavigation': {
      const items = String(p.items || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bar = el('div', { class: 'pv-nav', style: `background:${th.surface || '#F9FAFB'}` });
      for (const it of items) bar.append(el('span', { class: 'pv-nav-item' }, it));
      if (!items.length) bar.append(el('span', { class: 'pv-nav-item' }, 'Set items'));
      wrap.append(bar);
      break;
    }
    case 'Drawer':
      wrap.append(el('div', { class: 'pv-drawer' }, [
        el('p', { class: 'pv-drawer-t' }, p.title || 'Menu'),
        p.subtitle ? el('p', { class: 'sub' }, p.subtitle) : null,
      ]));
      break;
    case 'Dialog':
      wrap.append(el('div', { class: 'pv-dialog' }, [
        el('p', { class: 'pv-dialog-t' }, p.title || 'Notice'),
        el('p', { class: 'sub' }, p.message || ''),
        el('div', { class: 'pv-dialog-acts' }, [
          el('span', { class: 'pv-btn ghost' }, p.cancelLabel || 'Cancel'),
          el('span', { class: 'pv-btn primary' }, p.confirmLabel || 'OK'),
        ]),
      ]));
      break;
    case 'BottomSheet':
      wrap.append(el('div', { class: 'pv-sheet' }, [
        el('span', { class: 'pv-grab' }),
        el('p', {}, p.title || 'Sheet'),
      ]));
      break;
    case 'FloatingButton':
      wrap.append(el('button', {
        class: 'pv-fab', 'aria-label': label || p.label || 'Action',
        onclick: (e) => { e.preventDefault(); showActionToast(node, 'onClick'); },
      }, p.label ? `${iconGlyph(p.icon)} ${p.label}` : iconGlyph(p.icon)));
      break;
    default:
      wrap.append(...kids());
  }
  return wrap;
}

const screen_safe = (s) => String(s || 'x').replace(/[^A-Za-z0-9_-]/g, '');

/**
 * What a tap would do, said out loud in the preview.
 * A designed screen only proves itself when its actions are exercised, so the
 * preview reports what the real app would do rather than staying silent.
 */
function showActionToast(node, eventName) {
  const action = (node.events || {})[eventName];
  if (!action || !action.kind || action.kind === 'none') {
    toast(`${(COMPONENTS[node.type] || {}).label || node.type}: nothing is set to happen yet.`);
    return;
  }
  const a = ACTIONS[action.kind] || {};
  const props = action.props || {};
  const detail = Object.entries(props).filter(([, v]) => v).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(' · ');
  toast(`${a.label || action.kind}${detail ? ' — ' + detail : ''}`, 3400);
}

/** Mix a colour towards transparent, for borders and hairlines. */
function withAlpha(hex, alpha) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex));
  if (!m) return `rgba(17,24,39,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/* ── keeping the preview honest about the app ───────────────────────────── */

/**
 * A short, verifiable statement about what is in the app right now.
 * Used by the Preview tab and by the test suite, so the claim "the preview
 * matches the app" is something that can be checked rather than asserted.
 */
function screenSummary(spec) {
  const list = screensOf(spec);
  let nodes = 0;
  let actions = 0;
  (function walk(l) {
    for (const n of l || []) {
      if (!n) continue;
      nodes++;
      actions += Object.values(n.events || {}).filter((a) => a && a.kind && a.kind !== 'none').length;
      walk(n.children);
    }
  })(list.flatMap((s) => s.components || []));
  return { screens: list.length, components: nodes, actions, mode: (spec.app || {}).mode || 'webview' };
}
