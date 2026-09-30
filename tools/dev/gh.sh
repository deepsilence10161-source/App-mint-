#!/usr/bin/env bash
# GitHub access for the App-mint- repo.
#
# The token lives in ~/.appmint-gh-token — OUTSIDE the repository, mode 600, and
# it is never written into .git/config, never put in a URL, and never echoed.
# Keeping it here rather than in the environment means it survives a wiped /tmp.
#
# Usage:  source tools/dev/gh.sh        # gives you: ghpush, ghfetch, ghapi
#
# Standing rule from the owner: only the App-mint- repository may be touched.

set -u

GH_OWNER="deepsilence10161-source"
GH_REPO="App-mint-"
GH_TOKEN_FILE="${HOME}/.appmint-gh-token"

# The repository URL, kept here rather than in .git/config: git config is
# excluded from workspace snapshots, so a remote added there is gone by the next
# command. Passing the URL explicitly means the push does not depend on it.
gh_url() { echo "https://github.com/${GH_OWNER}/${GH_REPO}.git"; }

_gh_token() {
  if [ ! -r "$GH_TOKEN_FILE" ]; then
    echo "No token at $GH_TOKEN_FILE." >&2
    echo "Ask the owner for it — it is not in the repo and not in the environment." >&2
    return 1
  fi
  # Command substitution strips the trailing newline; the token itself is one line.
  cat "$GH_TOKEN_FILE"
}

# Push using an authorization header rather than a URL, so the token never lands
# in .git/config, in a reflog, or in the output of `git remote -v`.
ghpush() {
  local t; t="$(_gh_token)" || return 1
  local branch="${1:-main}"
  local hdr="http.extraHeader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$t" | base64 -w0)"
  GIT_AUTHOR_NAME="App Mint Studio" GIT_AUTHOR_EMAIL="studio@appmint.local" \
  GIT_COMMITTER_NAME="App Mint Studio" GIT_COMMITTER_EMAIL="studio@appmint.local" \
  git -c "$hdr" push "$(gh_url)" "$branch" 2>&1 \
    | sed -E 's/(ghp_|github_pat_)[A-Za-z0-9_]+/\1<REDACTED>/g' \
    | sed -E 's/[A-Za-z0-9+/=]{40,}/<redacted>/g'
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] && echo "pushed to ${GH_OWNER}/${GH_REPO} ${branch}"
  return "$rc"
}

# Fetch/read the remote without needing the token at all (the repo is public).
ghfetch() { git fetch "$@" "$(gh_url)" 2>&1 | sed -E 's/[A-Za-z0-9_]{20,}/<redacted>/g'; }

# Raw API call. Any token-shaped string in the reply is scrubbed before printing.
ghapi() {
  local t; t="$(_gh_token)" || return 1
  curl -sS -H "Authorization: Bearer $t" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" \
       "https://api.github.com/$1" \
    | sed -E 's/(ghp_|github_pat_)[A-Za-z0-9_]+/\1<REDACTED>/g'
}

# The committer identity is gone for the same reason the remote is: .git/config
# is not snapshotted. Carry it in the environment for every git command that
# writes, so a commit never fails with "Author identity unknown".
gh_identity() {
  export GIT_AUTHOR_NAME="App Mint Studio" GIT_AUTHOR_EMAIL="studio@appmint.local"
  export GIT_COMMITTER_NAME="App Mint Studio" GIT_COMMITTER_EMAIL="studio@appmint.local"
  echo "git identity set"
}
gh_identity >/dev/null

export -f ghpush ghfetch ghapi gh_url gh_identity 2>/dev/null || true
echo "gh helpers ready (token file: $GH_TOKEN_FILE)"
