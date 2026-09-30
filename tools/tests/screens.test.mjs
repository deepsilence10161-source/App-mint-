/**
 * Tests for the screen designer, the component library, the generated-Java
 * guard, and the diagnostic engine.
 *
 * Several of these exist because of bugs found the hard way:
 *   - a component tree the library called valid produced Java that would not
 *     compile (an escape that did not survive the template literal);
 *   - a package name the specification validator accepted was rejected by
 *     javac, because "native" is a Java reserved word;
 *   - a private method silently stopped a class from satisfying the interface
 *     it claimed to implement.
 * Each of those now has a test so it is caught in under a second rather than
 * in a Gradle run, and never by someone using the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COMPONENTS, ACTIONS, EVENTS, GROUPS,
  validateScreens, componentList, findComponent, nearComponents,
  suggestComponent, needsLabel,
} from '../../engine/components/library.mjs';
import { validateSpec } from '../../engine/spec/spec.mjs';
import { lintGeneratedJava, scanForTests } from '../../engine/gen/lint-java.mjs';
import { match, repair, rollback, explain, ERROR_DB_SIZE } from '../../engine/diagnose/diagnose.mjs';
import { KNOWN_ERRORS } from '../../engine/diagnose/known-errors.mjs';

const DEMO = JSON.parse(readFileSync(new URL('../../apps/native-demo/spec.json', import.meta.url), 'utf8'));

/** Run the screen validator and hand back what it found. */
function checkScreens(spec) {
  const out = [];
  validateScreens(spec, out);
  return out;
}
const failures = (out) => out.filter((i) => i.severity === 'error');

/* ─────────────────────────── the library ─────────────────────────── */

test('every component in the library is complete', () => {
  const names = Object.keys(COMPONENTS);
  assert.ok(names.length >= 30, `expected at least 30 components, found ${names.length}`);
  for (const [name, def] of Object.entries(COMPONENTS)) {
    assert.ok(def.group, `${name} has no group`);
    assert.ok(GROUPS.includes(def.group), `${name} is in group "${def.group}", which does not exist`);
    assert.equal(typeof def.container, 'boolean', `${name} does not say whether it can hold children`);
    for (const [prop, spec] of Object.entries(def.props || {})) {
      assert.ok(spec.type, `${name}.${prop} has no type`);
      assert.ok(spec.label, `${name}.${prop} has no label, so the editor has nothing to show`);
      // A required property that also has a default contradicts itself.
      if (spec.required) assert.ok(!('default' in spec), `${name}.${prop} is required and has a default`);
      // A switch needs a starting position, and the renderer has one either way.
      if (spec.type === 'boolean') assert.equal(typeof spec.default, 'boolean', `${name}.${prop} is a switch with no default`);
      // A dropdown default that is not one of its options is a silent bug.
      if (spec.type === 'choice' && 'default' in spec) {
        const values = (spec.options || []).map((o) => (Array.isArray(o) ? o[0] : o));
        assert.ok(values.includes(spec.default), `${name}.${prop} defaults to "${spec.default}", which is not one of ${values.join(', ')}`);
      }
    }
    for (const e of def.events || []) {
      assert.ok(EVENTS[e], `${name} declares event "${e}", which is not a known event`);
    }
    for (const a of def.actions || []) {
      assert.ok(ACTIONS[a], `${name} lists action "${a}", which is not defined`);
    }
  }
});

test('every action a component can trigger carries the information it needs', () => {
  for (const [name, def] of Object.entries(ACTIONS)) {
    assert.ok(def.label, `action "${name}" has no label`);
    assert.ok(def.props && typeof def.props === 'object', `action "${name}" does not describe its props`);
    for (const [prop, pd] of Object.entries(def.props)) {
      assert.ok(pd.type, `action ${name}.${prop} has no type`);
      assert.ok(pd.label, `action ${name}.${prop} has no label`);
    }
  }
});

test('no action can launch an arbitrary intent', () => {
  // The point of a fixed action list: a generated app cannot start a component
  // of another app by name. Nothing like that may be added without failing here.
  for (const [name, def] of Object.entries(ACTIONS)) {
    assert.ok(!/intent|component|class/i.test(name), `action "${name}" is named after an Android component launch`);
    const json = JSON.stringify(def);
    assert.ok(!/setComponent|Intent\s*\(|className/i.test(json), `action "${name}" can name a target component`);
  }
});

test('an image without a screen-reader label is refused', () => {
  const out = checkScreens({ screens: [{ id: 's1', name: 'One', components: [
    { id: 'i1', type: 'Image', props: { source: 'https://example.com/a.png' } },
  ] }] });
  assert.ok(failures(out).some((i) => i.code === 'E_A11Y_IMAGE'), 'expected the missing label to be an error');
  assert.ok(needsLabel('Image'), 'the library should mark Image as needing a label');
});

test('an unknown component is refused, names itself, and suggests a real one', () => {
  const out = checkScreens({ screens: [{ id: 's1', name: 'One', components: [{ id: 'x', type: 'Imgae', props: {} }] }] });
  const f = failures(out).find((i) => i.code === 'E_UNKNOWN_COMPONENT');
  assert.ok(f, 'expected an unknown-component error');
  assert.match(f.message, /Imgae/, 'the message should quote what was typed');
  assert.equal(f.options[0], 'Image', 'the first suggestion should be the obvious one');
  assert.ok(f.fix && f.fix.value === 'Image', 'there should be a one-click fix');
});

test('navigating to a screen that does not exist is refused', () => {
  const out = checkScreens({ screens: [{ id: 's1', name: 'One', components: [{
    id: 'b1', type: 'Button', props: { text: 'Go' },
    events: { onClick: { kind: 'navigate', props: { screen: 'nowhere' } } },
  }] }] });
  assert.ok(failures(out).some((i) => /nowhere/.test(i.message)), 'expected the broken target to be reported');
});

test('an action needing a capability the app has not enabled is a warning with a fix', () => {
  const out = checkScreens({
    capabilities: [],
    screens: [{ id: 's1', name: 'One', components: [{
      id: 'b1', type: 'Button', props: { text: 'Share' },
      events: { onClick: { kind: 'share', props: { text: 'hello' } } },
    }] }],
  });
  const w = out.find((i) => i.severity === 'warning' && /capab/i.test(i.message));
  assert.ok(w, 'expected a warning about the missing capability');
  assert.ok(w.fix && w.fix.path, 'the warning should carry a one-click fix');
  assert.ok(!failures(out).length, 'a missing capability is a warning, not a reason to refuse the build');
});

test('duplicate ids and an over-deep tree are both refused', () => {
  const dup = checkScreens({ screens: [{ id: 's', name: 'S', components: [
    { id: 'same', type: 'Text', props: { text: 'a' } },
    { id: 'same', type: 'Text', props: { text: 'b' } },
  ] }] });
  assert.ok(failures(dup).some((i) => i.code === 'E_COMP_DUP_ID'), 'a duplicate name inside one screen must be an error: the app keeps one view per name');
  // the same name in two different screens is allowed, and only worth a note
  const across = checkScreens({ screens: [
    { id: 'a', name: 'A', components: [{ id: 'shared', type: 'Text', props: { text: 'a' } }] },
    { id: 'b', name: 'B', components: [{ id: 'shared', type: 'Text', props: { text: 'b' } }] },
  ] });
  assert.equal(failures(across).filter((i) => i.code === 'E_COMP_DUP_ID').length, 0, 'across screens it must not be an error');
  assert.ok(across.some((i) => i.code === 'W_COMP_DUP_ID'), 'across screens it should still be mentioned');

  let node = { id: 'leaf', type: 'Text', props: { text: 'deep' } };
  for (let i = 0; i < 15; i++) node = { id: 'n' + i, type: 'Container', props: {}, children: [node] };
  const deep = checkScreens({ screens: [{ id: 's', name: 'S', components: [node] }] });
  assert.ok(failures(deep).some((i) => /deep|nest/i.test(i.message)), 'expected the depth limit to be reported');
});

test('the demo project is a valid screen design', () => {
  const result = validateSpec(DEMO);
  assert.equal(result.counts.error, 0, JSON.stringify(result.issues.filter((i) => i.severity === 'error'), null, 2));
  assert.equal(result.counts.critical, 0);
  assert.equal(result.blocked, false, 'a valid design must not be blocked');
  assert.ok(DEMO.screens.length >= 4, 'the demo should exercise several screens');
  assert.ok(DEMO.navigation, 'the demo should exercise the navigation setting');
});

test('a label written on the component counts, exactly like one among its props', () => {
  // The editor writes it on the component and the renderer accepts either
  // place, so validation must not refuse a label that works.
  const onNode = checkScreens({ screens: [{ id: 's', name: 'S', components: [
    { id: 'i', type: 'Image', props: { source: 'https://example.com/a.png' }, a11yLabel: 'A picture' },
  ] }] });
  assert.deepEqual(failures(onNode), [], 'a label on the component must be accepted');
  const inProps = checkScreens({ screens: [{ id: 's', name: 'S', components: [
    { id: 'i', type: 'Image', props: { source: 'https://example.com/a.png', a11yLabel: 'A picture' } },
  ] }] });
  assert.deepEqual(failures(inProps), [], 'a label among the props must be accepted');
});

test('a valid design produces no findings at all', () => {
  const out = checkScreens({
    capabilities: ['share'],
    screens: [{ id: 's1', name: 'One', components: [
      { id: 't', type: 'Heading', props: { text: 'Hello' } },
      { id: 'i', type: 'Image', props: { source: 'https://example.com/a.png' }, a11yLabel: 'A picture' },
      { id: 'b', type: 'Button', props: { text: 'Share' }, events: { onClick: { kind: 'share', props: { text: 'hi' } } } },
    ] }],
  });
  assert.deepEqual(failures(out), [], 'a correct design must not produce errors');
});

test('the palette is stable and every entry is complete', () => {
  const a = componentList().map((c) => c.name).join(',');
  const b = componentList().map((c) => c.name).join(',');
  assert.equal(a, b, 'the palette must not reshuffle between loads');
  assert.ok(componentList().every((c) => c.group && c.label && c.name));
  assert.equal(componentList().length, Object.keys(COMPONENTS).length, 'every component must appear exactly once');
  assert.ok(findComponent('Button'));
  assert.equal(findComponent('Nope'), null);
});

test('a mistyped component name suggests the intended one', () => {
  for (const [typed, expected] of [
    ['imgae', 'Image'], ['IMage', 'Image'], ['Cardd', 'Card'], ['Textt', 'Text'],
    ['btn', 'Button'], ['dropdwn', 'Dropdown'],
  ]) {
    assert.equal(suggestComponent(typed), expected, `"${typed}" should suggest ${expected}`);
  }
  assert.equal(suggestComponent('xyzzy'), null, 'nonsense should not be answered with a wrong guess');
  assert.deepEqual(nearComponents(''), []);
});

test('the library and the renderer agree on every switch default', () => {
  // Two systems read these defaults: the editor draws a starting position from
  // the library, and the renderer falls back to its own value when a switch is
  // absent. If they disagree, the preview and the app differ — the worst
  // failure a design tool can have, and an invisible one.
  const renderer = readFileSync(new URL('../../engine/gen/native.mjs', import.meta.url), 'utf8');
  const fallback = new Map();
  for (const m of renderer.matchAll(/flag\("([a-zA-Z]+)",\s*(true|false)/g)) fallback.set(m[1], m[2] === 'true');

  let compared = 0;
  for (const c of componentList()) {
    for (const [prop, spec] of Object.entries(c.props)) {
      if (spec.type !== 'boolean' || !fallback.has(prop)) continue;
      assert.equal(spec.default, fallback.get(prop),
        `${c.name}.${prop}: the editor starts at ${spec.default} and the renderer falls back to ${fallback.get(prop)}`);
      compared++;
    }
  }
  assert.ok(compared >= 8, `expected to compare a good number of switches, compared ${compared}`);
});

/* ─────────────────────────── the package name rule ─────────────────────────── */

test('a package name containing a Java keyword is refused before a build starts', () => {
  // javac rejected com.appmint.native: "native" is a Java reserved word. The
  // validator accepted it, which is the gap this test closes.
  for (const bad of ['com.appmint.native', 'com.example.new', 'com.static.app', 'a.class.b', 'x.int.y']) {
    const spec = structuredClone(DEMO);
    spec.identity.packageName = bad;
    const result = validateSpec(spec);
    const finding = result.issues.find((i) => i.code === 'E_JAVA_KEYWORD_PKG');
    assert.ok(finding, `${bad} should be refused`);
    assert.equal(finding.severity, 'error', `${bad} should be an error, not a warning`);
    assert.ok(finding.fix, `${bad} should come with a fix`);
    assert.ok(!finding.fix.value.split('.').some((seg) => ['native', 'new', 'static', 'class', 'int'].includes(seg)),
      `the suggested name ${finding.fix.value} still contains the keyword`);
  }
});

test('an ordinary package name is left alone, and keywords only count as whole segments', () => {
  const result = validateSpec(DEMO);
  assert.equal(result.issues.filter((i) => i.code === 'E_JAVA_KEYWORD_PKG').length, 0);
  // "newspaper" contains "new" but is not a keyword, and "navigation" contains
  // "native" at the start but is a perfectly good name
  for (const ok of ['com.example.newspaper', 'com.example.navigation', 'com.natives']) {
    const spec = structuredClone(DEMO);
    spec.identity.packageName = ok;
    const r = validateSpec(spec);
    assert.equal(r.issues.filter((i) => i.code === 'E_JAVA_KEYWORD_PKG').length, 0, `${ok} should be allowed`);
  }
});

/* ─────────────────────────── the generated-Java guard ─────────────────────────── */

test('the Java guard catches an escape that would not compile', () => {
  const bad = { path: 'Bad.java', data: 'public class Bad { void f(){ String[] p = raw.split("\\|"); } }' };
  const r = lintGeneratedJava([bad]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].kind, 'escape');
  assert.match(r.errors[0].message, /backslash/i, 'the message should explain what to write instead');
});

test('the Java guard catches a class that does not satisfy its interface', () => {
  const src = [
    'public class Actions {',
    '  public interface Navigator {',
    '    void goTo(String screenId);',
    '    boolean goBack();',
    '  }',
    '  public static void toast(String message) { }',
    '}',
  ].join('\n');

  // methods declared after the interface must not be attributed to it
  const scan = scanForTests(src);
  assert.deepEqual(scan.interfaces.get('Navigator').map((m) => m.name), ['goTo', 'goBack']);
  assert.deepEqual((scan.methods.get('Actions') || []).map((m) => m.name), ['toast']);

  // a private method of the right name looks like an implementation and is not one
  const impl = 'public class Impl implements Actions.Navigator {\n  private void goTo(String screenId) { }\n  @Override public boolean goBack() { return true; }\n}';
  const r = lintGeneratedJava([{ path: 'Actions.java', data: src }, { path: 'Impl.java', data: impl }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /private/i);

  // a genuinely missing method is caught too
  const missing = 'public class Impl implements Actions.Navigator {\n  @Override public boolean goBack() { return true; }\n}';
  const r2 = lintGeneratedJava([{ path: 'Actions.java', data: src }, { path: 'Impl.java', data: missing }]);
  assert.equal(r2.ok, false);

  // and a complete implementation passes
  const ok = 'public class Impl implements Actions.Navigator {\n  @Override public void goTo(String screenId) { }\n  @Override public boolean goBack() { return true; }\n}';
  assert.equal(lintGeneratedJava([{ path: 'Actions.java', data: src }, { path: 'Impl.java', data: ok }]).ok, true);
});

test('the Java guard stays quiet on correct code', () => {
  const good = [
    { path: 'A.java', data: 'public class A implements B.Nav {\n  @Override public void go(String screenId) { }\n}\ninterface Nav { void go(String screenId); }' },
    { path: 'B.java', data: 'public class B {\n  void f(int x) { if (x > 0) { g(x); } return; }\n  void g(int y) { }\n}' },
    { path: 'C.java', data: 'public class C { void f(){ raw.split("\\\\|"); } }' },
    { path: 'D.java', data: 'public class D { void f(){ text.replaceAll("[^0-9+]", ""); } }' },
  ];
  assert.deepEqual(lintGeneratedJava(good).errors, []);
});

test('the Java guard catches an unbalanced template and a misplaced public class', () => {
  const un = lintGeneratedJava([{ path: 'U.java', data: 'public class U { void f() { }' }]);
  assert.equal(un.ok, false);
  assert.ok(un.errors.some((e) => e.kind === 'balance'));

  const misnamed = lintGeneratedJava([{ path: 'Wrong.java', data: 'public class Right { }' }]);
  assert.equal(misnamed.ok, false);
  assert.ok(misnamed.errors.some((e) => e.kind === 'filename'));
});

/* ─────────────────────────── the diagnostic engine ─────────────────────────── */

test('a real Gradle failure is recognised and explained', () => {
  const log = [
    '> Task :app:compileDebugJavaWithJavac FAILED',
    'FAILURE: Build failed with an exception.',
    '* What went wrong:',
    "A problem occurred evaluating project ':app'.",
    '> Minimum supported Gradle version is 8.7. Current version is 8.13.',
  ].join('\n');
  const r = match(log);
  assert.ok(r.findings.length >= 1);
  assert.equal(r.findings[0].id, 'AGP_GRADLE_MISMATCH');
  assert.equal(r.findings[0].confidence, 'high');
  assert.ok(r.findings[0].cause.length > 20, 'a finding must explain itself in plain language');
  assert.ok(r.findings[0].evidence, 'a finding must show the line it came from');
});

test('the compiler message from the namespace bug is now recognised', () => {
  const log = "A problem occurred evaluating project ':app'.\n> Namespace 'com.appmint.native' is not a valid Java package name as 'native' is a Java keyword.\n";
  const { findings } = match(log);
  assert.ok(findings.some((f) => f.id === 'PKG_JAVA_KEYWORD'), 'this failure should be in the database now');
});

test('a repair is applied, recorded, and can be undone exactly', () => {
  const spec = { build: { toolchain: { agp: '8.4.2', gradle: '8.6', buildTools: '34.0.0', jdk: '11' } } };
  const log = 'Android Gradle plugin requires Java 17 to run. You are currently using Java 11.\n';
  const out = repair(log, spec);
  assert.ok(out.applied.length >= 1, 'expected at least one repair');
  assert.equal(out.spec.build.toolchain.jdk, '17');
  const back = rollback(out.spec, out.applied);
  assert.deepEqual(back, spec, 'rollback must restore the specification exactly');
});

test('a repair merges instead of erasing the settings around it', () => {
  const spec = { build: { toolchain: { agp: '8.4.2', gradle: '8.13', buildTools: '34.0.0', jdk: '11' }, minify: true } };
  const out = repair('Android Gradle plugin requires Java 17 to run. You are currently using Java 11.\n', spec);
  assert.equal(out.spec.build.toolchain.jdk, '17');
  assert.equal(out.spec.build.toolchain.gradle, '8.13', 'untouched settings must survive');
  assert.equal(out.spec.build.minify, true, 'unrelated sections must survive');
});

test('the engine refuses to guess at an unknown failure', () => {
  const log = 'gibberish that matches nothing in the database at all\n';
  assert.equal(match(log).ok, false);
  const e = explain(log);
  assert.equal(e.recognised, false);
  assert.match(e.headline, /not in the known-error database/i);
  assert.ok(e.next.length >= 2, 'an unknown failure must still leave the user with something to do');
});

test('a keystore problem is reported and deliberately not repaired', () => {
  // Generating a new keystore would change the app's identity for ever, and
  // break sign-in and updates. Doing the helpful-looking thing here is wrong.
  const log = 'Keystore was tampered with, or password was incorrect\n';
  const out = repair(log, { signing: { mode: 'secret-store' } });
  assert.equal(out.applied.length, 0, 'nothing may be applied automatically');
  assert.ok(out.skipped.some((s) => s.id === 'KEYSTORE_WRONG_PASSWORD'), 'it should be recorded as skipped');
  const e = explain(log);
  assert.match(e.headline, /password/i);
  assert.ok(e.needsHuman.length >= 1);
});

test('a repair below high confidence is suggested but never applied', () => {
  // This entry knows what to do about the problem, and still must not do it
  // on its own: a wrong change to a build is worse than an honest message.
  const out = repair('Lost connection to the Gradle daemon\n', { build: {} });
  assert.equal(out.applied.length, 0, 'nothing below high confidence may be applied');
  assert.ok(out.skipped.some((s) => /confidence is medium/.test(s.reason)), JSON.stringify(out.skipped));
});

test('a match with no known repair is reported and left alone', () => {
  const out = repair('error: cannot find symbol\n', { build: {} });
  assert.equal(out.applied.length, 0);
  assert.ok(out.skipped.some((s) => /human decision/.test(s.reason)));
});

test('an unknown-log line cannot smuggle a repair in', () => {
  const out = repair('this line mentions nothing at all\n', { identity: { appName: 'x' } });
  assert.deepEqual(out.spec, { identity: { appName: 'x' } });
});

test('redaction removes secrets from anything that leaves the engine', () => {
  const log = [
    'env: GITHUB_TOKEN=ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    '  at /home/runner/work/app/app/Foo.java:12',
    'password = hunter2',
  ].join('\n');
  const text = JSON.stringify(match(log).findings);
  assert.ok(!text.includes('ghp_AAAABBBB'), 'the token leaked into the report');
  assert.ok(!text.includes('hunter2'), 'the password leaked into the report');
  assert.ok(!text.includes('/home/runner/work'), 'an absolute path leaked into the report');
});

test('no two entries claim the same line, so the outcome never depends on order', () => {
  const owner = new Map();
  for (const e of KNOWN_ERRORS) {
    for (const pattern of e.match.patterns || []) {
      if (owner.has(pattern)) {
        assert.fail(`${e.id} and ${owner.get(pattern)} both match ${pattern}`);
      }
      owner.set(pattern, e.id);
    }
  }
  assert.ok(owner.size >= 35, `expected a good number of distinct signatures, found ${owner.size}`);
});

test('the database is coherent: no duplicates, and every entry is useful', () => {
  assert.ok(ERROR_DB_SIZE >= 30, `expected a substantial database, found ${ERROR_DB_SIZE}`);
  const ids = new Set();
  for (const e of KNOWN_ERRORS) {
    assert.ok(!ids.has(e.id), `duplicate error id ${e.id}`);
    ids.add(e.id);
    assert.ok(e.cause && e.cause.length > 15, `${e.id} has no plain-language cause`);
    assert.ok(e.explanation && e.explanation.length > 20, `${e.id} has no explanation`);
    assert.ok(['high', 'medium', 'low'].includes(e.confidence), `${e.id} has no confidence`);
    // Below high confidence a repair may exist — it is offered, never applied
    // on its own — but an entry with no repair at all must still tell the user
    // what to do next.
    if (!e.repair) {
      assert.ok(e.advice && e.advice.length, `${e.id} has no repair and no advice, so it helps nobody`);
    }
    assert.equal(typeof e.match, 'function', `${e.id} has no matcher`);
    assert.ok(e.match('') === false || true, `${e.id} matcher must not throw on an empty string`);
  }
});
