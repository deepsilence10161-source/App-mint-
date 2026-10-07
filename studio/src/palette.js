/* ============================================================================
   COMMAND PALETTE — every action in one place, reachable by typing
   ----------------------------------------------------------------------------
   The Studio is organised into five sections, which is the right shape for
   browsing and the wrong shape for acting. To rename the app you have to
   remember that identity lives under Design; to see why a build is blocked you
   have to remember that findings live under Build. On a phone that is a lot of
   tapping to reach something you already know the name of.

   So there is one list of everything the Studio can do, and typing into it
   filters that list. It is the same actions the buttons run — it calls the same
   functions rather than reimplementing them, which is the only reason it can be
   added without creating a second place where behaviour is defined.

   It is keyboard-first (Ctrl+K or Cmd+K) and also a button in the top bar,
   because the primary way anyone holds this tool is a phone, where there is no
   Ctrl key. An affordance that only exists for a keyboard is an affordance most
   of the people using this will never find.
   ========================================================================= */

const PAL = {
  open: false,
  query: '',
  cursor: 0,
  items: [],
};

/**
 * Subsequence match, not substring: "pkg" finds "Package name". That is the
 * behaviour people expect from a command palette, and it is four lines.
 * Returns a score where lower is better, or null when the query does not match,
 * so results can be ordered by how tightly they match rather than listed in
 * whatever order they were collected in.
 */
function fuzzyScore(query, text) {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return -100;          // prefix beats everything
  const at = t.indexOf(q);
  if (at >= 0) return at;                    // then a plain substring, by position
  let ti = 0;
  let spread = 0;
  for (const ch of q) {
    const hit = t.indexOf(ch, ti);
    if (hit < 0) return null;                // a character is missing: no match
    spread += hit - ti;
    ti = hit + 1;
  }
  return 1000 + spread;                      // subsequence, penalised by how scattered
}

/**
 * Everything the palette can run. Built fresh on each open so it reflects the
 * project that is actually loaded: with no project there is nothing to build,
 * and listing "Start build" anyway would be offering something that cannot work.
 */
function paletteActions() {
  const acts = [];
  const go = (tab) => () => { S.tab = tab; PAL.open = false; hardUpdate(); };

  // Read from the same list the tab bar is built from. Carrying a second copy of
  // these ids is how this palette came to offer a command that did not work.
  for (const [id, label, , hint] of TAB_DEFS) {
    acts.push({ label: `Go to ${label}`, hint, run: go(id) });
  }

  const hasProject = Boolean(S.active);

  if (hasProject) {
    for (const s of (S.active.spec.screens || [])) {
      acts.push({
        label: `Open screen: ${s.name || s.id}`,
        hint: 'screen designer',
        run: () => { D.screen = s.id; D.selected = null; D.adding = false; S.tab = 'screens'; PAL.open = false; hardUpdate(); },
      });
    }

    const checks = check();
    acts.push({
      label: 'Validate the specification',
      hint: checks.blocked
        ? `${checks.blocking.length} problem(s) blocking the build`
        : 'no blocking problems',
      run: () => { S.tab = 'build'; PAL.open = false; hardUpdate(); },
    });

    if (!checks.blocked) {
      acts.push({ label: 'Start a build', hint: 'commits the spec and runs CI', run: () => { PAL.open = false; startBuild(); } });
    }

    if (canUndo(S.active)) {
      acts.push({ label: `Undo: ${nextUndoLabel(S.active)}`, hint: 'screen designer', run: () => { PAL.open = false; undoDesignerEdit(); } });
    }
    if (canRedo(S.active)) {
      acts.push({ label: 'Redo', hint: 'screen designer', run: () => { PAL.open = false; redoDesignerEdit(); } });
    }

    acts.push({ label: 'Download the specification', hint: 'spec.json', run: () => { PAL.open = false; downloadSpec(); } });
    acts.push({ label: 'Copy the specification', hint: 'to the clipboard', run: () => { PAL.open = false; copySpec(); } });
  }

  acts.push({ label: 'Home', hint: 'the four ways to start, and your projects', run: () => { PAL.open = false; renderPicker(); } });
  acts.push({ label: 'Browse templates', hint: 'the gallery, with categories', run: () => { PAL.open = false; renderGallery(); } });
  acts.push({ label: 'Import a specification', hint: 'from a spec.json file', run: () => { PAL.open = false; importSpec(); } });

  const themeNow = document.documentElement.getAttribute('data-theme');
  acts.push({
    label: themeNow === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
    hint: 'the choice is remembered',
    run: () => { PAL.open = false; cycleTheme(); },
  });

  return acts;
}

/** Filter and rank. An empty query lists everything, which is the useful case. */
function paletteResults() {
  const all = paletteActions();
  if (!PAL.query.trim()) return all;
  return all
    .map((a) => ({ a, score: Math.min(
      fuzzyScore(PAL.query, a.label) ?? Infinity,
      fuzzyScore(PAL.query, a.hint || '') ?? Infinity,
    ) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((x, y) => x.score - y.score)
    .map((x) => x.a);
}

/** Undo/redo from the palette, so it can say what happened like the buttons do. */
function undoDesignerEdit() {
  const what = undoEdit(S.active);
  touch(); hardUpdate();
  toast(what ? `Undid: ${what}` : 'Nothing to undo.');
}

function redoDesignerEdit() {
  const what = redoEdit(S.active);
  touch(); hardUpdate();
  toast(what ? `Redid: ${what}` : 'Nothing to redo.');
}

function openPalette() {
  PAL.open = true;
  PAL.query = '';
  PAL.cursor = 0;
  PAL.items = paletteResults();
  paintPalette();
  const input = document.getElementById('pal-input');
  if (input) input.focus();
}

function closePalette() {
  PAL.open = false;
  const host = document.getElementById('palette');
  if (host) host.replaceChildren();
}

function togglePalette() {
  if (PAL.open) closePalette(); else openPalette();
}

function paintPalette() {
  const host = document.getElementById('palette');
  if (!host) return;
  host.replaceChildren();
  if (!PAL.open) return;

  PAL.items = paletteResults();
  if (PAL.cursor >= PAL.items.length) PAL.cursor = Math.max(0, PAL.items.length - 1);

  const list = el('div', { class: 'pal-list', role: 'listbox', 'aria-label': 'Commands' });
  if (!PAL.items.length) {
    list.append(el('div', { class: 'pal-none' }, [
      el('p', {}, `Nothing matches “${PAL.query}”.`),
      el('p', { class: 'sub' }, 'Try the name of a section, a screen, or something you want to do.'),
    ]));
  } else {
    PAL.items.forEach((a, i) => {
      list.append(el('button', {
        class: 'pal-item' + (i === PAL.cursor ? ' on' : ''),
        role: 'option',
        'aria-selected': i === PAL.cursor ? 'true' : 'false',
        onmousemove: () => { if (PAL.cursor !== i) { PAL.cursor = i; paintPalette(); } },
        onclick: () => { const run = a.run; closePalette(); run(); },
      }, [
        el('span', { class: 'pal-label' }, a.label),
        a.hint ? el('span', { class: 'pal-hint' }, a.hint) : null,
      ]));
    });
  }

  host.append(el('div', { class: 'pal-back', onclick: closePalette }),
    el('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, [
      el('input', {
        id: 'pal-input',
        class: 'pal-input',
        type: 'text',
        value: PAL.query,
        placeholder: 'Type a command, a screen, or a section…',
        'aria-label': 'Search commands',
        autocomplete: 'off',
        spellcheck: 'false',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'pal-list',
        oninput: (e) => { PAL.query = e.target.value; PAL.cursor = 0; paintPalette(); refocus(); },
        onkeydown: (e) => {
          if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); PAL.cursor = Math.min(PAL.items.length - 1, PAL.cursor + 1); paintPalette(); refocus(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); PAL.cursor = Math.max(0, PAL.cursor - 1); paintPalette(); refocus(); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            const chosen = PAL.items[PAL.cursor];
            if (chosen) { const run = chosen.run; closePalette(); run(); }
          }
        },
      }),
      list,
      el('div', { class: 'pal-foot' }, '↑ ↓ to choose · Enter to run · Esc to close'),
    ]));

  list.id = 'pal-list';
  const on = list.querySelector('.pal-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

/** Repainting rebuilds the input, so the caret has to be given back. */
function refocus() {
  const input = document.getElementById('pal-input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
