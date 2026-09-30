import fs from 'node:fs';
import path from 'node:path';
/**
 * ANDROID PROJECT GENERATOR
 * =========================
 * spec (validated)  ->  a complete, buildable Android project.
 *
 * Guarantees:
 *   DETERMINISTIC   same spec => byte-identical output. Every file is written
 *                   from a fixed list in a fixed order; no timestamps, no
 *                   randomness, no environment leakage.
 *   MINIMAL         the manifest contains only the permissions the enabled
 *                   capabilities actually require.
 *   FAIL-CLOSED     signing never silently invents a keystore.
 *   SELF-DESCRIBING every generated file says it is generated, and where the
 *                   truth lives (the project specification).
 */

import { derivePermissions } from '../capability/permissions.mjs';
import { generateIcons } from './icon.mjs';
import { mainActivityJava, schemeRouterJava, jsBridgeJava } from './java.mjs';
import { generateNativeScreens } from './native.mjs';
import { lintGeneratedJava } from './lint-java.mjs';

/* ------------------------------------------------------------------ *
 * Toolchain profiles — verified compatibility pairs.
 * `compileSdk 36` is required by Google Play for new apps and updates since
 * 31 Aug 2026, and it needs a modern AGP because AGP 8.4 stops at SDK 34.
 * ------------------------------------------------------------------ */
export { TOOLCHAIN_PROFILES } from '../spec/toolchain.mjs';

import { TOOLCHAIN_PROFILES as TC } from '../spec/toolchain.mjs';

function walkDir(root, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkDir(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, "\\'");
}

/** The capability -> bridge-method map. Keeps the bridge minimal. */
function bridgeMethodsFor(caps) {
  const m = [];
  if (caps.includes('share')) m.push('share');
  if (caps.includes('clipboard')) m.push('copy');
  if (caps.includes('vibration')) m.push('vibrate');
  return m;
}

/**
 * @param {object} spec validated project specification
 * @param {{profile?:string, generatedBy?:string}} [opts]
 * @returns {{ok:boolean, errors:string[], files:Array<{path:string,data:Buffer|string}>,
 *            report:object, meta:object}}
 */
export function generateAndroidProject(spec, opts = {}) {
  const webDir = opts.webDir || null;
  const errors = [];
  const id = spec.identity || {};
  const a = spec.android || {};
  const app = spec.app || {};
  const build = spec.build || {};
  const theme = spec.theme || {};

  if (!id.packageName) errors.push('identity.packageName is required');
  if (!app.webview?.startUrl && app.mode !== 'native-screens') errors.push('a start URL is required');
  if (errors.length) return { ok: false, errors, files: [], report: {}, meta: {} };

  const profileName = opts.profile || (a.compileSdk >= 35 ? 'modern' : 'legacy');
  const tc = { ...TC[profileName], ...(build.toolchain || {}) };
  const templateVersion = '1.0.0';

  const packageName = id.packageName;
  const appName = id.appName || 'App';
  const caps = spec.capabilities || [];
  const { permissions, dropped } = derivePermissions(spec);

  // A project with screens is a NATIVE app; a project without them is a WebView
  // shell. Exactly one of the two UI stacks is generated, so an app never ships
  // a whole unused UI layer.
  const nativeScreens = (spec.screens || []).length > 0;

  const hasFiles = caps.includes('files');
  const hasCamera = caps.includes('barcode') || caps.includes('camera');
  const hasLocation = caps.includes('location');
  const hasNotifications = caps.includes('notifications');
  const hasBrowser = app.webview?.externalLinks === 'custom-tab' || true; // custom tabs used by the router

  const bridgeMethods = bridgeMethodsFor(caps);
  const hasBridge = bridgeMethods.length > 0 && spec.app?.javascriptEnabled !== false;

  const allowedSchemes = (spec.deepLinks?.allowedSchemes || ['https', 'tel', 'mailto']);
  const allowedHosts = app.webview?.allowedHosts || [];

  const javaCfg = {
    packageName, appName,
    startUrl: app.webview?.localAsset
      ? `https://appassets.androidplatform.net/assets/www/${app.webview.localAsset.replace(/^\/+/, '')}`
      : (app.webview?.startUrl || 'about:blank'),
    allowedHosts,
    javascriptEnabled: app.webview?.javascriptEnabled !== false,
    domStorage: app.webview?.domStorage !== false,
    zoom: !!app.webview?.zoom,
    forceDark: app.webview?.forceDark === true,
    acceptLanguage: app.webview?.acceptLanguage || null,
    canvasBackground: app.webview?.canvasBackground || (app.webview?.forceDark === true ? (theme.background || '#0B1020') : '#FFFFFF'),
    fileUploads: !!app.webview?.fileUploads,
    externalLinks: app.webview?.externalLinks || 'custom-tab',
    offlinePage: app.webview?.offlinePage !== false,
    splashEnabled: app.splash?.enabled !== false,
    splashColor: app.splash?.backgroundColor || theme.background || '#0B1020',
    hasNotifications, hasCamera, hasLocation, hasFiles, hasBridge, bridgeMethods,
    orientation: a.orientation || 'portrait',
    cleartext: a.cleartextTraffic === true,
    screenSecurity: caps.includes('screenSecurity'),
  };

  const files = [];
  const R = (p, data) => files.push({ path: `android/app/src/main/res/${p}`, data });

  /* ---------------- gradle ---------------- */
  files.push({ path: 'android/settings.gradle', data: `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${slug(appName)}"
include ':app'
` });

  files.push({ path: 'android/build.gradle', data: `// Generated by Project1 Studio — edit the project specification, not this file.
// Toolchain: AGP ${tc.agp} / Gradle ${tc.gradle} / Build Tools ${tc.buildTools} / JDK ${tc.jdk}
plugins {
    id 'com.android.application' version '${tc.agp}' apply false
}
` });

  files.push({ path: 'android/gradle.properties', data: `# Generated by Project1 Studio.
# Heap is deliberately modest so ordinary machines and 2-core CI runners can build this.
org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=true

android.useAndroidX=true
android.nonTransitiveRClass=true
` });

  const signingBlock = buildSigningBlock(spec);

  const deps = [
    "    implementation 'androidx.appcompat:appcompat:1.7.0'",
    "    implementation 'com.google.android.material:material:1.12.0'",
    "    implementation 'androidx.constraintlayout:constraintlayout:2.1.4'",
    "    implementation 'androidx.swiperefreshlayout:swiperefreshlayout:1.1.0'",
    // androidx.webkit provides WebSettingsCompat, which handles the
    // algorithmic-darkening API difference between Android versions for us.
    "    implementation 'androidx.webkit:webkit:1.12.1'",
  ];
  if (hasBrowser) deps.push("    implementation 'androidx.browser:browser:1.8.0'");
  if (hasFiles) deps.push("    implementation 'androidx.core:core:1.13.1'");
  if (caps.includes('barcode')) deps.push("    implementation 'androidx.camera:camera-core:1.3.4'");

  files.push({ path: 'android/app/build.gradle', data: `// Generated by Project1 Studio from the project specification.
// Deterministic: regenerating from the same specification produces this exact file.
plugins {
    id 'com.android.application'
}
${gitVersionPrelude(spec)}
android {
    namespace '${packageName}'
    compileSdk ${a.compileSdk || 36}
    buildToolsVersion '${tc.buildTools}'

    defaultConfig {
        applicationId "${packageName}"
        minSdk ${a.minSdk || 24}
        targetSdk ${a.targetSdk || 36}
${versionBlock(spec)}        versionNameSuffix ''
${(build.outputs || []).includes('abiSplits') ? '' : ''}    }
${signingBlock}
    buildTypes {
        release {
${(spec.signing || {}).mode === 'secret-store' ? '            signingConfig signingConfigs.release\n' : ''}            minifyEnabled ${build.minify ? 'true' : 'false'}
            shrinkResources ${build.minify ? 'true' : 'false'}
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
        debug {
            applicationIdSuffix ''
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_${tc.jdk}
        targetCompatibility JavaVersion.VERSION_${tc.jdk}
    }

    // BuildConfig is OFF by default since AGP 8, so it must be requested
    // explicitly. Without this the generated App.java cannot read BuildConfig.DEBUG
    // and the build fails with "cannot find symbol".
    buildFeatures {
        buildConfig true
    }

    packagingOptions {
        resources.excludes += ['META-INF/*.kotlin_module', 'DebugProbesKt.bin']
    }

    lint {
        abortOnError true
        checkReleaseBuilds false
    }
}

dependencies {
${deps.join('\n')}
}
` });

  files.push({ path: 'android/app/proguard-rules.pro', data: `# Generated by Project1 Studio.
# Keep the WebView bridge reachable by name — R8 would otherwise rename the
# methods that JavaScript calls and the bridge would silently stop working.
${hasBridge ? `-keepclassmembers class ${packageName}.JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class ${packageName}.JsBridge { *; }
` : '# No JavaScript bridge is enabled for this project.\n'}-keepclassmembers class * extends android.webkit.WebViewClient { *; }
-dontwarn android.webkit.**
` });

  /* ---------------- manifest ---------------- */
  const permLines = permissions.map((p) => {
    const attr = p.attrs.maxSdkVersion ? ` android:maxSdkVersion="${p.attrs.maxSdkVersion}"` : '';
    return `    <!-- ${p.reason} (feature: ${p.feature}) -->\n    <uses-permission android:name="${p.name}"${attr} />`;
  }).join('\n');

  const features = [];
  if (hasCamera) features.push('    <uses-feature android:name="android.hardware.camera" android:required="false" />');

  const dl = spec.deepLinks || {};
  const deepLinkFilter = (dl.customScheme || (dl.hosts || []).length)
    ? `
            <!-- Deep links. autoVerify is only set when real https hosts are
                 declared, because an unverified autoVerify filter fails silently. -->
            <intent-filter${(dl.hosts || []).length ? ' android:autoVerify="true"' : ''}>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
${dl.customScheme ? `                <data android:scheme="${esc(dl.customScheme)}" />\n` : ''}${(dl.hosts || []).map((h) => `                <data android:scheme="https" android:host="${esc(h)}" />`).join('\n')}
            </intent-filter>`
    : '';

  files.push({ path: 'android/app/src/main/AndroidManifest.xml', data: `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by Project1 Studio from the project specification.
     Permissions below are DERIVED from the enabled capabilities, not written by
     hand. ${permissions.length} permission(s), ${dropped.length} unnecessary one(s) removed. -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

${permLines}

${features.join('\n')}

    <application
        android:name=".App"
        android:allowBackup="${a.allowBackup === true ? 'true' : 'false'}"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:hardwareAccelerated="true"
        android:usesCleartextTraffic="${a.cleartextTraffic === true ? 'true' : 'false'}"${a.cleartextTraffic === true ? '' : '\n        android:networkSecurityConfig="@xml/network_security_config"'}
        android:theme="@style/Theme.${slug(appName).replace(/-/g, '')}">

        <activity
            android:name=".${nativeScreens ? 'NativeActivity' : 'MainActivity'}"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|density|uiMode"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${deepLinkFilter}
        </activity>
${hasFiles ? `
        <!-- Scoped file sharing. exported="false" means no other app can pull
             files out of this provider. -->
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
` : ''}    </application>

</manifest>
` });

  /* ---------------- java ---------------- */
  const p = packageName.replace(/\./g, '/');

  // SchemeRouter is generated either way: both UI stacks route external links,
  // and having one implementation is the point.
  files.push({ path: `android/app/src/main/java/${p}/SchemeRouter.java`, data: schemeRouterJava({ packageName, allowedSchemes }) });

  if (!nativeScreens) {
    files.push({ path: `android/app/src/main/java/${p}/MainActivity.java`, data: mainActivityJava(javaCfg) });
  }
  files.push({ path: `android/app/src/main/java/${p}/App.java`, data: `package ${packageName};

import android.app.Application;
import android.webkit.WebView;

/**
 * Generated by Project1 Studio.
 *
 * WebView debugging is enabled for debug builds only. Leaving it on in a
 * release APK would let anyone with a USB cable attach to the live WebView and
 * read the page, the cookies and the DOM.
 */
public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }
}
` });

  if (hasBridge && !nativeScreens) {
    files.push({ path: `android/app/src/main/java/${p}/JsBridge.java`, data: jsBridgeJava({ packageName, bridgeMethods }) });
  }

  /* ---------------- resources ---------------- */
  const themeName = slug(appName).replace(/-/g, '');
  R('values/strings.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Generated by Project1 Studio. -->
    <string name="app_name">${esc(appName)}</string>
</resources>
`);

  R('values/colors.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="brand_primary">${theme.primary || '#2563EB'}</color>
    <color name="brand_on_primary">${theme.onPrimary || '#FFFFFF'}</color>
    <color name="brand_background">${theme.background || '#0B1020'}</color>
    <color name="brand_surface">${theme.surface || '#151B2E'}</color>
    <color name="brand_on_surface">${theme.onSurface || '#E8ECF8'}</color>
    <color name="brand_accent">${theme.accent || '#22D3EE'}</color>
</resources>
`);

  R('values/themes.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- Generated from the project theme tokens. -->
    <style name="Theme.${themeName}" parent="Theme.Material3.DayNight.NoActionBar">
        <item name="colorPrimary">@color/brand_primary</item>
        <item name="colorOnPrimary">@color/brand_on_primary</item>
        <item name="android:colorBackground">@color/brand_background</item>
        <item name="colorSurface">@color/brand_surface</item>
        <item name="colorOnSurface">@color/brand_on_surface</item>
        <item name="android:statusBarColor" tools:targetApi="l">@color/brand_background</item>
        <item name="android:navigationBarColor" tools:targetApi="l">@color/brand_background</item>
        <item name="android:windowBackground">@color/brand_background</item>
    </style>
</resources>
`);

  R('values-v27/themes.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.${themeName}" parent="Theme.Material3.DayNight.NoActionBar">
        <item name="colorPrimary">@color/brand_primary</item>
        <item name="colorOnPrimary">@color/brand_on_primary</item>
        <item name="android:colorBackground">@color/brand_background</item>
        <item name="colorSurface">@color/brand_surface</item>
        <item name="colorOnSurface">@color/brand_on_surface</item>
        <item name="android:statusBarColor">@color/brand_background</item>
        <item name="android:navigationBarColor">@color/brand_background</item>
        <item name="android:windowLightNavigationBar">${(theme.statusBarStyle || 'dark') === 'dark' ? 'false' : 'true'}</item>
    </style>
</resources>
`);

  if (a.cleartextTraffic !== true) {
    R('xml/network_security_config.xml', `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by Project1 Studio.
     Cleartext traffic is disabled app-wide. If a legacy domain genuinely needs
     plain HTTP, add a scoped <domain-config cleartextTrafficPermitted="true">
     for that one domain rather than turning it on globally. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`);
  }

  if (hasFiles) {
    R('xml/file_paths.xml', `<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="cache" path="." />
    <files-path name="files" path="." />
</paths>
`);
  }

  // assets/ lives beside res/, not inside it — putting it under res/ makes the
  // resource merger reject the unknown directory.
  if (!nativeScreens) {
    files.push({
      path: 'android/app/src/main/assets/offline.html',
      data: offlinePageHtml(appName, theme),
    });
  }

  /* ---------------- icons ---------------- */
  const icons = generateIcons(spec);
  for (const f of icons.files) files.push({ path: `android/app/src/main/res/${f.path}`, data: f.data });

  /* ---------------- bundled web assets ---------------- */
  const bundled = [];
  if (app.webview?.localAsset && webDir && fs.existsSync(webDir)) {
    for (const rel of walkDir(webDir)) {
      files.push({
        path: `android/app/src/main/assets/www/${rel}`,
        data: fs.readFileSync(path.join(webDir, rel)),
      });
      bundled.push(rel);
    }
  }
  if (app.webview?.localAsset && bundled.length === 0) {
    errors.push(`app.webview.localAsset is "${app.webview.localAsset}" but no web assets were found` +
                (webDir ? ` in ${webDir}` : ' (no web directory was supplied)'));
    return { ok: false, errors, files: [], report: {}, meta: {} };
  }

  /* ---------------- native screens ---------------- */
  // When a project has screens, the native renderer and its data ship instead
  // of the WebView shell. Only one of the two is ever generated, so an app
  // never carries a whole unused UI stack.
  if (nativeScreens) {
    const nat = generateNativeScreens(spec);
    if (!nat.ok) { errors.push(...nat.errors); return { ok: false, errors, files: [], report: {}, meta: {} }; }
    for (const f of nat.files) files.push(f);
  }

  /* ---------------- generated-Java lint ---------------- */
  // Runs before any compiler. Catching an escaping mistake here costs a
  // millisecond; catching it in Gradle costs half a minute and a confusing
  // message, and catching it in a user's hands is not acceptable at all.
  const lint = lintGeneratedJava(files);
  if (!lint.ok) {
    for (const e of lint.errors) {
      errors.push(`generated Java would not compile — ${e.file}:${e.line} [${e.kind}] ${e.message}`);
    }
    return { ok: false, errors, files: [], report: {}, meta: {} };
  }

  /* ---------------- determinism: fixed order ---------------- */
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  const report = {
    generatedAt: null, // deliberately absent: keeps output byte-identical
    templateVersion,
    toolchain: { profile: profileName, ...tc },
    packageName,
    appName,
    capabilities: [...caps].sort(),
    permissions: permissions.map((x) => ({ name: x.short, why: x.reason, feature: x.feature })),
    permissionsDropped: dropped,
    // A designed app has no JavaScript bridge at all: there is no web page for
    // one to talk to. Reporting it as present would be a claim about the build
    // that is not true of the build.
    bridgeEnabled: nativeScreens ? false : hasBridge,
    bridgeMethods: nativeScreens ? [] : bridgeMethods,
    iconMark: icons.mark,
    bundledAssets: bundled,
    /* What kind of app this is and what starts it. Anything that has to launch
       or inspect the installed app reads these instead of assuming, so a
       designed app and a website app cannot be confused for each other. */
    architecture: nativeScreens ? 'native-screens' : (spec.app?.mode || 'webview'),
    launcherActivity: packageName + (nativeScreens ? '.NativeActivity' : '.MainActivity'),
    screens: nativeScreens ? {
      count: (spec.screens || []).length,
      components: countScreenComponents(spec),
      actions: countScreenActions(spec),
    } : null,
    fileCount: files.length,
  };

  const meta = {
    slug: slug(appName),
    templateVersion,
    profile: profileName,
    toolchain: tc,
    bridgeEnabled: nativeScreens ? false : hasBridge,
    architecture: nativeScreens ? 'native-screens' : (spec.app?.mode || 'webview'),
    launcherActivity: packageName + (nativeScreens ? '.NativeActivity' : '.MainActivity'),
    permissionCount: permissions.length,
    bundledAssetCount: bundled.length,
  };

  return { ok: true, errors: [], files, report, meta };
}

/** How many components are in the design, for the build report. */
function countScreenComponents(spec) {
  let n = 0;
  const walk = (list) => {
    for (const node of list || []) { if (!node) continue; n++; walk(node.children); }
  };
  for (const screen of spec.screens || []) walk(screen.components);
  return n;
}

/** How many taps in the design actually do something. */
function countScreenActions(spec) {
  let n = 0;
  const walk = (list) => {
    for (const node of list || []) {
      if (!node) continue;
      n += Object.values(node.events || {}).filter((a) => a && a.kind && a.kind !== 'none').length;
      walk(node.children);
    }
  };
  for (const screen of spec.screens || []) walk(screen.components);
  return n;
}

/* ------------------------------------------------------------------ */
function versionBlock(spec) {
  const id = spec.identity || {};
  if (id.versionStrategy === 'git-commit-count') {
    return `        // versionCode is the repository commit count (see computedVersionCode
        // above). It can never go backwards and can never be forgotten.
        versionCode computedVersionCode
`;
  }
  return `        versionCode ${id.versionCode || 1}
        versionName "${id.versionName || '1.0.0'}"
`;
}

/**
 * Version-from-git prelude.
 *
 * Replicates the one genuinely excellent idea from the existing build pipeline:
 * versionCode is the repository's commit count, and if git cannot be read the
 * build FAILS. A silent fallback would ship a stale version number, which the
 * Play Store rejects — and a wrong version is worse than a failed build.
 */
function gitVersionPrelude(spec) {
  if ((spec.identity || {}).versionStrategy !== 'git-commit-count') return '';
  return `
// ── versionCode = total commits in this repository ──────────────────────
// Never bump it by hand. If git is unavailable this throws instead of falling
// back to a stale number (GitHub Actions must check out with fetch-depth: 0).
def gitCommitCount() {
    def count = -1
    try {
        def proc = 'git rev-list --count HEAD'.execute(null, project.rootDir)
        def outBuf = new ByteArrayOutputStream()
        def errBuf = new ByteArrayOutputStream()
        proc.consumeProcessOutput(outBuf, errBuf)
        proc.waitFor()
        if (proc.exitValue() == 0) {
            count = new String(outBuf.toByteArray(), 'UTF-8').trim().toInteger()
        } else {
            logger.error('[auto-version] git rev-list failed: ' + new String(errBuf.toByteArray(), 'UTF-8').trim())
        }
    } catch (Exception e) {
        logger.error('[auto-version] git unreadable: ' + e.message)
    }
    if (count < 1) {
        throw new GradleException(
            '[auto-version] git commit count unavailable, so the build is stopped. ' +
            'A shallow checkout must be replaced with fetch-depth: 0.')
    }
    return count
}

def computedVersionCode = gitCommitCount()
`;
}

function buildSigningBlock(spec) {
  const s = spec.signing || {};
  if (s.mode === 'none') return '';
  if (s.mode === 'debug') {
    return `
    // Debug signing only. Use signing.mode = "secret-store" for a release build.
`;
  }
  return `
    // Signing credentials come from the build engine's secret store, never from
    // the repository. fail-closed = ${s.failClosed !== false ? 'ON' : 'OFF'}:
    // a missing keystore FAILS the build instead of generating a new one.
    // Generating a new key silently changes the app's identity, which
    // permanently breaks Google Sign-In and every future update.
    signingConfigs {
        release {
            def storePath = System.getenv("KEYSTORE_PATH")
            if (storePath == null || storePath.isEmpty()) {
                throw new GradleException(
                    "Signing is configured for a secret store but KEYSTORE_PATH is not set. " +
                    "Set the keystore secret in the build engine, or switch signing.mode to debug.")
            }
            storeFile file(storePath)
            storePassword System.getenv("KEYSTORE_PASSWORD") ?: ""
            keyAlias System.getenv("KEY_ALIAS") ?: ""
            keyPassword System.getenv("KEY_PASSWORD") ?: ""
        }
    }
`;
}

function offlinePageHtml(appName, theme) {
  const bg = theme.background || '#0B1020';
  const fg = theme.onSurface || '#E8ECF8';
  const accent = theme.accent || '#22D3EE';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Offline</title>
<style>
  :root { color-scheme: dark light; }
  html,body { height:100%; margin:0; }
  body {
    display:flex; align-items:center; justify-content:center; text-align:center;
    background:${bg}; color:${fg};
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:24px;
  }
  .card { max-width:22rem; }
  .dot { width:56px; height:56px; margin:0 auto 20px; border-radius:16px;
         background:${accent}; opacity:.18; }
  h1 { font-size:1.125rem; margin:0 0 8px; font-weight:600; }
  p { margin:0; opacity:.75; font-size:.9375rem; line-height:1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="dot"></div>
    <h1>You are offline</h1>
    <p>${esc(appName)} needs a connection for this screen. Reconnect, then tap retry in the app.</p>
  </div>
</body>
</html>
`;
}

export { slug };
