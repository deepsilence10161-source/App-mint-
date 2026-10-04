/* ============================================================================
   BUILD PIPELINE — a stepper that reports a build, rather than performing one
   ----------------------------------------------------------------------------
   The design prompt asks for a pipeline stepper: Guards → Security →
   Dependencies → Build → Sign → Validate → Smoke Test → Done. Those are the
   stages a build conceptually passes through, and they are worth showing.

   What would not be worth showing is a stepper that animates through those
   words on a timer while nothing is happening. That is the most common way this
   feature gets built and it is a lie with a progress bar. So the stages here are
   only ever a grouping of the steps GitHub Actions actually reported for the run
   the Studio started, read from the run's jobs API. A stage is done when its
   real steps are done; it is running when one of them is running; it failed
   because a named step failed, and the name is on the screen.

   Two rules fall out of that, and both exist because the obvious alternative is
   quietly dishonest:

     · a step no rule matched is listed under "Other steps" instead of being
       dropped. A stepper that only shows the stages it knows how to draw will
       look perfectly green through a build that is failing somewhere it never
       learned to look.

     · a stage the workflow never had is not drawn. "Sign" is a real stage in the
       build pipeline because Gradle signs the APK as it builds, and the signing
       scheme is verified against the finished file. It is deliberately absent
       from the device pipeline, which installs an already-signed APK and has no
       signing step of its own. The prompt lists the stages; it does not require
       inventing one to match the list.
   ========================================================================= */

const BUILD_STAGES = [
  { key: 'guards',  label: 'Guards',       icon: 'shield', rules: [/validate specification/i, /pick specification/i, /engine self-tests/i, /check the committed bundle/i] },
  { key: 'security', label: 'Security',    icon: 'lock',   rules: [/row level security/i, /permission table/i, /secret/i] },
  { key: 'deps',    label: 'Dependencies', icon: 'package', rules: [/set up (node|jdk|gradle)/i, /prepare android sdk/i, /install a browser/i, /build the studio bundle/i, /build the single-file studio/i] },
  { key: 'build',   label: 'Build',        icon: 'build',  rules: [/generate android project/i, /build (debug|both apps|release)/i, /assemble/i, /restore the build cache/i, /work out the build keys/i] },
  { key: 'sign',    label: 'Sign',         icon: 'sign',   rules: [/sign/i] },
  { key: 'verify',  label: 'Validate',     icon: 'check',  rules: [/validate the real artifact/i, /locate artifact/i, /stage (both )?apks?/i, /upload (apk|build report)/i, /analyse a website/i] },
  { key: 'done',    label: 'Done',         icon: 'flag',   rules: [] },
];

// The device workflow builds an APK and then runs it on an emulator. There is no
// signing step of its own, so no Sign stage is claimed here.
const DEVICE_STAGES = [
  { key: 'guards',  label: 'Guards',      icon: 'shield',  rules: [/validate (both )?specifications?/i, /work out the build keys/i, /enable kvm/i] },
  { key: 'deps',    label: 'Dependencies', icon: 'package', rules: [/set up (node|jdk|gradle)/i, /prepare android sdk/i, /restore the build cache/i] },
  { key: 'build',   label: 'Build',       icon: 'build',   rules: [/build both apps/i, /stage (both )?apks?/i, /report what the cache did/i] },
  { key: 'smoke',   label: 'Smoke Test',  icon: 'phone',   rules: [/run the app on the emulator/i] },
  { key: 'verify',  label: 'Validate',    icon: 'check',   rules: [/judge the evidence/i, /build a report/i, /publish the report/i, /upload evidence/i, /verdict/i] },
  { key: 'done',    label: 'Done',        icon: 'flag',    rules: [] },
];

/** Which stage list a workflow's steps should be read against. */
export function stagesFor(workflowName) {
  return /device|emulator/i.test(workflowName || '') ? DEVICE_STAGES : BUILD_STAGES;
}

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** A step's status, collapsed to what a stepper can show. */
export function buildStepStatus(step) {
  const c = step && step.conclusion;
  if (c === 'failure' || c === 'timed_out') return 'failed';
  if (c === 'cancelled') return 'cancelled';
  if (c === 'skipped') return 'skipped';
  if (c === 'success') return 'done';
  if (c) return 'done';                       // neutral, action_required: it finished
  if (step && ACTIVE.has(step.status)) return 'running';
  return 'waiting';
}

/** One stage's status, from the statuses of the steps that landed in it. */
export function stageStatus(steps) {
  const s = steps.map(buildStepStatus);
  if (s.includes('failed')) return 'failed';
  if (s.includes('cancelled')) return 'cancelled';
  if (s.includes('running')) return 'running';
  const real = s.filter((x) => x !== 'skipped');
  if (!real.length) return 'waiting';
  return real.every((x) => x === 'done') ? 'done' : 'waiting';
}

/**
 * Group the real steps of a run into stages.
 *
 * `steps` is the flat list of steps across the run's jobs, in the order GitHub
 * returned them. Steps that no rule matches are returned under `other` rather
 * than discarded — see the note at the top of this file.
 */
export function pipelineStages(steps, stageDefs, run) {
  const list = Array.isArray(steps) ? steps : [];
  const stages = stageDefs.map((d) => ({ key: d.key, label: d.label, icon: d.icon, steps: [] }));
  const other = [];
  const used = new Set();

  for (const step of list) {
    const name = (step && step.name) || '(unnamed step)';
    let placed = false;
    for (const stage of stages) {
      const def = stageDefs.find((d) => d.key === stage.key);
      if (def.rules.some((re) => re.test(name))) {
        stage.steps.push(step);
        used.add(stage.key);
        placed = true;
        break;
      }
    }
    if (!placed) other.push(step);
  }

  // "Done" is not something a workflow step announces; it is whether the run
  // itself finished, and how. It is drawn last and always, so a stepper never
  // looks complete while the run is still going.
  const done = stages.find((s) => s.key === 'done');
  if (done) {
    const conclusion = run && run.conclusion;
    done.status = conclusion === 'success' ? 'done'
      : (conclusion === 'failure' || conclusion === 'timed_out') ? 'failed'
      : conclusion === 'cancelled' ? 'cancelled'
      : (run && ACTIVE.has(run.status)) ? 'running'
      : 'waiting';
    done.detail = conclusion ? `run ${conclusion}` : (run && run.status) ? `run ${run.status}` : 'not started';
  }

  const shown = stages.filter((s) => s.key === 'done' || used.has(s.key));
  for (const s of shown) {
    if (s.key === 'done') continue;
    s.status = stageStatus(s.steps);
    const failed = s.steps.find((x) => buildStepStatus(x) === 'failed');
    s.detail = failed
      ? `failed at “${failed.name}”`
      : `${s.steps.filter((x) => buildStepStatus(x) !== 'skipped').length} of ${s.steps.length} steps done`;
  }

  return {
    stages: shown,
    other,
    // Every stage that exists in the definition but never matched a step, named
    // so a reader can tell "not reached yet" from "this pipeline has no such
    // stage" without guessing.
    absent: stages.filter((s) => s.key !== 'done' && !used.has(s.key)).map((s) => s.label),
  };
}

/** Flatten the steps out of a GitHub jobs response, keeping their order. */
export function stepsFromJobs(jobs) {
  const out = [];
  for (const job of (jobs && jobs.jobs) || []) {
    for (const step of job.steps || []) out.push({ ...step, job: job.name });
  }
  return out;
}
