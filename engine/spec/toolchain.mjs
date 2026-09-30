/**
 * TOOLCHAIN PROFILES — single source of truth
 * ==========================================
 * Shared by the generator and the validator so the two can never disagree
 * about what a given AGP/Gradle pair can actually compile.
 *
 * Every version below was checked against Google Maven and services.gradle.org
 * on 2026-09-30. The `maxCompileSdk` values are the ones proven by a real build
 * in .github/workflows/ — not copied from a table.
 *
 * Why this exists at all: Google Play has required API 36 (Android 16) for new
 * apps and all updates since 31 Aug 2026, and AGP 8.4.x physically cannot
 * compile SDK 36. So "which toolchain" is a compliance question, not a taste
 * question.
 */

export const TOOLCHAIN_PROFILES = {
  modern: {
    agp: '8.13.2',
    gradle: '8.13',
    buildTools: '36.0.0',
    jdk: '17',
    maxCompileSdk: 36,
    label: 'Modern — Play-compliant (compileSdk 36)',
  },
  bleeding: {
    agp: '9.4.1',
    gradle: '9.6.0',
    buildTools: '36.0.0',
    jdk: '17',
    maxCompileSdk: 37,
    label: 'Newest — AGP 9.x (compileSdk 37)',
  },
  legacy: {
    agp: '8.4.2',
    gradle: '8.6',
    buildTools: '34.0.0',
    jdk: '17',
    maxCompileSdk: 34,
    label: 'Legacy — compileSdk 34, NOT Play-compliant',
  },
};

export const DEFAULT_PROFILE = 'modern';

/** Which profile does this AGP version belong to? */
export function profileForAgp(agp) {
  if (!agp) return DEFAULT_PROFILE;
  for (const [name, p] of Object.entries(TOOLCHAIN_PROFILES)) {
    if (p.agp === agp) return name;
  }
  const major = parseInt(String(agp).split('.')[0], 10);
  if (major >= 9) return 'bleeding';
  if (major >= 8 && parseInt(String(agp).split('.')[1] || '0', 10) >= 9) return 'modern';
  return 'legacy';
}

/** Pick the lowest profile that can reach the requested compileSdk. */
export function profileForCompileSdk(sdk) {
  const order = ['legacy', 'modern', 'bleeding'];
  for (const name of order) {
    if (TOOLCHAIN_PROFILES[name].maxCompileSdk >= sdk) return name;
  }
  return 'bleeding';
}

/** Resolve the effective toolchain for a spec: explicit toolchain wins. */
export function resolveToolchain(spec) {
  const tc = (spec.build || {}).toolchain || {};
  const name = tc.agp ? profileForAgp(tc.agp) : profileForCompileSdk((spec.android || {}).compileSdk ?? 36);
  return { name, ...TOOLCHAIN_PROFILES[name], ...tc };
}
