# 🚀 SCALE PLAN — "एक साथ कई users आ जाएँ तो?" (researched, 18 Oct 2026)

> Owner सवाल: 20 concurrency hit होगी, क्या user का अपना account ही best है?
> Engineer जवाब (depth research के बाद): **नहीं — इसके 5 बेहतर तरीके हैं। User account को "optional turbo" रखो, backbone कभी मत बनाओ।**

---

## 1. पहले सच्चाई: 20-limit पर किस पर लागू होती है?

| Runner | Concurrent limit (Free) | Source |
|---|---|---|
| GitHub-**hosted** runners | **20 jobs** (plan ceiling) | docs.github.com/actions/limits |
| GitHub **self-hosted** runners | **कोई plan ceiling नहीं** — "jobs on self-hosted labels queue on pool capacity instead" (यानी जितने runners लगाओ, उतनी concurrency) | warpbuild guide + GitHub limits doc |

या�னি **20 की दीवार सिर्फ़ GitHub की machines पर है। अपनी machine पर GitHub कुछ charge नहीं करता और concurrency रोकता भी नहीं।** यही ताला-चाबी है।

Self-hosted runner के अपने limits (job ≤ 5 दिन, queue ≤ 24 घं, 10,000 runners/group) — हमारे 8-मिनट builds के लिए सब असंबंधित।

---

## 2. "User का अपना account" — ईमानदार मूल्यांकन

| पहलू | सच |
|---|---|
| Load बँटता है? | हाँ — 100 users × 20 slots = 2000 slots (काग़ज़ पर) |
| Cost | UX क़ब्र: user के पास GitHub account ही नहीं → signup → OAuth → authorize = **drop-off 80%+** (AppMint जैसे tool की जान ही zero-friction है) |
| Privacy | हमारा workflow उनके account में public repo बनाएगा — उनकी profile और हमारी service publicly जुड़ जाएगी; बहुत users को नापसंद आएगा |
| Support | 10,000 repos × 10,000 accounts में logs/debug = ऑपरेशनल नर्क |
| Blast radius | GitHub ने हमारे OAuth App को flag किया (commercial use clause) → **सारे connected users एक साथ टूटेंगे** |
| ToS | एक इंसान = एक free account (GitHub ToS B.3) — farming नहीं कर सकते; और हर user अपना account दे यह ज़रूरी भी तो नहीं |
| Owner की अपनी शर्त | "user को कम से कम पता चले" — account-based model इससे सीधा टकराता है |

**निष्कर्ष:** backbone के तौर पर ❌। **Optional "Turbo"** के तौर पर ✅ (जो power-user चाहे, वो जुड़े — code already built)।

---

## 3. असली समाधान — 6-Layer Smart Scale System

### Layer 0 · फ़िज़िक्स समझो: concurrency ≠ throughput
3–8 मिनट का build × 20 slots = **150–400 builds/घंटा** burst capacity। समस्या error नहीं, **क़तार** है — और क़तार को UX बनाओ।

### Layer 1 · Queue + live ETA (user को क्या दिखे)
- कभी "fail" नहीं — हमेशा: **"आप #3 क़तार में हैं · ~6 मिनट"** + live progress
- तुलना: Codemagic free plan सिर्फ़ **1 concurrent build** देता है; हमारी baseline उससे 20x
- Server queue में priority: T1-turbo user > पुरानी waiting > नई

### Layer 2 · Self-hosted runner फ़्लीट (★ कोई concurrency ceiling नहीं ★)
| Runner (free, own infra) | Specs | Builds |
|---|---|---|
| Oracle Always Free VM | 2 OCPU ARM / 12GB | 2 parallel × ~8 min = **~15/घंटा, 24×7** |
| Same box को GitLab runner भी बनाओ | dual-register | orchestration दोहरी सुरक्षा |
| Growth पर: revenue से VPS ₹400–500/माह ×N | 4–8 cores | एक VPS ≈ 30–60 builds/घंटा — **जेब से नहीं, कमाई से** |
- Runner auto-register script + health watchdog
- खाली पड़े तो नहीं (Oracle idle-reclaim से बचाव) — server उसी box पर चलता रहेगा

### Layer 3 · Speed = छिपी हुई concurrency (सबसे underestimated)
| Trick | असर | Cost |
|---|---|---|
| **Gradle/build cache** (actions/cache — 10GB/repo free) + self-hosted पर persistent cache | 8 min → **~90 सेकंड** | ₹0 |
| **Config-hash dedup** — exact same config दोबारा? पुरानी APK re-sign करके turant दो | repeat builds ~free | ₹0 |
| **Batched jobs** — 1 runner slot एक job में 3–5 क़तारी builds sequential बनाए | effective throughput ×3–5 (self-hosted पर बेझिझक) | ₹0 |
| **Baked runner image** (Android SDK+deps pre-installed Docker) | cold start ~0 | ₹0 |

⚡ कुल असर: बिना एक भी नया account — **throughput 10–15 गुना**।

### Layer 4 · Auto-router (already designed in server/engine)
```
incoming build
  → self-hosted pool खाली?  → भेजो (सबसे सस्ता+तेज़, cache warm)
  → वरना hosted pool < 20?  → burst भेजो (public repo, respectful)
  → वरना backup CI (Codemagic/GitLab)? → भेजो
  → वरना क़तार में रखो + ETA दिखाओ
Fairness: प्रति free user 1 active build + 3/दिन cap, captcha (abuse पर हमले से रोक)
```

### Layer 5 · Optional Turbo = user का अपना GitHub (तुम्हारा idea, सही जगह पर)
- Settings में "⚡ Turbo (advanced)" chip — **advanced users ही देखें**, normal user को GitHub का नाम भी न दिखे
- जुड़ने पर: उसकी builds उसके ख़ुद के repo/quota → **हमारी क़तार से पूरी तरह बाहर**
- यह capacity का bonus है, product की नींव नहीं

---

## 4. Scale ladder (ईमानदार नंबर्स)

| Stage | Setup | Throughput | Users capacity* |
|---|---|---|---|
| Day 1–1000 | Oracle runner (2 parallel) + hosted burst | ~20–40/घंटा | पर्याप्त |
| Growth | + cache/dedup/batching | ~100–200/घंटा | आराम से |
| Viral | + 1 VPS ₹400 (कमाई से) | ~250–400/घंटा | 10k+ MAU |
| Scale | Woodpecker fleet / paid runners | जितना चाहो | कोई छत नहीं |

*avg 1 user = 2–4 builds कुल जीवन में; throughput घंटावार है, users मासिक — क़तार ही असली पु्लिंदा है।

---

## 5. जो कभी नहीं करेंगे (ToS-protected)

- ❌ Multiple GitHub accounts farming (ToS B.3: एक इंसान = एक free account)
- ❌ Users के लिए bots से accounts बनाना
- ❌ Google Colab/Kaggle को build farm बनाना (उनकी ToS भी मना — accounts ban)
- ✅ सिर्फ़ अपनी machines (self-hosted = unlimited) + respectful public pool + optional user-turbo

---

## 6. Final निर्णय (locked)

> **User account: optional Turbo, कभी ज़रूरी नहीं।**
> **Concurrency का जवाब: self-hosted runners (कोई ceiling नहीं) + queue-UX + speed-stack (cache/dedup/batch) + burst pool।**
> User को GitHub दिखेगा ही नहीं — जब तक वो ख़ुद "advanced" खोलकर Turbo चाहे।

*Verified: GitHub limits doc (concurrency 20 hosted / self-hosted pool-queue), GitHub ToS B.3 (one free account), warpbuild concurrency guide, actions/cache 10GB — 18 Oct 2026.*
