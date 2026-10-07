# Repository audit and architecture map

*Phase 1–4 of the evolution prompt. Every number in this file was produced by a
command run against the working tree, not estimated. The commands are given so
any claim here can be re-checked.*

---

## 1. What is here

82 tracked files, ~30,700 lines. Zero runtime dependencies — there is no
`package.json`, and Node's standard library is the whole toolchain.

```
engine/                          the product's rules, in plain Node
  spec/spec.mjs            873   the specification: schema + 5 validation layers
  spec/toolchain.mjs             verified AGP/Gradle pairs
  spec/fix-policy.mjs            which findings may be auto-fixed, and which may not
  capability/permissions.mjs     capability → permission derivation
  components/library.mjs   651   the component palette (types, props, defaults, a11y)
  components/scales.mjs          the metrics the preview and the renderer share
  gen/android.mjs          684   specification → Android project
  gen/java.mjs             745   Java sources (SchemeRouter, MainActivity, bridge)
  gen/native.mjs          1805   native-screens renderer
  gen/icon.mjs, gen/png.mjs      launcher icons, dependency-free PNG encoder
  backend/rls.mjs          426   the row level security gate
  backend/sql.mjs          376   SQL statement splitting and normalisation
  analyse/site.mjs         686   website → app analysis (pure: no fs, no network)
  analyse/html.mjs         469   HTML parsing for the analyser
  diagnose/                637+  known errors and the diagnose pass
  keys/cache.mjs, key.mjs  425+  content-addressed build cache, signing keys
  cli.mjs                  579   command line entry point
studio/                        the interface
  app.html                7048   the built Studio — one self-contained file, shipped
  src/studio.js           1047   the shell: tabs, state, persistence, GitHub build
  src/designer.js         1013   the screen designer and the preview
  src/studio.css          1041   the interface
  src/website.js           348   website → app flow
  src/repairs.js           286   the repair journal (what changed, undo)
tools/
  build-studio.mjs         225   bundles the Studio, inlining the real engine
  test-studio.mjs          706   drives the real UI in a real browser
  tests/                         9 suites, 207 assertions
  e2e/                           on-device driver, judge, report, verdict
apps/                            reference projects (demo, backend-demo, native-demo, site-demo)
```

## 2. The architecture, and why it holds

The load-bearing decision is that **there is one project state**: the Project
Specification. The CLI, CI and the Studio all read and write that one object.
There is no editor-side model, no export step, and therefore nothing that can
drift.

The second decision follows from the first and is what makes the Studio
trustworthy. `tools/build-studio.mjs` **inlines** `engine/spec/spec.mjs`,
`toolchain.mjs`, `fix-policy.mjs`, `capability/permissions.mjs`,
`components/library.mjs`, `components/scales.mjs` and the two analyser modules
into the single HTML file. Those modules import nothing but each other, so the
code validating a project in a phone browser is byte-for-byte the code that
validates it in CI. The bundler enforces this rather than trusting it:

- it **refuses** to flatten re-exports or `export default`;
- it **fails the build** if two modules declare the same top-level name, with
  both module names in the message;
- it **parses** the assembled script with `vm.Script` before writing, so a
  syntax error can never reach a user as a loading screen.

The build stamp is a content hash, not a timestamp, so identical input produces
byte-identical output and the artifact can be committed. CI fails if
`studio/app.html` is out of date with `studio/src/`.

The same discipline applies to the palette: the designer does not contain a list
of components. `engine/components/library.mjs` is the only place a component,
its properties, their types and their accessibility requirements are declared,
and both the editor and the preview are generated from it.

**Consequence for any future work:** do not add a second validator, a second
permission table, or a second component list. Extend the existing one. A
duplicate system here would be the specific failure this architecture exists to
prevent, and it would be invisible until the Studio said "fine" and the build
said "refused".

## 3. Baseline, measured before anything was changed

| Check | Command | Result |
|---|---|---|
| Engine suites | `node --test tools/tests/` | 8 suites, all exit 0 |
| Bundle in sync | `node tools/build-studio.mjs && git diff --quiet studio/app.html` | in sync, no drift |
| Real browser test | `node tools/test-studio.mjs` | **83/83** |

The final state of the same three commands is in section 6.

Running the browser test needed a toolchain that the sandbox did not have:
`playwright-core` plus Chromium's system libraries. `npx playwright install-deps`
fails on this image because it asks for `ttf-unifont` and
`ttf-ubuntu-font-family`, which no longer exist as packages. Installing the
libraries directly works:

```bash
sudo apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0 fonts-liberation
```

## 4. Weaknesses found

Each was found by measurement, and each had been invisible: none of them
produced an error, a warning, or a failing test.

### 4.1 Two tokens were read and never declared

`color: var(--fg-1)` — no `--fg-1` exists. The declaration is invalid at
computed-value time, so the text silently inherited its parent's colour.
`border-radius: var(--r2)` in two rules — no `--r2` exists, so those elements
had **no** rounded corners while every neighbour did.

Both are now declared (`--fg-1` was clearly meant to be `--fg`; `--r2` is now an
alias of `--r-2`), and `tools/tests/tokens.test.mjs` fails the build if any
token is read that nothing declares.

### 4.2 The Preview tab was drawn in the tool's palette, not the app's

`viewPreview()` set five variables — `--pv-bg`, `--pv-fg`, `--pv-primary`,
`--pv-onprimary`, `--pv-sb` — and **no CSS rule read any of them**. The frame
used `background: var(--surface)`, and the cards, captions and skeleton loaders
inside it used the Studio's own surfaces. So the one screen whose entire purpose
is to show what your app will look like was showing the tool's grey.

The preview in the *Screens* tab was not affected: it sets inline styles per
node from the theme. Only the Preview tab's shell was wrong.

Fixed by scoping the frame as `.app-screen` and having every rule inside it read
the project's theme, with fallbacks. Four new browser checks now assert the
actual computed colour of the frame, a card, a caption and the primary action.

### 4.3 A test that could not fail

The check named *"Preview applies the project theme colours"* asserted only:

```js
!!screenBg && screenBg !== 'rgba(0, 0, 0, 0)'
```

The tool's own grey satisfies that, so the check passed for as long as the bug
in 4.2 was present. It also selected `.screen`, which was not the frame. This is
the reason the bug survived: the assertion was weaker than its name.

It is rewritten to set four theme colours through the real Design screen and
require the drawn pixels to match them exactly. A check that cannot fail is
worse than no check, because it is read as coverage.

### 4.4 Contrast claims that were not computed

The stylesheet described its palette as accessible. Measured against WCAG 2.x,
`--fg-3` was **4.24:1** on `--surface` in *both* themes, below the 4.5:1 the
file promised. Corrected to `#8D97AC` (dark) and `#667085` (light).

Every text/surface pair in both themes is now asserted at 4.5:1, as is the
primary button's text against the brand fill.

### 4.5 Hardcoded colours in the tool chrome

35 rules named a colour directly, which is what makes a second theme impossible
rather than merely tedious. All tool-chrome colours are now tokens, and a check
fails if a new one appears.

Two regions are deliberately exempt and are documented as such:

- the **device preview** (`.pv-*`, `.sbar`), which is drawn in the colours of the
  app being designed and must read on an arbitrary theme the tool cannot know;
- the **glint** on a gradient fill (`--glint`, `--glint-soft`), now named tokens
  — white in both themes because it sits on the brand fill, not on a surface.

### 4.6 README describes the product as it was, not as it is

The "Honest limitations" section states there is *no* drag-and-drop screen
designer and that the component library "is not implemented yet". Both exist:
`studio/src/designer.js` (1,013 lines) is a working screen designer with a
palette, a tree, properties and a preview, and `engine/components/library.mjs`
(651 lines) is the component library behind it. The browser test exercises both.

A limitations list that understates the product is the same fault as one that
overstates it: it cannot be trusted, so people stop reading it.

## 5. What was changed in this pass

| File | Change |
|---|---|
| `engine/style/color.mjs` | new — WCAG luminance, contrast, alpha compositing |
| `engine/style/tokens.mjs` | new — token parsing, completeness, duplication and hardcode audits |
| `tools/tests/tokens.test.mjs` | new — 16 assertions, including proofs the gate fires |
| `studio/src/studio.css` | full token system per the design spec, light theme, 35 hardcodes tokenised, `--fg-1`/`--r2` fixed, `--fg-3` contrast corrected |
| `studio/src/studio.js` | `.app-screen` scoping; the preview frame's theme variables now include surface, line, muted and wash |
| `studio/src/index.html` | the colour-mode control in the top bar |
| `tools/test-studio.mjs` | the weak preview-theme check replaced with four exact-colour assertions, plus six covering the colour-mode control |
| `studio/app.html` | rebuilt from sources |

Nothing was removed, rewritten or duplicated. No new module reimplements an
existing one; `engine/style/` is new capability, not a second version of
anything.

## 6. Verification

```
node --test tools/tests/        →  207 tests, 207 pass, 0 fail
node tools/test-studio.mjs      →  93/93 checks passed   (was 83/83)
node tools/build-studio.mjs     →  328.2 KB, single file, nothing external
```

Two further properties were checked rather than assumed:

- **Determinism.** Two consecutive rebuilds produce byte-identical output
  (`cmp` clean). The build stamp is a content hash — `a44211e7dde59d78` — not a
  timestamp, so the artifact can stay committed without churning.
- **No secret in the tree.** A scan of every file for the credential used to
  clone this repository returns zero matches. The token lives outside the
  working tree entirely, in `~/.config/project1/credentials` at mode `600`, and
  git is given it through a `credential.helper` script rather than a URL, so it
  appears in no remote, no config and no log.

The new suite is picked up by CI with no workflow change: `build.yml` runs
`node --test tools/tests/`, which discovers every `*.test.mjs` in the directory.

The token gate is written so it can be checked against the faults it claims to
catch. It asserts that an undeclared token is reported, that a duplicate
declaration in one block is reported while a theme override is not, that a
hardcoded colour is reported outside the preview and allowed inside it, and that
a contrast pair below the threshold is reported. A gate that only ever passes is
decoration.

## 7. Remaining work, in the order the prompt sets out

| Phase | Subject | Status |
|---|---|---|
| 1–4 | Audit, architecture map, weaknesses, specification | **done** (this file) |
| 5 | Visual Builder | **mostly done** — see section 8: canvas dragging with a drop indicator and alignment guides; undo/redo, the command palette, the pipeline stepper and the log console all exist. What remains is free positioning, resizing and multi-select, none of which the generated app could honour anyway |
| 6 | Website Converter | not started — the analyser and rule-based recommendations exist and are tested |
| 7 | Deterministic generators | not audited in depth |
| 8 | Diagnostics and known-fix engine | exists (`diagnose/`, `fix-policy`); not yet measured |
| 9 | Modular toolchain | `toolchain.mjs` exists and is shared; not audited |
| 10 | Performance | **no measurements exist.** The prompt is explicit that no optimisation may be claimed without before/after numbers, so nothing is claimed here |
| 11 | Testing | 294 engine assertions + 181 browser checks; the emulator E2E runs on Actions, not locally (no KVM in this sandbox) |
| 12 | Build UX | the pipeline stepper and the log console exist |
| 13 | APK/AAB validation | exists in `tools/build-apk.mjs`; not audited |
| 14 | Final regression | pending the above |

Known limitations that remain, and are not hidden:

- Light mode is implemented as a token override set, passes the contrast gate in
  both themes, and is reachable through a control that remembers its choice
  across a reload. It has not been reviewed by a person: token parity is
  necessary, not sufficient, and a palette that measures well can still look
  unfinished.
- `engine/gen/native.mjs` (1,805 lines) is the largest module in the repository
  and has not been audited. It is the most likely place for a second, drifting
  implementation of something the component library already defines.
- No performance numbers exist anywhere in this repository. Until they do, no
  claim about speed is made or should be believed.

## 8. Canvas dragging (this pass)

The design prompt asks the visual builder to feel like Figma. The outline had
drag-reordering; the **preview** — the drawing of the app, which is the thing
you are actually looking at — had none, so the one place you most want to move a
component was the one place you could not.

### What changed

| File | Change |
|---|---|
| `studio/src/designer.js` | the canvas drag: destination from the pointer's position in the component under it, a ghost outline naming what is moving, a drop indicator, alignment guides, refusal of self-nesting, edge auto-scroll, and a selection that the outline and the drawing share |
| `studio/src/studio.css` | `.pv-overlay`, `.pv-line`, `.pv-box`, `.pv-guide`, `.pv-ghost`, `.pv-grip`, the selected-node outline — and `.d-head`/`.d-title`/`.d-note`, which had no rules at all, so a heading and its explanation were drawn run together in every cell that used them |
| `studio/src/studio.js` | `window.__appmintHistory()`: the journal of designer edits, so a test can check that a move is undoable and that a no-op recorded nothing |
| `tools/test-studio.mjs` | 15 checks: selection from the canvas, the grip's 44px target, `touch-action` only on the grip, the ghost and its name, the drop line, the guides, the landing, the journal, undo, a refused drop, a touch drag through real pointer events |
| `studio/app.html` | rebuilt — two consecutive rebuilds are byte-identical |

Two guarantees were built into the drag rather than left to the outcome:

- **The indicator is a promise.** The drop decision (`dropTargetAt`) is made
  once, from the pointer's position, and both the indicator and the drop read
  it. There is no second code path that could disagree with what was drawn.
- **A refusal is visible before release.** Dragging a container onto one of its
  own children draws the indicator in the danger colour while the pointer is
  still down; releasing explains itself ("A component cannot be placed inside
  itself.") and records nothing. `moveNodeTo` — the same function the outline's
  drop uses — refuses it, so both paths are corrected by the same rule.

### Why the details are the way they are

- **Pointer events on the canvas, HTML5 drag events in the outline.** `draggable`
  is inert on a touchscreen, and the canvas is where a phone user works. The
  outline keeps `draggable`: it is one attribute, it works with a mouse, and it
  is what the existing tests exercise.
- **A touch drag starts on the grip, a mouse drag anywhere.** The same
  one-finger drag scrolls the preview, and a screen taller than the phone has to
  stay readable. `touch-action: none` is set on the grip alone, and the test
  asserts exactly that.
- **Guides snap horizontally only.** Comparing left, centre and right edges with
  siblings, and with the container itself, within 6px. The vertical position is
  the decision being made; snapping it would take the decision away.
- **A drag that lands where the component already is records nothing.** An undo
  step for a no-op is a claim that something happened.

### A wart found on the way

Typing a property updated the preview and the findings but **not the outline**,
so the tree kept showing a component's old name until the next full redraw —
the editor contradicting itself. It was found by a test that refused to accept
"the structure is unchanged" from a rendering of it. The tree row now follows
its component as it is typed, and the refusal test compares the specification's
ids rather than the labels drawn from them.

### Verification

```
node --test tools/tests/        →  294 tests, 294 pass, 0 fail
node tools/test-studio.mjs      →  181/181 checks passed   (was 162)
node tools/build-studio.mjs     →  deterministic: two rebuilds byte-identical
```

The drag is also exercised in both directions: a drop that is accepted is
checked to land where the indicator said, to be recorded, and to be undoable; a
drop that is refused is checked to be drawn as refused, explained out loud, and
to leave both the specification and the journal untouched.

### Performance

No numbers are claimed here, for the same reason as section 4: none were
measured. What can be said is structural — during a drag the page is not
re-rendered (the ghost and the indicators are one absolutely-positioned overlay
inside the device frame), movement is written with `transform`, and the canvas
is scrolled by hand rather than by re-layout. Whether that holds up on a
mid-range phone is a measurement that has not been made.
