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

- `index.js` — API + queue + lanes + fairness + instant dedup + signing (apksigner → jarsigner fallback)
- `auth.js` — Google login + optional GitHub Turbo connect (1-tap) + AES-256-GCM token vault
- `github.js` — CI dispatch/poll/artifact + यूज़र-repo auto-provision (T1)
- `public/index.html` — builder UI (dark, Hindi-first, live queue/ETA)

## API

| Route | Method | काम |
|---|---|---|
| `/api/builds` | POST | नई build (url, name, packageId, themeColor, permissions, cleartext) |
| `/api/builds/:id` | GET | status + queue{position, etaMin} |
| `/api/builds/:id/download` | GET | final APK |
| `/api/stats`, `/api/health` | GET | lanes/avg/mode |
| `/auth/google`, `/auth/github`, `/api/me` | GET | auth flows |

- Signing tools: `openjdk-17-jdk` (keytool+jarsigner) या Android build-tools (apksigner) server पर install करें।
- Runtime state `server/data/` में — **कभी commit नहीं** (root `.gitignore` में है)।

ज़्यादा: `../docs/SMART-ENGINE.md`, `../docs/SCALE-PLAN.md`
