# 🆓 FREE-FOREVER Stack — सभी Limits (researched & locked, 18 Oct 2026)

> **Owner rule (याद रखें):** "मुझे सब free चाहिए" — किसी यूज़र के GitHub account की ज़रूरत कभी नहीं।
> नीचे हर limit official docs से verify हुई है। जो grey है, वो साफ़ लिखा है — झूठ नहीं।

---

## 1. Build Engines — सत्य आँकड़े

| Engine | Free limit | सच्चाई / जोखिम | Source |
|---|---|---|---|
| **GitHub Actions — public repo (hosted runner)** | **minutes: unlimited, हमेशा free** | 20 concurrent jobs (Free plan); job ≤ 6h (हमारा build 3–4 min)। **⚠️ ToS grey:** "Actions को commercial service के रूप में offer करना" मना है —GitHub repo/account restrict कर सकता है | docs.github.com/actions |
| GitHub Actions — private repo | 2000 min/माह + 500MB artifacts | सिर्फ़ fallback; hard stop ₹0 spend पर | docs.github.com/billing |
| **GitHub self-hosted runner** | **free — zero minutes charge** | Orchestration मुफ़्त; हमारी machine पर unlimited। (मार्च 2026 का $0.002/min प्रस्ताव **indefinitely postponed**) | docs.github.com/billing |
| **Oracle Cloud Always Free** | **2 OCPU ARM + 12GB RAM + 200GB storage + 10TB egress — हमेशा free** | जून 2026 में 4/24 → **2/12 घटा** (नए accounts)। ⚠️ Idle-reclaim: 7 दिन <20% use → instance वापस (हमारा server चलता रहेगा, कोई दिक्कत नहीं) | docs.oracle.com |
| GitLab CI | hosted 400 min/माह; self-hosted runner पर unlimited | backup orchestrator | about.gitlab.com |
| Codemagic | 500 min/माह (macOS M2, personal) | emergency lane को | codemagic.io/pricing |
| Woodpecker/Drone (self-hosted, OSS) | unlimited (अपनी machine पर) | Plan C orchestrator — Oracle box पर चल सकता है | woodpecker-ci.org |

---

## 2. बाकी stack — सब free

| ज़रूरत | Free service | Limit |
|---|---|---|
| Website hosting | **Cloudflare Pages** | unlimited static requests (fair use) |
| API/queue server | **Oracle Always Free VM** (वही build box) | 2 OCPU/12GB के भीतर |
| Storage (APK/hosting) | **Cloudflare R2 10GB** / Oracle 20GB object | R2: zero egress fee |
| Auth | Google OAuth / Supabase free | 50k MAU तक free |
| Domain | free subdomains (pages.dev आदि) | custom domain चाहिए तो ~₹800/वर्ष (registrar की fee — कोई tech इसे free नहीं कर सकता) |

---

## 3. 🔒 FINAL locked architecture (कोई user-account dependence नहीं)

```
T0-Bootstrap (आज → launch, speed के लिए)
   GitHub public pool (unlimited*, grey)
        │  खुद rate-limit रखेंगे, respectful usage
        ▼
T0-PRIME ★ हमेशा की engine ★
   Oracle Always Free VM (2 OCPU/12GB ARM)
   + GitHub self-hosted runner (Actions orchestration free)
   ≈ 8 मिनट/build → ~180 builds/दिन, 24×7
        │  overload हो तो
        ▼
Burst/Backup ring
   GitHub public pool (burst) → Codemagic 500 min → GitLab 400 min
        │  orchestration बदलना पड़े तो
        ▼
Plan C: Woodpecker CI उसी Oracle box पर (zero GitHub dependence)
```

**Bootstrap के बाद T0-Bootstrap को धीरे-धरे घटाकर Prime पर shift करेंगे** — जिस दिन GitHub टोकता भी है, service रुकेगी नहीं।

---

## 4. Capacity गणित (ईमानदार)

| स्तर | संदर्भ | क्षमता |
|---|---|---|
| शुरुआत | Oracle 2-core, 8 min/build | **~180 builds/दिन** (queue के साथ) |
| + GitHub pool burst | 20 concurrent | spike handling |
| Users ज़्यादा हों तो | 2nd Oracle tenancy मना (1/person) → **revenue से ₹400–500/माह VPS जोड़ना** (वह दिन आते-आते monetization चालू हो चुका होगा) | linear scale |

Free का मतलब: **queue में इंतज़ार**, गिरना नहीं। यही ईमानदार trade है।

---

## 5. वो 2 चीज़ें जो दुनिया में कोई free नहीं कर सकता (अभी से साफ़)

1. **Custom domain** (~₹800/वर्ष) — registrar की fee; optional (free subdomains से चल सकता है)
2. **Play Store developer account** ($25 एक बार) — Google की fee, सिर्फ़ जब Play पर डालना हो; APK sideload हमेशा free

इन दोनों के अलावा **पूरी pipeline ₹0** — build, host, store, auth, delivery।

---

## 6. Risk Register (owner को पता होना चाहिए)

| जोखिम | संभावना | बचाव |
|---|---|---|
| GitHub pool repository restrict हो (ToS grey) | मध्यम | Prime engine पहले से अलग; repo auto-recreate script |
| Oracle idle-reclaim | कम (server 24×7 busy) | health-check cron + rebuild script |
| Oracle नई accounts में ARM availability (capacity "out of stock") | मध्यम | कई regions try; AMD micro पर queue server, build GitLab पर temp |
| Free tiers भविष्य में घटें (जैसे Oracle ने किया) | हमेशा संभव | पूरी stack portable — कोई vendor lock-in नहीं |

---

*आखिरी verify: 18 Oct 2026 · Sources: GitHub Docs (billing/limits/runners/AUP), Oracle docs + InfoQ/редdit reports, GitLab/Codemagic pricing pages.*
