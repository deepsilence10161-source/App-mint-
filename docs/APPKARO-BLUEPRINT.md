# ⚡ AppKaro — Website se Android App, 60 second me

> Working title **AppKaro** (नाम बदलना हो तो बदल सकते हैं)।
> AppMint से **100x बेहतर** — यही हमारा flagship प्रोडक्ट है।
> 100% original code. किसी का code/UI/asset copied नहीं है।

---

## 1. विज़न

कोई भी अपनी website का URL डाले → नाम, आइकन, रंग चुने → **60–90 सेकंड में साइन की हुई APK + AAB** डाउनलोड करे।
यूज़र को GitHub, SDK, coding — **कुछ भी सेटअप नहीं करना**। सब कुछ पर्दे के पीछे।

---

## 2. AppMint से 100x कैसे? (उनके audit से सीधी रणनीति)

उनकी APK का deep audit हमारा **product blueprint** है — उनका हर बग = हमारा feature:

| # | AppMint की सच्चाई (audit से, proof सहित) | AppKaro की डिज़ाइन |
|---|---|---|
| 1 | 130MB app + फोन पर 49MB node runtime → धीमा | Cloud CI build → **यूज़र के फोन/browser पर 0 load** |
| 2 | deep links टूटे (assetlinks.json 404) | assetlinks **auto-generate + verify** |
| 3 | edge-to-edge zero — content status bar के पीछे | edge-to-edge + Material 3 + predictive back, **Day-1 से** |
| 4 | "Encrypted on device" झूठ — secrets plaintext | असली Android Keystore; server पर keystore **encrypted at rest** |
| 5 | cleartext + user-CA trust (MITM खतरा) | HTTPS-only default, cleartext opt-in **warning के साथ** |
| 6 | 36 permissions (camera/mic/location बिना काम के) | least-privilege: default सिर्फ़ INTERNET (+ notifications) |
| 7 | 3 जगह 3 अलग दाम | एक pricing, एक source of truth |
| 8 | smartrixlabs.com मृत, डमी फ़ोन नंबर | असली docs + status page + support |
| 9 | WebView mixed-content + universal file access | WebView hardened: `allowFileAccess=false`, mixed content BLOCK |
| 10 | billing सिर्फ़ `promax_yearly` (confusing) | साफ़ plans: Free / Pro / Lifetime |

---

## 3. 🤫 Invisible Build Engine (सबसे बड़ा कमाल)

यूज़र को **कभी पता नहीं चलेगा** कि पीछे GitHub CI है:

```
यूज़र (browser/app)
   │  सिर्फ़ form भरता है
   ▼
AppKaro Server (हमारा)  ←── GITHUB_TOKEN सिर्फ़ server के env में, कभी किसी file में नहीं
   │  queue → workflow_dispatch (inputs = config, कोई secret नहीं)
   ▼
GitHub Actions (हमारा central build repo)
   │  wrapper-template + config → APK + AAB (unsigned)
   ▼
AppKaro Server
   │  artifact download → per-user keystore से SIGN (keytool/apksigner)
   ▼
यूज़र को सिर्फ़ "Download APK ✨" दिखता है
```

**Security masterstroke:** signing server पर होती है (CI पर नहीं) → keystore कभी GitHub को दिखता ही नहीं।
Inputs में कोई secret नहीं जाता, इसलिए public repo चलेगा (logs public फिर भी safe)।

### Free-tier सच्चाई (ईमानदारी से)
| Engine | Limit | नोट |
|---|---|---|
| GitHub Actions (public repo) | व्यावहारिक रूप से unlimited* | *fair-use; build ~3–4 min |
| GitHub Actions (private) | 2000 min/mo | ~500 builds/mo |
| Plan B: Codemagic free | 500 build-min/mo | backup |
| Plan C: खुद का runner (₹400/mo VPS) | unlimited | scale पर |

Server में **DEMO mode** है: token न हो तब भी पूरा flow queue→build→ready simulate होता है, ताकि UI/UX आज से test हो सके।

---

## 4. Repo Layout

```
appkaro/
├── README.md                    ← यह file (master plan)
├── .github/workflows/
│   └── build-apk.yml            ← reusable CI workflow (config inputs → APK/AAB)
├── wrapper-template/            ← ★ flagship: modern Android WebView shell
│   ├── settings.gradle / build.gradle
│   ├── app/build.gradle         ← packageId/appName/url/theme सब gradle props से
│   ├── app/proguard-rules.pro
│   └── app/src/main/
│       ├── AndroidManifest.xml  ← secure defaults + <!-- EXTRA_PERMISSIONS --> marker
│       ├── java/com/appkaro/wrapper/MainActivity.kt
│       └── res/ (themes, colors, adaptive icon — कोई PNG ज़रूरी नहीं)
└── server/
    ├── index.js                 ← zero-dependency Node server (API + queue + CI dispatch + sign)
    └── public/index.html        ← attractive builder UI (dark, glassy, Hindi-first)
```

---

## 5. Wrapper Template — AppMint जहाँ हरा, हम वहाँ जीते

`MainActivity.kt` + manifest में (audit के 17 बगों को design-time पर ही खत्म):

- ✅ **Edge-to-edge** (`enableEdgeToEdge`) + status/nav icon contrast auto (theme color की luminance से)
- ✅ **SplashScreen API** + `enableOnBackInvokedCallback` (predictive back)
- ✅ Pull-to-refresh (SwipeRefreshLayout), top progress bar, offline **error + retry** screen
- ✅ File **upload** (`onShowFileChooser`) + **download** (DownloadManager, notification के साथ)
- ✅ `tel:`/`mailto:`/`intent:` links सही handle
- ✅ Security: `allowFileAccess=false`, `allowContentAccess=false`, mixed content **BLOCK**, cleartext off (opt-in warning), `allowBackup=false`, minify + shrinkResources
- ✅ Permissions **build-time पर inject** (`<!-- EXTRA_PERMISSIONS -->` marker) — default सिर्फ़ INTERNET
- ✅ JS Bridge `AppKaro` (`getAppVersion()`, `showToast()`) — AppMint जैसा `allowUniversalAccessFromFileURLs` जैसा खतरा नहीं
- ✅ minSdk 24 / targetSdk 35 (API 36 bump AGP update पर — TODO marked)

**कैसे build होता है (CI में):**
```bash
gradle :app:assembleRelease :app:bundleRelease \
  -PpackageId=com.mera.app -PappName="Mera App" \
  -PstartUrl=https://merasite.com -PthemeColor=#FF5722
```

---

## 6. AppMint Feature-Parity Checklist (सब होगा + extra)

| Feature | AppMint | AppKaro |
|---|---|---|
| URL → APK | ✅ | ✅ Phase 1 |
| AAB export | ✅ | ✅ Phase 1 |
| Custom name/icon/splash/color | ✅ | ✅ Phase 1 (icon auto-bake CI में) |
| मुफ़्त, कोई signup नहीं | ✅ | ✅ |
| No watermark | ✅ | ✅ |
| Push (OneSignal) | ✅ | Phase 2 |
| AdMob option | ✅ | Phase 2 |
| Support chat | ✅ (tawk) | Phase 2 (निःशुल्क widget) |
| 14 भाषाएँ/RTL | ✅ | Phase 3 |
| **+ auto assetlinks/deep links** | ❌ (टूटा) | Phase 2 |
| **+ असली encryption** | ❌ (झूठा दावा) | Phase 1 |
| **+ AI-assisted setup (सब कुछ auto-suggest)** | ❌ | Phase 4 |
| **+ live preview (build से पहले)** | ❌ | Phase 3 |

---

## 7. Roadmap

| Phase | काम | स्थिति |
|---|---|---|
| **0 — नींव (आज)** | repo, यह plan, CI workflow, wrapper template, builder UI, demo server | ✅ **तैयार** |
| **1 — असली builds** | GitHub repo बनाना → token server env में → live dispatch → server-side signing (per-user keystore, `keytool`/`apksigner`) → icon bake | ⬅ अगला |
| **2 — सुविधाएँ** | Auth (email OTP), dashboard/history, storage (R2 free 10GB), OneSignal push, AdMob toggle, assetlinks auto-publish guide | |
| **3 — Android app** | Kotlin + Compose, Material 3, उसी API से, Play Store listing (16KB/edge-to-edge rules already पास) | |
| **4 — कमाई + AI** | Free/Pro plans, लेकिन AppMint से साफ़ pricing; AI templates; analytics | |

---

## 8. चलाने का तरीका (आज ही)

```bash
cd server
node index.js          # http://localhost:3000  (DEMO mode में पूरा flow चलेगा)
# असली builds के लिए (Phase 1):
GITHUB_TOKEN=ghp_xxx GITHUB_REPO=owner/repo node index.js
```

### Token security (तुम्हारा नियम — मैंने पालन किया)
- Token **कभी file में नहीं**, सिर्फ़ `env` variable में
- Fine-grained PAT, scopes केवल: **Actions: Read & Write** + **Contents: Read**
- Repo public रहेगा — inputs में कोई secret नहीं

---

## 9. Status Board

- [x] Deep audit of competitor (17 bugs, proofs) — done
- [x] Architecture + invisible CI engine design — done
- [x] CI workflow `build-apk.yml` — done
- [x] Wrapper template (secure, modern) — done
- [x] Builder web UI (demo-server ready) — done
- [x] **Smart 3-Tier engine** (T0 phantom pool / T1 optional user-GitHub auto-repo / T2 self-hosted) — code ready, docs/SMART-ENGINE.md
- [x] Google login + optional 1-tap GitHub connect (AES-256-GCM token vault) — code ready, env pending
- [x] Scale L1/L3: lane concurrency guards (20-limit कभी hit नहीं), live queue ETA, fairness, instant config-dedup, Gradle cache — done
- [ ] GitHub repo + token connect (तुम्हारे पास: 5 min)
- [ ] पहला असली APK build
