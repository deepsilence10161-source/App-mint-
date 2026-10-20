#!/usr/bin/env bash
# ⚡ AppKaro smoke suite — cheap, read-only + smart-cache (dedup) tests सिर्फ़
# असली CI builds नहीं जलाता (dedup POST zero-cost है)।
#   चलाना:  bash test.sh [BASE_URL]      default: http://localhost:3000
set -u
BASE="${1:-http://localhost:3000}"
PASS=0; FAIL=0
T() { # T "name" "expected-substring" actual-output
  if echo "$3" | grep -qF "$2"; then PASS=$((PASS+1)); echo "  ✅ $1"
  else FAIL=$((FAIL+1)); echo "  ❌ $1"; echo "     expected~: $2"; echo "     got: $3"; fi
}

echo "▶ health + features"
H=$(curl -s -m 8 "$BASE/api/health")
T "server ज़िंदा" '"ok":true' "$H"
T "features: ads/push/assetlinks" '"assetlinks":true' "$H"

echo "▶ validation (CI cost नहीं — reject हो जाती है)"
E1=$(curl -s -m 8 -X POST "$BASE/api/builds" -H 'Content-Type: application/json' -d '{"url":"not-a-url"}')
T "खराब URL → 422" 'सही URL दें' "$E1"
E2=$(curl -s -m 8 -X POST "$BASE/api/builds" -H 'Content-Type: application/json' -d '{"url":"https://example.com","admobAppId":"xyz"}')
T "खराब AdMob id → reject" 'AdMob App ID गलत' "$E2"
E3=$(curl -s -m 8 -X POST "$BASE/api/builds" -H 'Content-Type: application/json' -d '{"url":"https://example.com","oneSignalAppId":"xyz"}')
T "खराब OneSignal id → reject" 'OneSignal App ID गलत' "$E3"
E4=$(curl -s -m 8 -X POST "$BASE/api/builds" -H 'Content-Type: application/json' -d '{"url":"https://example.com","admobUnitId":"ca-app-pub-1234567890123456/1234567890"}')
T "unit बिना app-id → reject" 'दोनों खाली' "$E4"

echo "▶ dashboard"
M=$(curl -s -m 8 -H 'X-Forwarded-For: 9.9.9.1' "$BASE/api/my/builds")
T "my/builds जवाब" '"ok":true' "$M"

echo "▶ unknown build"
N=$(curl -s -m 8 "$BASE/api/builds/ak_doesnotexist")
T "404 json" 'build नहीं मिली' "$N"

echo ""
echo "════════ $PASS pass / $FAIL fail ════════"
[ "$FAIL" -eq 0 ]
