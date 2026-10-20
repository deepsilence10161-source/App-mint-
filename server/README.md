# ☁️ AppKaro Cloud — URL → APK builder (server + web UI)

App Mint परिवार का cloud module। Zero-dependency (Node 18+) — कोई npm install नहीं।

## चलाना

```bash
node index.js                       # DEMO mode (पूरा flow simulate)
# असली CI builds:
GITHUB_TOKEN=*** GITHUB_REPO=owner/repo node index.js
# पूरे auth के साथ (optional):
BASE_URL=https://app.domain GOOGLE_CLIENT_ID=.. GOOGLE_CLIENT_SECRET=.. \
GH_CLIENT_ID=.. GH_CLIENT_SECRET=.. SERVER_SECRET=$(openssl rand -hex 32) node index.js
```

## क्या-क्या है

- `index.js` — API + queue + lanes + fairness + instant dedup + signing (apksigner → jarsigner fallback) + artifact TTL sweep
- `auth.js` — Google login + optional GitHub Turbo connect (1-tap) + AES-256-GCM token vault
- `github.js` — CI dispatch/poll/artifact + यूज़र-repo auto-provision (T1)
- `public/index.html` — builder UI (dark, Hindi-first, live queue/ETA, icon upload, कमाई/push fields)
- `test.sh` — cheap smoke suite (`bash test.sh`) — असली CI नहीं जलाता

## Phase 2 features (live)

- 🖼️ **Custom icon** — upload (dataURL ≤1.5MB) या public URL → CI पर 5-density bake
- 💰 **AdMob** — App ID दो → banner SDK conditional compile; खाली = zero-bloat
- 🔔 **OneSignal push** — App ID दो → push SDK + runtime permission (Android 13+)
- 🔗 **assetlinks.json** — signed build के fingerprint से auto (deep links)
- 📊 **Dashboard** — `/api/my/builds` history · 📦 **AAB** download

## API

| Route | Method | काम |
|---|---|---|
| `/api/builds` | POST | नई build (url, name, packageId, themeColor, permissions, cleartext, iconData/iconUrl, admobAppId, admobUnitId, oneSignalAppId) |
| `/api/builds/:id` | GET | status + queue{position, etaMin} |
| `/api/builds/:id/download` | GET | final APK (`?type=aab` = Play bundle) |
| `/api/builds/:id/assetlinks.json` | GET | deep-link statement (signed builds) |
| `/api/my/builds` | GET | आपकी builds (history) |
| `/api/stats`, `/api/health` | GET | lanes/avg/mode + feature flags |
| `/auth/google`, `/auth/github`, `/api/me` | GET | auth flows |

## Env reference

| Env | क्यों |
|---|---|
| `GITHUB_TOKEN`, `GITHUB_REPO` | central pool (live builds) — बिना इसके DEMO mode |
| `GOOGLE_CLIENT_ID/SECRET` | Google login (users) |
| `GH_CLIENT_ID/SECRET` | optional GitHub Turbo (T1) connect |
| `SERVER_SECRET`, `BASE_URL` | sessions/cookies — production में ज़रूरी |
| `ARTIFACT_TTL_DAYS` (def 3) | local artifacts कब तक रखें (storage बचत) |
| `POOL_MAX_CONCURRENT`, `FAIR_ACTIVE_PER_USER`, `DAILY_BUILD_CAP` | scale/fairness tuning |

- Signing tools: `openjdk-17-jdk` (keytool+jarsigner) या Android build-tools (apksigner) server पर install करें।
- Runtime state `server/data/` में — **कभी commit नहीं** (root `.gitignore` में है)।

ज़्यादा: `../docs/SMART-ENGINE.md`, `../docs/SCALE-PLAN.md`
