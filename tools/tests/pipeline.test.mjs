/**
 * BUILD PIPELINE
 * ==============
 *
 * A stepper is the easiest feature in the app to fake: eight words, a timer, and
 * a green tick at the end. These tests exist to make that impossible. Every one
 * of them feeds in the steps a real GitHub Actions run reports and asserts that
 * what comes out is a faithful description of them — including the parts a
 * stepper would rather not show.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pipelineStages, stagesFor, stageStatus, buildStepStatus, stepsFromJobs,
} from '../../engine/spec/pipeline.mjs';

const step = (name, status = 'completed', conclusion = 'success') =>
  ({ name, status, conclusion });

/** The step names the Build workflow actually has, in its own order. */
const BUILD_STEPS = [
  'Checkout',
  'Set up Node',
  'Pick specification',
  'Validate specification (layers 1-5)',
  'Engine self-tests',
  'Build the Studio bundle',
  'Analyse a website and check what it proposes',
  'Row level security gate',
  'Generate Android project',
  'Show permission table',
  'Set up JDK 17',
  'Set up Gradle',
  'Prepare Android SDK',
  'Build debug APK',
  'Locate artifact',
  'Validate the real artifact',
  'Upload APK',
  'Upload build report',
].map((n) => step(n));

/** The step names the device workflow actually has. */
const DEVICE_STEPS = [
  'Checkout',
  'Set up Node',
  'Set up JDK 17',
  'Set up Gradle',
  'Prepare Android SDK',
  'Validate both specifications',
  'Work out the build keys',
  'Restore the build cache',
  'Build both apps',
  'Report what the cache did',
  'Stage both APKs',
  'Enable KVM',
  'Run the app on the emulator',
  'Judge the evidence',
  'Build a report for each app, and a page covering both',
  'Upload evidence',
  'Publish the report (GitHub Pages)',
  'Verdict',
].map((n) => step(n));

const RUN_OK = { status: 'completed', conclusion: 'success' };
const RUN_GOING = { status: 'in_progress', conclusion: null };
const RUN_FAILED = { status: 'completed', conclusion: 'failure' };

/* ── the right stages for the right workflow ────────────────────────────── */

test('the device workflow is recognised, and gets its own stage list', () => {
  assert.notEqual(stagesFor('Run the app on an Android emulator'), stagesFor('Generate, build and validate'));
  const device = stagesFor('Run the app on an Android emulator').map((s) => s.label);
  assert.ok(device.includes('Smoke Test'), 'the device pipeline is where a smoke test happens');
});

test('the build pipeline does not claim a smoke test stage it never runs', () => {
  // The design prompt lists Smoke Test among the stages. The build workflow
  // compiles and inspects an APK; it never runs one. Drawing the stage anyway
  // would be the stepper agreeing with the prompt instead of with the build.
  const built = pipelineStages(BUILD_STEPS, stagesFor('build'), RUN_OK);
  const labels = built.stages.map((s) => s.label);
  assert.ok(!labels.includes('Smoke Test'), `build pipeline showed: ${labels.join(', ')}`);
  assert.ok(!stagesFor('build').some((s) => s.label === 'Smoke Test'),
    'the build pipeline must not define a Smoke Test stage it has no steps for');
});

test('the device pipeline does not claim a signing stage it never runs', () => {
  const built = pipelineStages(DEVICE_STEPS, stagesFor('device'), RUN_OK);
  const labels = built.stages.map((s) => s.label);
  assert.ok(!labels.includes('Sign'), `device pipeline showed: ${labels.join(', ')}`);
  assert.ok(!stagesFor('device').some((s) => s.label === 'Sign'),
    'the device pipeline installs an already-signed APK, so it must not define a Sign stage');
});

/* ── nothing is hidden ──────────────────────────────────────────────────── */

test('every real step lands somewhere — no step is quietly dropped', () => {
  for (const [name, steps, wf] of [
    ['build', BUILD_STEPS, 'build'],
    ['device', DEVICE_STEPS, 'device'],
  ]) {
    const built = pipelineStages(steps, stagesFor(wf), RUN_OK);
    const placed = built.stages.flatMap((s) => s.steps.map((x) => x.name));
    const others = built.other.map((x) => x.name);
    const accounted = new Set([...placed, ...others]);
    const missing = steps.map((s) => s.name).filter((n) => !accounted.has(n));
    assert.deepEqual(missing, [], `${name} pipeline lost: ${missing.join(', ')}`);
  }
});

test('a step no rule matched is listed rather than discarded', () => {
  // A stepper that only draws the stages it knows will look green all the way
  // through a build that is failing somewhere it never learned to look.
  const withUnknown = [...BUILD_STEPS.slice(0, 6), step('Upload a thing nobody anticipated')];
  const built = pipelineStages(withUnknown, stagesFor('build'), RUN_OK);
  // 'Checkout' is unmatched too, and that is correct — it belongs to no stage of
  // the app build. The point is that it is still listed, not swallowed.
  assert.deepEqual(built.other.map((s) => s.name), ['Checkout', 'Upload a thing nobody anticipated']);
});

test('no step is counted in two stages', () => {
  const built = pipelineStages(BUILD_STEPS, stagesFor('build'), RUN_OK);
  const names = built.stages.flatMap((s) => s.steps.map((x) => x.name));
  assert.equal(new Set(names).size, names.length, `a step was double-counted: ${names.join(', ')}`);
});

/* ── status follows the steps, not the clock ────────────────────────────── */

test('a finished successful run shows every reached stage as done', () => {
  const built = pipelineStages(BUILD_STEPS, stagesFor('build'), RUN_OK);
  for (const s of built.stages) {
    assert.equal(s.status, 'done', `${s.label} was ${s.status} on a successful run`);
  }
});

test('a failing step fails its stage and names the step', () => {
  const steps = BUILD_STEPS.map((s) => ({ ...s }));
  const rls = steps.find((s) => s.name === 'Row level security gate');
  rls.conclusion = 'failure';
  const built = pipelineStages(steps, stagesFor('build'), RUN_FAILED);
  const security = built.stages.find((s) => s.key === 'security');
  assert.equal(security.status, 'failed');
  assert.ok(security.detail.includes('Row level security gate'), `detail was "${security.detail}"`);
});

test('a step still running makes its stage running, whatever finished before it', () => {
  const steps = BUILD_STEPS.map((s, i) => (i === 13
    ? { ...s, status: 'in_progress', conclusion: null }
    : (i > 13 ? { ...s, status: 'queued', conclusion: null } : s)));
  const built = pipelineStages(steps, stagesFor('build'), RUN_GOING);
  const build = built.stages.find((s) => s.key === 'build');
  assert.equal(build.status, 'running');
  assert.equal(built.stages.find((s) => s.key === 'guards').status, 'done',
    'the stages before it did finish');
});

test('Done is not reached while the run is still going', () => {
  // The most reassuring lie a stepper can tell.
  const allDone = BUILD_STEPS.map((s) => step(s.name));
  const built = pipelineStages(allDone, stagesFor('build'), RUN_GOING);
  const done = built.stages.find((s) => s.key === 'done');
  assert.equal(done.status, 'running', 'every step finished but the run has not');
});

test('Done fails when the run failed, even if no individual step did', () => {
  const built = pipelineStages(BUILD_STEPS, stagesFor('build'), RUN_FAILED);
  assert.equal(built.stages.find((s) => s.key === 'done').status, 'failed');
});

test('a cancelled run says cancelled, which is neither pass nor fail', () => {
  const steps = BUILD_STEPS.map((s) => ({ ...s, conclusion: 'cancelled' }));
  const built = pipelineStages(steps, stagesFor('build'), { status: 'completed', conclusion: 'cancelled' });
  assert.equal(built.stages.find((s) => s.key === 'done').status, 'cancelled');
  assert.ok(built.stages.filter((s) => s.status === 'done').length === 0,
    'a cancelled build must not show completed stages');
});

test('no steps at all means nothing is claimed to have happened', () => {
  const built = pipelineStages([], stagesFor('build'), null);
  // Only Done is always drawn, so before any step is reported the stepper shows
  // one waiting stage and nothing that looks like progress.
  assert.deepEqual(built.stages.map((s) => s.label), ['Done']);
  assert.equal(built.stages[0].status, 'waiting');
  assert.equal(built.stages[0].detail, 'not started');
  assert.deepEqual(built.absent, stagesFor('build').filter((s) => s.key !== 'done').map((s) => s.label),
    'every stage that never matched a step must be named as absent');
});

/* ── reading the API response ───────────────────────────────────────────── */

test('steps are flattened out of a jobs response in order, with their job named', () => {
  const jobs = {
    jobs: [
      { name: 'Generate, build and validate', steps: [{ name: 'Checkout' }, { name: 'Set up Node' }] },
      { name: 'Second job', steps: [{ name: 'Verdict' }] },
    ],
  };
  const steps = stepsFromJobs(jobs);
  assert.deepEqual(steps.map((s) => s.name), ['Checkout', 'Set up Node', 'Verdict']);
  assert.equal(steps[2].job, 'Second job');
});

test('a malformed or empty jobs response yields no steps and no crash', () => {
  assert.deepEqual(stepsFromJobs(null), []);
  assert.deepEqual(stepsFromJobs({}), []);
  assert.deepEqual(stepsFromJobs({ jobs: [{}] }), []);
});

test('a step status nobody anticipated is still a status', () => {
  assert.equal(buildStepStatus({ status: 'completed', conclusion: 'neutral' }), 'done');
  assert.equal(buildStepStatus({ status: 'completed', conclusion: 'action_required' }), 'done');
  assert.equal(buildStepStatus({ status: 'waiting' }), 'running');
  assert.equal(buildStepStatus({}), 'waiting');
  assert.equal(buildStepStatus(null), 'waiting');
});

test('skipped steps do not hold a stage back, and are not counted as done', () => {
  // Both of these are real Security-stage steps, so they land in one stage and
  // the count is about that stage rather than about the whole step list.
  const steps = [step('Row level security gate'), step('Show permission table', 'completed', 'skipped')];
  assert.equal(stageStatus(steps), 'done');
  const built = pipelineStages(steps, stagesFor('build'), RUN_OK);
  const security = built.stages.find((s) => s.key === 'security');
  assert.equal(security.status, 'done');
  assert.equal(security.detail, '1 of 2 steps done');
});
