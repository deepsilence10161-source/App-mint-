# App Mint

**A free, offline, deterministic Android app factory.**
Describe an app as a specification → get a real, signed, installable APK.

No account. No subscription. No credits. No AI. No paid API. No usage limit
imposed by this project.

---

## What it does

```
spec.json  →  validate (5 layers)  →  generate  →  compile  →  validate artifact  →  APK
```

The **project specification is the single source of truth**. There is no second
project state anywhere — the generator, the validator and the visual editor all
read and write this one object, so they can never drift apart.

Every build ends with a **real APK that was checked as a real file**: identity,
target SDK, every permission, launcher icon, signature and alignment. A build is
never reported as successful just because Gradle exited zero.

## The Studio — use it from your phone

**Open this link on your phone: https://deepsilence10161-source.github.io/App-mint-**

That is the whole install. No app store, no account, no server. It is one
self-contained HTML file (about 105 KB) with no external requests at all, so it
works offline once loaded and nothing about it can break because a CDN went away.

What you can do in it:

| Section | What it does |
|---|---|
| **Design** | Name, package, colours, website address or bundled page |
| **Screens** | Build screens from the component library: a palette, a tree, properties, and a preview drawn from the same metrics the Android renderer uses |
| **Features** | Turn native capabilities on and off; the permission table updates itself |
| **Preview** | Portrait/landscape and light/dark, drawn from your theme |
| **Build** | Run the five validation layers, see every finding with the exact field, fix what can be fixed safely, and start a build |

Dark mode is the default and light mode is one tap away in the top bar; the
Studio follows your system setting until you say otherwise.

There is only ever **one** project state. The Studio edits the Project
Specification directly — the same object the CLI and CI read — so the editor and
the build can never disagree about what your app is.

### The Studio runs the real engine, not a copy

`tools/build-studio.mjs` inlines `engine/spec/spec.mjs`,
`engine/spec/toolchain.mjs` and `engine/capability/permissions.mjs` into the
bundle. Those three modules import nothing but each other, so the code validating
your project in the browser is byte-for-byte the code that validates it in CI.

This was a deliberate choice. A second, simplified validator inside the editor
would drift, and you would eventually be told "looks fine" by the Studio and
"refused" by the build — the exact duplication this project is supposed to avoid.

### Editing it

```bash
node tools/build-studio.mjs     # rebuild studio/app.html from studio/src/
node tools/test-studio.mjs      # drive the real UI in a real browser (24 checks)
```

`studio/app.html` is committed even though it is generated, because it is the
shipped artifact. CI fails if it is out of date with its sources, so it can never
silently drift.

## Try it in one minute

```bash
node engine/cli.mjs validate apps/demo/spec.json     # check the specification
node engine/cli.mjs permissions apps/demo/spec.json  # show the permission table
node engine/cli.mjs generate apps/demo/spec.json --out build/out
cd build/out/android && gradle assembleDebug
```

No `npm install`. There are zero runtime dependencies — Node's standard library
is the whole toolchain, so this works offline and cannot be broken by a
registry outage or a supply-chain attack.

## What it deliberately is not

- **No AI, anywhere.** Every decision is deterministic and rule-based, so the
  same input always produces the same output and the same explanation.
- **No credits, no subscription, no locked features.** Nothing in this
  repository counts your projects, builds or edits.
- **No fake success.** `Saved`, `Built`, `Signed` and `Passed` each have a
  strict meaning here, and a claim is only made after the thing was verified.

## The five validation layers

Nothing reaches a compiler until it passes all of these:

| Layer | What it catches |
|---|---|
| 1 · Schema | wrong types, missing fields, malformed package names |
| 2 · Semantic | individually valid values that are jointly impossible (minSdk > targetSdk, cleartext traffic, a Play-incompatible target SDK) |
| 3 · Dependency | capabilities, screens and navigation referencing things that do not exist |
| 4 · Security | unsafe URL schemes, signing that is not fail-closed, secrets committed into the spec |
| 5 · Capability | whether the selected toolchain can actually build what was asked for |

A **critical** or **error** finding blocks the build. Warnings do not, but they
are always shown. Overrides exist, must be named explicitly, and are logged.

## Permissions are derived, never written by hand

Permissions come from the enabled capabilities, so turning a feature off removes
its permission from the manifest:

```
POST_NOTIFICATIONS     Reminders and alerts        feature: Notifications
CAMERA                 Needed to scan a code       feature: Barcode / QR
```

The engine also reports what it deliberately **refused** to request — for
example `RECEIVE_BOOT_COMPLETED` when nothing is scheduled to survive a reboot,
or `AD_ID` when ads are disabled. Fewer permissions means a smaller attack
surface, a smaller APK and far fewer Play review problems.

## Security decisions that are not negotiable

- **No `Intent.parseUri` on web-supplied input.** The generated `SchemeRouter`
  builds every outgoing Intent itself from an allowlisted scheme, then verifies
  something can handle it. That structurally removes the intent-redirection
  class of bug rather than blocklisting a few strings.
- **`intent:`, `file:`, `content:`, `javascript:`, `data:` and `blob:` are never
  routed**, even if a specification asks for them.
- **Signing fails closed.** A missing keystore stops the build. It never
  silently generates a new key — that would change the app's identity forever
  and break Google Sign-In and every future update.
- **The JavaScript bridge is off** unless a capability genuinely needs it, and
  when it exists every method is annotated, length-capped and posted to the UI
  thread.
- **Cleartext HTTP is off by default** and paired with a network security config.
- **Secrets are never logged or echoed.** When a scan finds one it reports the
  location, not the value.

## On-device testing, for free

`.github/workflows/emulator-e2e.yml` installs the generated APK on a real
Android emulator, drives it with real touch input, and captures screenshots and
a screen recording.

The **runner never decides whether the test passed**. `tools/e2e/run.sh` only
collects evidence; `tools/e2e/judge.py` judges it and writes down the evidence
behind every check. That separation exists because a driver that grades its own
work will eventually grade it wrong, and a failing app would look like a
passing one.

Reports are published to GitHub Pages, so the result is readable from a phone.

On public repositories GitHub Actions is free and unmetered on standard
runners, and those runners have KVM, so the emulator is hardware accelerated.
That is what makes unlimited device testing possible at zero cost.

## Toolchains

Verified against Google Maven and `services.gradle.org` on 2026-09-30:

| Profile | AGP | Gradle | Build Tools | Max compileSdk |
|---|---|---|---|---|
| `modern` | 8.13.2 | 8.13 | 36.0.0 | 36 |
| `bleeding` | 9.4.1 | 9.6.0 | 36.0.0 | 37 |
| `legacy` | 8.4.2 | 8.6 | 34.0.0 | 34 |

**Why this matters:** Google Play has required **API 36 (Android 16)** for new
apps and all updates since **31 August 2026**, and AGP 8.4.x physically cannot
compile SDK 36. So the toolchain is a compliance question, not a preference.

## Honest limitations

- The designer is a stack, not a canvas. Components are arranged in a column,
  inside containers, at the sizes the Android renderer uses — so there is no
  free positioning, no resizing by corner handles and no multi-select. A drag
  moves a component *within* that structure: it cannot place one at arbitrary
  coordinates, because the generated app could not honour that either.
- Dragging on the canvas works with a mouse from anywhere on a component, and
  with a finger from the grip on the selected component. The grip exists because
  the same one-finger drag is how the preview scrolls, and a screen taller than
  the phone has to stay readable. Alignment guides snap the horizontal edges
  only: the vertical position is the decision being made.
- Components are added from the palette into the current selection, not dropped
  from the palette onto the canvas. The palette is a list of things the library
  can build; dragging from it would be a second, competing way to say the same
  thing before the structure has an insertion point.
- Designer edits — including canvas drags — are journaled and undoable. That
  journal is per session: it is not saved with the project, so closing the tab
  ends it. Project version history (snapshots you can compare and restore) is
  separate and is not implemented.
- Light mode is a complete set of token overrides with a control in the top bar
  that remembers your choice. It passes the contrast gate in both themes, but it
  has not been reviewed by a person, and token parity is necessary rather than
  sufficient: a palette that measures well can still look unfinished.
- No emulator can run inside the development sandbox used to build this (no KVM),
  so device testing happens on GitHub Actions or on a real phone.
- There are no performance measurements anywhere in this repository. Until there
  are, no claim about speed is made here and none should be believed.
- Local build toolchains are not preserved between sessions; they reinstall in
  about 25 seconds.
- Backend integration is specified but not yet generated: `backend.kind` is
  validated and the security rules around it are enforced, but no Supabase or
  Firebase client is emitted yet.

## Layout

```
engine/
  spec/spec.mjs                 the specification: schema + 5 validation layers
  spec/toolchain.mjs            verified AGP/Gradle pairs, shared everywhere
  capability/permissions.mjs    capability → permission derivation
  gen/android.mjs               specification → Android project
  gen/java.mjs                  Java sources (SchemeRouter, MainActivity, bridge)
  gen/icon.mjs                  launcher icons at every density
  gen/png.mjs                   dependency-free PNG encoder
  cli.mjs                       command line entry point
studio/
  app.html                      the built Studio — one self-contained file
  src/                          its sources
apps/demo/                     reference project, with its own bundled page
tools/
  build-studio.mjs              bundles the Studio, inlining the real engine
  test-studio.mjs               drives the Studio in a real browser
  e2e/                          on-device driver, judge, report, verdict
  tests/                        engine self-tests
```
