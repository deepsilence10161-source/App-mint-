# 🧠 Smart 3-Tier Build Engine (AppKaro)

> मकसद: **GitHub की limit कभी hamper न हो** — और यूज़र को जितना कम से कम setup करना पड़े।
> सिद्धांत: **legal + ToS-safe only** (ban-proof product)। Token कभी किसी file में plaintext नहीं।

---

## 1. ईमानदार सीमाएँ (100% confirm हुई बातें)

| बात | सच |
|---|---|
| Google login से GitHub account auto-create/auto-login | ❌ असंभव — GitHub का अपना OAuth है; Google ≠ GitHub identity |
| Bot/script से यूज़र के लिए GitHub account बनाना | ❌ ToS violation → mass suspension |
| यूज़र 1-tap में अपना GitHub **authorize** करे | ✅ पूरी तरह legal (Vercel/Netlify जैसा pattern) |
| Public repo पर GitHub Actions | ✅ **unlimited मुफ़्त minutes*** (*fair-use) |
| Private repo पर | ✅ 2000 min/माह (~500 builds) प्रति account |
| Self-hosted runner (हमारा VPS) | ✅ कोई minute-limit ही नहीं — असली "limit khatam" |

---

## 2. तीन Tier — build कहाँ जाता है?

```
            ┌────────────────────────────────────────────┐
 build req →│  Engine Router (server)                     │
            └────────────────────────────────────────────┘
               │                │                  │
        (gh connected?)   (central pool)      (scale हो तो)
               │                │                  │
               ▼                ▼                  ▼
   T1: यूज़र का अपना repo   T0: हमारा public    T2: self-hosted
   (appkaro-builds,        pool repo          runners (VPS)
   auto-provisioned)      (default lane)      (future switch)
```

**Router नियम:** जिस यूज़र ने GitHub जोड़ा है → उसकी builds **उसी की quota** पर (priority lane)।
बाक़ी सब → T0 pool (public repo → unlimited*)। कोई secret कभी CI में नहीं जाता — **signing हमेशा server पर**।

---

## 3. यूज़र का सफ़र (जितना smooth हो सकता है, उतना)

### सिर्फ़ app बनानी है (99% लोग)
`Form भरो → Build → Download` — **GitHub शब्द भी screen पर नहीं।** (T0)

### Power user चाहे तो (T1, optional)
1. **Google से login** (एक tap, standard OAuth)
2. "🔗 GitHub जोड़ें (optional — priority + अपनी quota)" बटन
3. GitHub की official authorize screen → **Authorize** (बस!)
4. Server अपने-आप:
   - यूज़र के account में **`appkaro-builds` repo बनाता है** (public — ताकि unlimited free minutes)
   - उसमे **workflow file auto-install** करता है (1 API call)
   - अब से उस यूज़र की builds **उसी के repo** में, उसी की quota पर
5. यूज़र को सिर्फ़ badge दिखता है: `⚡ Priority engine · @username`

Agलर GitHub account ही नहीं है → 2 मिनट की signup (usi Gmail से) — यह हिस्सा auto **नहीं** हो सकता (ऊपर देखो), पर deep-link से 30 second में हो जाता है।

---

## 4. Security / Token vault

- GitHub OAuth token: **AES-256-GCM से encrypted**, key = `SERVER_SECRET` (env)
- Session: HMAC-signed httpOnly cookie (30 दिन)
- Scopes न्यूनतम: `workflow, public_repo`
- यूज़र कभी भी disconnect कर सकता है → token turant delete
- हमारा अपना central token भी सिर्फ़ env में
- **keystore कभी किसी repo/log में नहीं** — signing केवल server पर

---

## 5. Owner (तुम्हारे) setup — कुल ~10 मिनट

| Step | कहाँ | Outcome env |
|---|---|---|
| Google OAuth Client बनाओ | console.cloud.google.com → Credentials → OAuth client (Web) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub OAuth App बनाओ | github.com/settings/developers → OAuth Apps → New (callback: `<BASE_URL>/auth/github/callback`) | `GH_CLIENT_ID`, `GH_CLIENT_SECRET` |
| Template repo (public) | हमारा `wrapper-template` वाला repo | `TEMPLATE_REPO=owner/repo` |
| Central pool repo (public) | इस repo में यह workflow | `GITHUB_TOKEN` (fine-grained PAT: Actions RW), `GITHUB_REPO=owner/repo` |
| बाक़ी | — | `BASE_URL`, `SERVER_SECRET` (लंबा random) |

चालू करना:
```bash
BASE_URL=https://appkaro.example.com \
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
GH_CLIENT_ID=... GH_CLIENT_SECRET=... \
GITHUB_TOKEN=... GITHUB_REPO=owner/pool TEMPLATE_REPO=owner/template \
SERVER_SECRET=$(openssl rand -hex 32) \
node server/index.js
```
Env न दो तो पूरा system **DEMO mode** में चलता है (flow same, build simulate)।

---

## 6. आगे के smart सुधार (roadmap)

- **T2 switch**: Load > pool limit → अपने runner pool पर auto-shift (कोई code बदलाव यूज़र साइड नहीं)
- **Multi-pool rotation (हमारे अपने repos)** — नोट: हमारे खुद के infrastructure के भीतर ही
- Build cache (Gradle/AVD) → 60s → ~40s
- यूज़र T1 repos का health check (workflow मौजूद? enable?) — auto-repair
- Rate-limit/good-citizen delays — GitHub terminate न करे
