/**
 * 🐙 AppKaro GitHub engine helpers — यूज़र के repo में auto-provision + builds (T1)
 *
 *  · ensureRepo(token): यूज़र के account में `appkaro-builds` repo + workflow auto-create
 *  · dispatch/findRun/downloadArtifact: किसी भी repo पर (यूज़र quota = यूज़र token)
 *
 * Workflow एक ही file से boot होता है — wrapper-template को template repo से
 * curl करके लाता है, इसलिए provisioning में सिर्फ़ 1 file डालनी पड़ती है।
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TEMPLATE_REPO = process.env.TEMPLATE_REPO || 'appkaro-apps/appkaro';
const USER_REPO_NAME = 'appkaro-builds';

/* यूज़र repo में डालने वाला single-file workflow */
function userWorkflowYml() {
  return `name: appkaro-build
run-name: appkaro-\${{ inputs.build_id }}
on:
  workflow_dispatch:
    inputs:
      build_id:     { required: true,  type: string }
      app_name:     { required: true,  type: string }
      package_id:   { required: true,  type: string }
      start_url:    { required: true,  type: string }
      theme_color:  { required: false, default: "#6C5CE7", type: string }
      icon_url:     { required: false, default: "", type: string }
      permissions:  { required: false, default: "NOTIFICATIONS", type: string }
      cleartext:    { required: false, default: "false", type: string }
concurrency:
  group: appkaro-\${{ inputs.build_id }}
permissions: { contents: read }
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Fetch AppKaro wrapper template
        run: |
          mkdir wrapper-template
          curl -fsSL "https://github.com/${TEMPLATE_REPO}/archive/refs/heads/main.tar.gz" \\
            | tar xz -C wrapper-template --strip-components=2 "*/wrapper-template"
      - name: Configure (permissions, color, icon)
        run: bash wrapper-template/ci/configure.sh "\${{ inputs.permissions }}" "\${{ inputs.theme_color }}" "\${{ inputs.icon_url }}"
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - name: Android SDK components (runner प्रीइंस्टॉल्ड SDK)
        run: |
          set -e
          export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/cmdline-tools/bin:$PATH"
          yes | sdkmanager --licenses > /dev/null 2>&1 || true
          sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools" || true
      - uses: gradle/actions/setup-gradle@v4
        with: { gradle-version: "8.7" }
      - name: Gradle build cache
        uses: actions/cache@v4
        with:
          path: |
            ~/.gradle/caches
            ~/.gradle/wrapper
          key: gradle-\${{ runner.os }}-\${{ hashFiles('wrapper-template/**/*.gradle*', 'wrapper-template/gradle.properties') }}
          restore-keys: |
            gradle-\${{ runner.os }}-
      - name: Build unsigned APK + AAB
        working-directory: wrapper-template
        run: |
          gradle :app:assembleRelease :app:bundleRelease --no-daemon --build-cache \\
            -PpackageId="\${{ inputs.package_id }}" -PappName="\${{ inputs.app_name }}" \\
            -PstartUrl="\${{ inputs.start_url }}" -PthemeColor="\${{ inputs.theme_color }}" \\
            -Pcleartext="\${{ inputs.cleartext }}"
      - name: Collect outputs
        run: |
          mkdir -p out
          find wrapper-template/app/build/outputs -name "*.apk" -exec cp {} "out/appkaro-\${{ inputs.build_id }}-unsigned.apk" \\;
          find wrapper-template/app/build/outputs -name "*.aab" -exec cp {} "out/appkaro-\${{ inputs.build_id }}-unsigned.aab" \\;
      - uses: actions/upload-artifact@v4
        with:
          name: build-\${{ inputs.build_id }}
          path: out/*
          retention-days: 2
`;
}

/* ---------------- api helpers ---------------- */
async function ghFetch(token, p, opts = {}) {
  return fetch('https://api.github.com' + p, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'appkaro-server',
      ...(opts.headers || {}),
    },
  });
}

async function getLogin(token) {
  const j = await (await ghFetch(token, '/user')).json();
  return j.login;
}

/**
 * यूज़र के account में appkaro-builds repo ensure करो (+workflow file)।
 * @returns full_name (owner/repo)
 */
async function ensureRepo(token) {
  const login = await getLogin(token);
  if (!login) throw new Error('github login नहीं मिला');
  const full = `${login}/${USER_REPO_NAME}`;

  let res = await ghFetch(token, `/repos/${full}`);
  if (res.status === 404) {
    res = await ghFetch(token, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: USER_REPO_NAME,
        /* public ⇒ Actions के minutes unlimited मुफ़्त; repo में कोई secret नहीं
           (signing AppKaro server पर होती है) */
        private: false,
        auto_init: false,
        description: '⚡ AppKaro builds — ye repo AppKaro ne automatically banaya hai. Isme sirf build workflow hai, koi secret nahi.',
        has_issues: false, has_projects: false, has_wiki: false,
      }),
    });
    if (res.status !== 201) throw new Error('repo नहीं बन पाया: HTTP ' + res.status);
  }

  /* workflow file डालो/अपडेट करो (पहले existing sha चाहिए होता है update में) */
  const wfPath = '.github/workflows/appkaro-build.yml';
  const enc = Buffer.from(userWorkflowYml()).toString('base64');
  let sha;
  const cur = await ghFetch(token, `/repos/${full}/contents/${encodeURIComponent(wfPath)}`);
  if (cur.status === 200) sha = (await cur.json()).sha;
  const put = await ghFetch(token, `/repos/${full}/contents/${encodeURIComponent(wfPath)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: '⚡ AppKaro build workflow (auto-installed)',
      content: enc, ...(sha ? { sha } : {}),
    }),
  });
  if (put.status !== 200 && put.status !== 201) throw new Error('workflow install fail: HTTP ' + put.status);
  return full;
}

/** build dispatch — किसी भी repo (user या central pool) पर */
async function dispatch(repo, token, inputs) {
  const res = await ghFetch(token, `/repos/${repo}/actions/workflows/appkaro-build.yml/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  /* central pool का file नाम build-apk.yml भी हो सकता है — fallback */
  if (res.status === 404 || res.status === 422) {
    const res2 = await ghFetch(token, `/repos/${repo}/actions/workflows/build-apk.yml/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    if (res2.status !== 204) throw new Error('dispatch fail: HTTP ' + res2.status);
    return;
  }
  if (res.status !== 204) throw new Error('dispatch fail: HTTP ' + res.status);
}

async function findRun(repo, token, buildId) {
  const res = await ghFetch(token, `/repos/${repo}/actions/runs?per_page=30`);
  if (res.status !== 200) return null;
  const j = await res.json();
  return (j.workflow_runs || []).find(r => r.name === `appkaro-${buildId}`) || null;
}

async function downloadArtifact(repo, token, runId, destDir) {
  const res = await ghFetch(token, `/repos/${repo}/actions/runs/${runId}/artifacts`);
  const j = await res.json();
  const art = (j.artifacts || []).find(a => a.name.startsWith('build-'));
  if (!art) throw new Error('artifact नहीं मिला');
  const dl = await ghFetch(token, `/repos/${repo}/actions/artifacts/${art.id}/zip`);
  const buf = Buffer.from(await dl.arrayBuffer());
  fs.mkdirSync(destDir, { recursive: true });   // mkdir पहले — वरना zip लिखते ही ENOENT
  const zipPath = path.join(destDir, runId + '.zip');
  fs.writeFileSync(zipPath, buf);
  await new Promise((ok, bad) =>
    execFile('unzip', ['-o', zipPath, '-d', destDir], e => (e ? bad(e) : ok())));
  fs.unlinkSync(zipPath);
  return fs.readdirSync(destDir);
}

module.exports = { ensureRepo, dispatch, findRun, downloadArtifact, USER_REPO_NAME };
