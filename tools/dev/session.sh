#!/usr/bin/env bash
# Restore everything a workspace snapshot quietly drops.
#
# Source this at the start of any session:  source tools/dev/session.sh
#
# Four things do not survive between sessions, and each one has bitten this
# project at least once:
#
#   1. The executable bit on scripts. Files come back as 0644, so every script
#      under tools/ reports as modified and any direct ./run.sh fails.
#   2. The git remote. .git/config is excluded from snapshots, so `git push`
#      says "origin does not appear to be a git repository".
#   3. The committer identity, from the same file, so commits fail with
#      "Author identity unknown".
#   4. The node_modules symlink, which is excluded by name, so the Studio tests
#      cannot find playwright.
#
# None of this is a bug in the project — it is the shape of the environment.
# Having it in one place means every session starts from a known state instead
# of rediscovering which piece is missing.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || return 1

echo "  session: $REPO_ROOT"

# ── 1. executable bits ──────────────────────────────────────────────────────
stripped=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if [ ! -x "$f" ]; then chmod +x "$f"; stripped=$((stripped + 1)); fi
done < <(git ls-files -s | awk '$1 == "100755" { print $4 }')
echo "  exec bits: $stripped restored"

# Tell git not to track the mode at all, so a stripped bit cannot show up as a
# change to a script nobody edited. This is per-repository config, which is
# wiped with the rest of .git/config, so it is set here on every run.
git config core.fileMode false
git config user.name  "App Mint Studio"  >/dev/null
git config user.email "studio@appmint.local" >/dev/null

# ── 2. the remote ───────────────────────────────────────────────────────────
GH_URL="https://github.com/deepsilence10161-source/App-mint-.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$GH_URL"
else
  git remote add origin "$GH_URL"
fi
echo "  remote:   origin -> ${GH_URL#https://github.com/}"

# ── 3. the token ────────────────────────────────────────────────────────────
if [ -r "$HOME/.appmint-gh-token" ]; then
  echo "  token:    present"
else
  echo "  token:    MISSING — pushing needs it; ask the owner"
fi

# ── 4. playwright, for the Studio tests ─────────────────────────────────────
if [ -d "$REPO_ROOT/node_modules/playwright-core" ]; then
  echo "  playwright: linked"
elif [ -d /tmp/pw/node_modules/playwright-core ]; then
  ln -sfn /tmp/pw/node_modules "$REPO_ROOT/node_modules"
  echo "  playwright: relinked to /tmp/pw"
else
  echo "  playwright: not installed (npm i playwright-core into /tmp/pw, then re-run)"
fi

echo "  session ready."
