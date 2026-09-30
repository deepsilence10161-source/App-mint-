/**
 * KNOWN ERROR DATABASE
 * ====================
 * A structured catalogue of errors that have actually been seen, each with a
 * deterministic repair where one is genuinely safe.
 *
 * The rule this file exists to enforce: repair only what is *known*. An error
 * that is not in this database is reported, explained as far as the evidence
 * allows, and left alone. Guessing at an unknown error is how a build system
 * turns one bug into three.
 *
 * Every entry declares:
 *   match          how to recognise the error
 *   category       where the fault is
 *   cause          what it means, in plain language
 *   repair         what to change, or null when the fix needs a human decision
 *   reversible     whether the change can be undone automatically
 *   confidence     high = safe to apply automatically; low = only suggest
 *
 * Categories follow the shape of the systems involved: Android toolchain, web,
 * backend, and build/cache.
 */

/** Helper: does any of these regexes appear in the text?
 *  The patterns are kept on the function so a test can check that no two
 *  entries claim the same line — overlapping signatures make the outcome
 *  depend on the order of the list, which is exactly the kind of quiet
 *  unreliability this database exists to remove. */
const any = (...patterns) => {
  const fn = (text) => patterns.some((p) => p.test(text));
  fn.patterns = patterns.map(String);
  return fn;
};

export const CATEGORIES = {
  android: { label: 'Android toolchain', color: '#3DDC84' },
  gradle: { label: 'Gradle', color: '#3DDC84' },
  manifest: { label: 'Android manifest', color: '#3DDC84' },
  resources: { label: 'Android resources', color: '#3DDC84' },
  signing: { label: 'Signing', color: '#FBBF24' },
  kotlin: { label: 'Kotlin / Java', color: '#7F52FF' },
  node: { label: 'Node and npm', color: '#5FA04E' },
  web: { label: 'Web code', color: '#38BDF8' },
  supabase: { label: 'Supabase', color: '#3ECF8E' },
  rls: { label: 'Row-level security', color: '#FB7185' },
  auth: { label: 'Authentication', color: '#FB7185' },
  network: { label: 'Network', color: '#93C5FD' },
  build: { label: 'Build and cache', color: '#A78BFA' },
  artifact: { label: 'Build artifact', color: '#A78BFA' },
  toolchain: { label: 'Toolchain versions', color: '#A78BFA' },
  spec: { label: 'Project specification', color: '#22D3EE' },
  device: { label: 'Device and emulator', color: '#F472B6' },
};

export const KNOWN_ERRORS = [
  /* ══════════════════ GRADLE AND ANDROID TOOLCHAIN ══════════════════ */
  {
    id: 'AGP_GRADLE_MISMATCH',
    category: 'toolchain',
    confidence: 'high',
    match: any(
      /requires Gradle (\d+[\d.]*)/i,
      /Minimum supported Gradle version is ([\d.]+)/i,
      /Android Gradle plugin requires Gradle/i,
    ),
    cause: 'The Android Gradle Plugin and the Gradle version do not match. One of them was changed without the other.',
    explanation:
      'Google publishes an AGP/Gradle compatibility table and the pair is not interchangeable. The error usually names the minimum Gradle required.',
    repair: {
      kind: 'setToolchain',
      describe: (m) => `Set Gradle to the version Android Gradle Plugin ${m.agp || 'this project'} requires.`,
      apply: (matched, spec) => {
        const required = matched[1];
        if (!required) return null;
        const tc = { ...(spec.build?.toolchain || {}) };
        tc.gradle = required;
        return { path: 'build.toolchain.gradle', value: required };
      },
    },
    reversible: true,
  },
  {
    id: 'AGP_COMPILE_SDK_TOO_NEW',
    category: 'android',
    confidence: 'high',
    match: any(
      /compileSdk(?:Version)?\s*(\d+)[^\n]*not supported/i,
      /We recommend using a newer Android Gradle plugin/i,
      /requires.*compileSdk\s*(\d+)/i,
    ),
    cause: 'The requested compile SDK is newer than the chosen Android Gradle Plugin can handle.',
    explanation:
      'AGP 8.4.2 stops at SDK 34, for example. Since 31 August 2026 Google Play requires API 36 for new apps and updates, so this has to be resolved by moving the toolchain forward, not by lowering the SDK.',
    repair: {
      kind: 'setToolchain',
      describe: () => 'Move to the modern toolchain (AGP 8.13.2 / Gradle 8.13 / Build Tools 36.0.0).',
      apply: (matched, spec) => {
        const agp = spec.build?.toolchain?.agp || '8.4.2';
        const major = parseInt(String(agp).split('.')[0], 10);
        const minor = parseInt(String(agp).split('.')[1] || '0', 10);
        // AGP 8.9 and above can compile SDK 36; below that it cannot.
        if (major > 8 || (major === 8 && minor >= 9)) return null;
        return { path: 'build.toolchain', value: { agp: '8.13.2', gradle: '8.13', buildTools: '36.0.0', jdk: '17' } };
      },
    },
    reversible: true,
  },
  {
    id: 'JDK_TOO_OLD',
    category: 'toolchain',
    confidence: 'high',
    match: any(
      /Unsupported class file major version 6\d/i,
      /Android Gradle plugin requires Java 17/i,
      /Cannot determine java version/i,
      /jvm target.*17/i,
    ),
    cause: 'The JDK running Gradle is older than the Android Gradle Plugin requires.',
    explanation:
      'AGP 8 and above require JDK 17. Using JDK 8 or 11 shows up as an obscure class-file version error rather than a clear message.',
    repair: {
      kind: 'setToolchain',
      describe: () => 'Set the build to use JDK 17.',
      apply: () => ({ path: 'build.toolchain.jdk', value: '17' }),
    },
    reversible: true,
  },
  {
    id: 'GRADLE_DAEMON_OOM',
    category: 'gradle',
    confidence: 'high',
    match: any(
      /Expiring Daemon because JVM heap space is exhausted/i,
      /Java heap space/i,
      /OutOfMemoryError.*heap/i,
      /Metaspace/i,
      /Daemon disappeared unexpectedly/i,
      /Killed.*gradle/i,
    ),
    cause: 'Gradle ran out of memory.',
    explanation:
      'This is usually a machine with little RAM. Setting org.gradle.jvmargs too high on a small machine causes the same failure as setting it too low, because the operating system kills the process.',
    repair: {
      kind: 'addGradleProperty',
      describe: () => 'Lower the Gradle heap to 2048 MB and disable parallel builds, which reduces peak memory.',
      apply: () => ({
        path: 'build.gradleProperties',
        value: {
          'org.gradle.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8',
          'org.gradle.parallel': 'false',
          'org.gradle.workers.max': '2',
        },
      }),
    },
    reversible: true,
  },
  {
    id: 'GRADLE_DAEMON_DISAPPEARED',
    category: 'gradle',
    confidence: 'medium',
    // Note: "the daemon disappeared unexpectedly" is deliberately NOT matched
    // here. It is the signature of the out-of-memory entry above, which is both
    // the more likely cause and the one with a real fix. Two entries claiming
    // the same line would make the outcome depend on ordering.
    match: any(/Lost connection to the Gradle daemon/i, /connection to the daemon was lost/i),
    cause: 'The Gradle daemon process died mid-build, usually because the machine ran out of memory.',
    explanation: 'Running without a daemon and lowering the heap both reduce the chance of this.',
    repair: {
      kind: 'addGradleProperty',
      describe: () => 'Disable the Gradle daemon and cap memory.',
      apply: () => ({
        path: 'build.gradleProperties',
        value: { 'org.gradle.daemon': 'false', 'org.gradle.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=512m' },
      }),
    },
    reversible: true,
  },
  {
    id: 'SDK_PLATFORM_MISSING',
    category: 'android',
    confidence: 'high',
    match: any(
      /Failed to find target with hash string ['"]android-(\d+)['"]/i,
      /platforms;android-(\d+) not installed/i,
      /Could not find platform.*android-(\d+)/i,
      /ANDROID_HOME.*not.*set/i,
      /SDK location not found/i,
    ),
    cause: 'The Android SDK platform the project compiles against is not installed.',
    explanation: 'The SDK piece needs installing before the build can run.',
    repair: {
      kind: 'engineStep',
      describe: (m) => `Install SDK platform android-${m[1] || '36'} and build tools 36.0.0.`,
      apply: (matched) => ({ path: 'build.sdk', value: { platform: `android-${matched[1] || '36'}`, buildTools: '36.0.0' } }),
    },
    reversible: true,
  },
  {
    id: 'BUILD_TOOLS_MISSING',
    category: 'android',
    confidence: 'high',
    match: any(
      /Failed to find Build Tools revision ([\d.]+)/i,
      /build-tools;([\d.]+) not installed/i,
    ),
    cause: 'The requested Build Tools version is not installed.',
    explanation: 'Either install it, or set a build tools version that is present.',
    repair: {
      kind: 'setToolchain',
      describe: () => 'Use Build Tools 36.0.0, which matches the rest of the toolchain.',
      apply: () => ({ path: 'build.toolchain.buildTools', value: '36.0.0' }),
    },
    reversible: true,
  },

  /* ══════════════════ MANIFEST AND RESOURCES ══════════════════ */
  {
    id: 'PKG_JAVA_KEYWORD',
    category: 'manifest',
    confidence: 'high',
    match: any(
      /Namespace '([\w.]+)' is not a valid Java package name as '(\w+)' is a Java keyword/i,
      /applicationId '([\w.]+)'.*is a Java keyword/i,
    ),
    cause: 'The package name contains a Java reserved word, so the generated code cannot live in it.',
    explanation:
      'A package name becomes a Java package. Names like com.example.native, .new, .static or .class read fine to a person and are rejected by the compiler.',
    repair: {
      kind: 'renamePackage',
      describe: (m) => `Rename the "${m[2] || 'reserved'}" package segment — the validator now refuses this before a build starts.`,
      apply: (matched) => (matched[1] ? { path: 'identity.packageName', value: matched[1] } : null),
    },
    reversible: true,
  },
  {
    id: 'MANIFEST_MISSING_PACKAGE',
    category: 'manifest',
    confidence: 'high',
    match: any(
      /Namespace not specified/i,
      /Package name.*not.*specified/i,
      /Cannot read packageName from/i,
    ),
    cause: 'The Android namespace or application id is missing.',
    explanation: 'A generated project must always declare both; a missing one means the generator or a hand edit lost it.',
    repair: null, // regenerating from the specification is the right answer, not guessing
    advice: [
      'Regenerate the project — the package name comes from the specification and is never hand-written.',
      'Check identity.packageName in the specification; it must be a full name like com.example.myapp.',
    ],
  },
  {
    id: 'MANIFEST_DUPLICATE_PERMISSION',
    category: 'manifest',
    confidence: 'high',
    match: any(/Duplicate.*uses-permission/i, /Element uses-permission.*already exists/i),
    cause: 'The same permission is declared twice.',
    explanation: 'Two capabilities contributed the same permission. The permission engine derives them as a set, so this indicates a hand-edited manifest.',
    repair: {
      kind: 'regenerate',
      describe: () => 'Regenerate the manifest, which derives permissions from enabled capabilities as a set.',
      apply: () => ({ path: '__regenerate', value: 'manifest' }),
    },
    reversible: true,
  },
  {
    id: 'MANIFEST_EXPORTED_MISSING',
    category: 'manifest',
    confidence: 'high',
    match: any(
      /android:exported needs to be explicitly specified/i,
      /Apps targeting Android 12 and higher are required to specify/i,
    ),
    cause: 'An activity with an intent filter is missing android:exported.',
    explanation: 'Android 12 and above require this to be explicit, because it controls whether other apps can start the component.',
    repair: null, // exporting a component is a security decision and must not be automated
    advice: [
      'Decide explicitly whether other apps may open this component, then set android:exported accordingly.',
      'An activity with an intent filter is the usual cause. Exporting one on purpose is fine; exporting one by accident is a security hole.',
      'The generator sets this for the screens it creates, so a missing value usually means the file was edited by hand.',
    ],
  },
  {
    id: 'RESOURCE_NOT_FOUND',
    category: 'resources',
    confidence: 'medium',
    match: any(
      /resource ([\w.]+) not found/i,
      /AAPT: error: resource.*not found/i,
      /No resource found that matches the given name/i,
    ),
    cause: 'The layout or drawable references a resource that does not exist.',
    explanation: 'Usually a component refers to an image or string that was never created.',
    repair: {
      kind: 'regenerate',
      describe: () => 'Regenerate the resources from the specification, which rebuilds icons and theme values.',
      apply: () => ({ path: '__regenerate', value: 'resources' }),
    },
    reversible: true,
  },

  /* ══════════════════ SIGNING ══════════════════ */
  {
    id: 'KEYSTORE_MISSING',
    category: 'signing',
    confidence: 'high',
    match: any(
      /Keystore file.*not found/i,
      /SigningConfig.*storeFile/i,
      /KEYSTORE_PATH.*not set/i,
      /file .*keystore.*does not exist/i,
    ),
    cause: 'The signing keystore is missing.',
    explanation:
      'This must NOT be repaired by generating a new key. A new key changes the app\'s identity permanently, which breaks Google Sign-In and stops every existing user from receiving updates. The build is supposed to stop here.',
    repair: null,
    advice: [
      'Add the keystore as a repository secret in the build engine.',
      'If this is the very first release, create a keystore once and store it safely — losing it means you can never update the app again.',
      'For a test build, switch signing to debug.',
    ],
  },
  {
    id: 'KEYSTORE_WRONG_PASSWORD',
    category: 'signing',
    confidence: 'high',
    match: any(
      /Keystore was tampered with, or password was incorrect/i,
      /Cannot recover key/i,
      /Given final block not properly padded/i,
      /keystore password was incorrect/i,
    ),
    cause: 'The keystore password or key alias is wrong.',
    explanation: 'Android deliberately gives a misleading message here. The password, the alias and the key password must all be correct.',
    repair: null,
    advice: [
      'Check all three secrets: store password, key alias and key password.',
      'Verify the alias with: keytool -list -keystore your.jks',
      'Remember that the key password is often different from the store password.',
    ],
  },
  {
    id: 'APK_UNSIGNED',
    category: 'signing',
    confidence: 'high',
    match: any(/not signed/i, /No signature found/i, /app-release-unsigned/i, /jarsigner.*verification failed/i),
    cause: 'The produced APK is not signed.',
    explanation: 'An unsigned APK cannot be installed on any device, and no build should ever report success for one.',
    repair: null,
    advice: [
      'Check that the signing step ran and that its secrets are present.',
      'A debug build signs with the debug key automatically; only a release build needs a keystore.',
      'Never treat an unsigned file as a finished app — it cannot be installed.',
    ],
  },

  /* ══════════════════ JAVA / KOTLIN ══════════════════ */
  {
    id: 'JAVA_SYMBOL_NOT_FOUND',
    category: 'kotlin',
    confidence: 'low',
    match: any(/error: cannot find symbol/i, /error: package .* does not exist/i),
    cause: 'A generated class or method does not exist.',
    explanation:
      'In a generated project this almost always means the code and the specification have drifted apart — for example a component was renamed in one place only.',
    repair: null,
    advice: [
      'Regenerate the project from the specification rather than editing the generated Java.',
      'If the error names a custom class you added by hand, that file is kept on regeneration and is the place to look.',
    ],
  },
  {
    id: 'JAVA_DUPLICATE_CLASS',
    category: 'kotlin',
    confidence: 'high',
    match: any(/duplicate class/i, /Duplicate class .* found in modules/i),
    cause: 'The same class is present in two dependencies.',
    explanation: 'Two libraries ship the same class. Excluding one is the usual answer.',
    repair: null,
    advice: [
      'Find which two dependencies ship the same class and exclude one of them.',
      'If the class comes from generated code, check that a file was not generated twice under different names.',
    ],
  },
  {
    id: 'DEX_METHOD_LIMIT',
    category: 'android',
    confidence: 'medium',
    match: any(/method ID not in \[0, 0xffff\]/i, /Cannot fit requested classes in a single dex file/i, /too many field references/i),
    cause: 'The app has more than 64K methods in a single DEX file.',
    explanation: 'Enable multidex so the app can use several DEX files.',
    repair: {
      kind: 'addGradleProperty',
      describe: () => 'Enable multidex and native DEX handling.',
      apply: () => ({
        path: 'build.gradleProperties',
        value: { 'android.useAndroidX': 'true', 'android.enableJetifier': 'true' },
      }),
    },
    reversible: true,
  },

  /* ══════════════════ BUILD AND CACHE ══════════════════ */
  {
    id: 'GRADLE_CACHE_CORRUPT',
    category: 'build',
    confidence: 'high',
    match: any(
      /Could not read.*\.gradle\/caches/i,
      /Unexpected end of ZLIB input stream/i,
      /zip file is empty/i,
      /Failed to load native library|Version of [\w ]* is not the same/i,
    ),
    cause: 'A cached download or build output is damaged.',
    explanation: 'A half-finished download leaves a corrupt cache entry that every later build trips over.',
    repair: {
      kind: 'cleanCache',
      describe: () => 'Clear the Gradle cache entry for this build and download it again.',
      apply: () => ({ path: '__cleanCache', value: 'gradle' }),
    },
    reversible: true,
  },
  {
    id: 'CACHE_INVALID_WORKER',
    category: 'build',
    confidence: 'medium',
    match: any(/Gradle build cache.*corrupt/i, /Failed to load cache entry/i),
    cause: 'The build cache contains an entry that cannot be read.',
    explanation: 'Safe to clear; the build will simply take longer once.',
    repair: { kind: 'cleanCache', describe: () => 'Clear the build cache.', apply: () => ({ path: '__cleanCache', value: 'build' }) },
    reversible: true,
  },
  {
    id: 'ARTIFACT_NOT_PRODUCED',
    category: 'artifact',
    confidence: 'high',
    match: any(
      /Gradle reported success but no APK/i,
      /no such file.*\.apk/i,
      /artifact.*not found/i,
    ),
    cause: 'The build claimed success but produced no file.',
    explanation:
      'This is the exact case the zero-false-success rule exists for: a successful exit status is not the same as an artifact on disk.',
    repair: null,
    advice: ['Check that the assemble task actually ran.', 'Look for a filtering mistake in the output path.'],
  },

  /* ══════════════════ NODE AND WEB ══════════════════ */
  {
    id: 'NODE_MODULE_NOT_FOUND',
    category: 'node',
    confidence: 'medium',
    match: any(/Cannot find module ['"]([^'"]+)['"]/i, /ERR_MODULE_NOT_FOUND/i, /module not found.*Can't resolve/i),
    cause: 'A required package is missing.',
    explanation: 'Either it was never installed, or it is imported under a name that does not exist.',
    repair: null,
    advice: ['Install dependencies and try again.', 'If the name is a typo, the error names the exact module.'],
  },
  {
    id: 'NODE_VERSION_MISMATCH',
    category: 'node',
    confidence: 'high',
    match: any(/Unsupported engine/i, /The engine .?node.? is incompatible/i, /requires Node(?:\.js)? >=?\s*(\d+)/i),
    cause: 'The installed Node version does not satisfy the project.',
    explanation: 'Pinning Node 20 avoids this entirely.',
    repair: null,
    advice: [
      'Pin Node 20 for the build; a pinned version is what makes a build reproducible.',
      'Check the engines field in package.json against the version the build machine is using.',
    ],
  },
  {
    id: 'SYNTAX_ERROR_GENERATED',
    category: 'web',
    confidence: 'high',
    match: any(/SyntaxError: Unexpected token/i, /Uncaught SyntaxError/i, /Parsing error/i),
    cause: 'A file contains invalid syntax.',
    explanation:
      'In a generated project this means the generator produced malformed output, which is a bug in the generator rather than in the project.',
    repair: null,
    advice: ['Regenerate and compare.', 'Report the exact file and line; a deterministic generator should never emit invalid syntax.'],
  },

  /* ══════════════════ SUPABASE, RLS AND AUTH ══════════════════ */
  {
    id: 'RLS_PERMISSION_DENIED',
    category: 'rls',
    confidence: 'high',
    match: any(
      /new row violates row-level security policy/i,
      /permission denied for (?:table|relation) (\w+)/i,
      /row-level security.*violat/i,
      /insufficient privilege/i,
    ),
    cause: 'A database query was blocked by row-level security.',
    explanation:
      'RLS is working correctly. The row is not visible to this user, or no policy grants the requested operation. Never disable RLS to make this go away.',
    repair: null,
    advice: [
      'Check that a policy exists for this operation (select, insert, update, delete) on this table.',
      'Confirm the policy\'s USING expression matches the row you expect to reach.',
      'Verify the user is signed in and their token carries the right claims.',
    ],
  },
  {
    id: 'RLS_NO_POLICY',
    category: 'rls',
    confidence: 'high',
    match: any(/rls_enabled_no_policy/i, /relation .* has row level security enabled but no policies/i, /no policy exists/i),
    cause: 'A table has row-level security enabled but no policies, so nobody can read it.',
    explanation: 'This is the strictest state: every request is refused. It is safe, but usually unintended.',
    repair: null,
    advice: ['Add a policy for each operation the app needs.', 'Never turn RLS off to fix it.'],
  },
  {
    id: 'SERVICE_ROLE_IN_CLIENT',
    category: 'rls',
    confidence: 'high',
    match: any(/service_role/i),
    cause: 'A service role key appears somewhere it should not.',
    explanation:
      'The service role key bypasses row-level security completely. If it reaches a browser, any visitor can read and write the entire database.',
    repair: null,
    advice: [
      'Move the privileged call into a server-side function.',
      'Rotate the key immediately, because it must be treated as already leaked.',
      'Only the public anon key belongs in client code, and even that is protected solely by RLS.',
    ],
  },
  {
    id: 'AUTH_REDIRECT_MISMATCH',
    category: 'auth',
    confidence: 'medium',
    match: any(/redirect_uri_mismatch/i, /redirect.*not allowed/i, /This redirect URI is not allowed/i),
    cause: 'The sign-in redirect address is not registered.',
    explanation: 'Identity providers only redirect to addresses that were registered in advance. This is enforced by them, not by your app.',
    repair: null,
    advice: ['Add the exact redirect address in the provider console.', 'For Android, also register the signing certificate fingerprint.'],
  },
  {
    id: 'GOOGLE_SIGNIN_SHA_MISMATCH',
    category: 'auth',
    confidence: 'high',
    match: any(/ApiException: 10/i, /DEVELOPER_ERROR/i, /sign_in_failed/i, /12500/i),
    cause: 'Google Sign-In is refusing the app because its signing fingerprint is not registered.',
    explanation:
      'Google identifies an Android app by package name plus signing certificate fingerprint. A new keystore means a new fingerprint, so sign-in stops working even though nothing else changed.',
    repair: null,
    advice: [
      'Add the SHA-1 and SHA-256 of the signing key in the provider console.',
      'If the key changed unexpectedly, that is worth investigating first — a keystore should never change by accident.',
    ],
  },

  /* ══════════════════ NETWORK AND DEVICE ══════════════════ */
  {
    id: 'NETWORK_OFFLINE',
    category: 'network',
    confidence: 'high',
    match: any(/ENOTFOUND/i, /EAI_AGAIN/i, /Could not resolve host/i, /getaddrinfo/i, /network is unreachable/i, /ECONNREFUSED/i),
    cause: 'A network request could not reach its destination.',
    explanation: 'The build machine or device has no working connection to the address being requested.',
    repair: null,
    advice: ['Check the address and the connection.', 'If this is a build dependency, a cache may let the build proceed offline.'],
  },
  {
    id: 'CLEARTEXT_BLOCKED',
    category: 'network',
    confidence: 'high',
    match: any(/CLEARTEXT communication.*not permitted/i, /Cleartext HTTP traffic to .* not permitted/i),
    cause: 'The app tried to use plain HTTP, which modern Android blocks by default.',
    explanation:
      'Blocking cleartext is correct and should stay on. The right fix is to use HTTPS, or to permit one specific domain if it genuinely has no HTTPS.',
    repair: null,
    advice: [
      'Use https:// for this address.',
      'Only if the domain truly has no HTTPS, allow cleartext for that one domain in the network security config rather than turning it on everywhere.',
    ],
  },
  {
    id: 'EMULATOR_NO_KVM',
    category: 'device',
    confidence: 'high',
    match: any(/ProbeKVM.*doesn.t have permissions/i, /-accel off/i, /KVM is not available/i, /emulator: ERROR: x86.*requires hardware acceleration/i),
    cause: 'The emulator fell back to software acceleration, which is roughly a hundred times slower.',
    explanation:
      'Without KVM the emulator either takes 15 minutes to boot or never finishes, which looks like a test failure but is a missing permission.',
    repair: {
      kind: 'engineStep',
      describe: () => 'Grant KVM access before starting the emulator.',
      apply: () => ({ path: 'build.device.kvm', value: true }),
    },
    reversible: true,
  },
  {
    id: 'EMULATOR_BOOT_TIMEOUT',
    category: 'device',
    confidence: 'medium',
    match: any(/device offline/i, /Timed out waiting for device/i, /boot_completed/i, /adb: device unauthorized/i),
    cause: 'The emulator did not finish booting in time.',
    explanation: 'This is almost always a consequence of software acceleration rather than a fault in the app.',
    repair: null,
    advice: ['Confirm KVM is available.', 'Increase the boot timeout before suspecting the app.'],
  },
  {
    id: 'APP_NOT_INSTALLED',
    category: 'device',
    confidence: 'high',
    match: any(/INSTALL_FAILED_([A-Z_]+)/i),
    cause: 'The device refused to install the APK.',
    explanation: 'The specific INSTALL_FAILED code names the reason.',
    repair: null,
    advice: [
      'INSTALL_FAILED_UPDATE_INCOMPATIBLE: an app with the same package name but a different signature is installed. Uninstall it first.',
      'INSTALL_FAILED_INSUFFICIENT_STORAGE: the device is full.',
      'INSTALL_FAILED_OLDER_SDK: the device is older than this app\'s minimum Android version.',
    ],
  },

  /* ══════════════════ SPECIFICATION ══════════════════ */
  {
    id: 'SPEC_BLOCKED',
    category: 'spec',
    confidence: 'high',
    match: any(/Refusing to generate/i, /BLOCKED/i, /blocking problem/i),
    cause: 'The project specification did not pass validation.',
    explanation: 'A specification that cannot produce a working app is refused before a compiler is ever started.',
    repair: null,
    advice: ['Run the validator and apply the fixes it offers; every finding names the exact field.'],
  },
];

/** Return the categories in a stable display order. */
export function categoryList() {
  return Object.entries(CATEGORIES).map(([id, c]) => ({ id, ...c }));
}
