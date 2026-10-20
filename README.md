# 🏭 App Mint — the free Android app factory

> **एक ही परिवार, तीन क्षमताएँ:** URL डालो → wrapper app. Spec describe करो → असली native app. और Studio — फ़ोन से सीधे builder.
> Free, no accounts, no watermarks — और हर APK एक **validated, असली फ़ाइल** है।

---

## 🗺️ यहाँ क्या है (repo map)

| Module | क्या करता है | Path |
|---|---|---|
| ⚙️ **Spec Engine** | `spec.json` describe करो → validate (5 layers) → generate → compile → artifact validate → **signed native APK**. Deterministic, offline, no AI/API needed | `engine/`, `apps/`, `tools/` |
| ☁️ **AppKaro Cloud** | किसी भी **website का URL** → modern/hardened wrapper APK + AAB। Invisible CI (यूज़र को कभी GitHub नहीं दिखता), queue+ETA, instant dedup, fairness guards | `server/`, `wrapper-template/`, `.github/workflows/appkaro-build.yml` |
| 📱 **Studio** | एक self-contained HTML studio (~105 KB) — फ़ोन पर खोलो, offline चलता है, GitHub Pages पर host | `studio/` |

तीनों modules अलग क्षमताएँ हैं, पर **सिद्धान्त एक** हैं: free-first, no lock-in, validated output, कोई secret कभी repo में नहीं।

```text
यूज़र ──► Studio (फ़ोन)          ─► spec.json ─► ⚙️ Engine ─► validate ─► APK  (निश्चित, local-जैसा)
यूज़र ──► AppKaro Web Builder    ─► URL+config ─► ☁️ server ─► queue ─► CI ─► sign ─► APK/AAB (cloud)
```

## ⚡ Workflows

| Workflow | Trigger | Kaam |
|---|---|---|
| `build.yml` | push/PR/dispatch | Spec → generate → compile → validate artifact |
| `appkaro-build.yml` | server dispatch | Config → wrapper-template → unsigned APK/AAB (signing server पर होती है — keystore कभी CI में नहीं) |
| `emulator-e2e.yml` | build के बाद | असली emulator पर E2E (user rule: live test ही असली confirm) |
| `studio.yml` | `studio/**`, `engine/**` बदलने पर | Studio बना, browser-verify, Pages publish |

## 🚀 Quickstarts

**Spec → native APK**
```bash
node engine/cli.mjs build apps/demo/spec.json
```

**AppKaro Cloud (URL → APK)**
```bash
cd server
node index.js                        # demo mode
# असली builds के लिए (pool repo = यही repo):
GITHUB_TOKEN=*** GITHUB_REPO=deepsilence10161-source/App-mint- node index.js
# फिर खोलो http://localhost:3000 → URL डालो → APK
```

**Studio** — https://deepsilence10161-source.github.io/App-mint- (फ़ोन पर खोलो)

## 📚 Docs

- `docs/AUDIT.md` — repository audit + architecture map (हिसाब किताब)
- `docs/APPKARO-BLUEPRINT.md` — AppKaro की रणनीति (competitor analysis सहित)
- `docs/SMART-ENGINE.md` — invisible CI + optional user-GitHub Turbo
- `docs/FREE-STACK.md` — सभी free limits (researched, dated)
- `docs/SCALE-PLAN.md` — concurrency/scale योजना

## 🛡️ Principles (दोनों modules के लिए अटल)

1. **Validated artifacts** — build तभी success जब असली फ़ाइल verify हो; सिर्फ़ exit-0 काफी नहीं।
2. **Secrets कभी repo में नहीं** — keys/users-data ignore; tokens सिर्फ़ env।
3. **Free-forever design** — public-repo CI (unlimited*), self-hosted runner plan, कोई vendor lock-in नहीं।
4. **Live/E2E confirm** — claim से पहले real run/logs — या कुछ नहीं।

---
*"App Mint" एक project है — engine भी, cloud भी, studio भी। सब कुछ इसी repo में, साफ़-सुथरा।*
