#!/bin/bash
# temp-admin.sh — a throwaway LGR admin for one job: create it, use it, drop it, and prove the drop.
#
#   temp-admin.sh create <tag> <org> [<org> ...]   jamesbond-<tag>, role admin, in each org; writes the session file
#   temp-admin.sh drop   <tag> <org> [<org> ...]   deletes it everywhere, then proves sign-in and old sessions are dead
#   temp-admin.sh status <tag>                     what the session file says
#
# The account is created on the production database over a private port-forward from the build host, with the repo's own
# scripts/seed-user.ts (dry run first, read, then execute). Its password exists only in the gitignored session file
# `<main checkout>/.secrets/lgr-session-<tag>.env` (LGR_USERNAME / LGR_PASSWORD), which every API script reads from the
# environment; it is never printed. After a drop that file holds a DROPPED note and no credentials.
#
# Environment (all optional): LGR_API (https://lgrai.app) · LGR_BUILD_HOST (mars) · LGR_SSH_KEY (~/.ssh/id_ed25519) ·
# LGR_REMOTE_CHECKOUT (~/lgr, a checkout at the deployed commit) · LGR_TEMP_ADMIN_PORT (27124) · LGR_SECRETS_DIR.
set -euo pipefail

cmd=${1:-}; tag=${2:-}
[[ $cmd =~ ^(create|drop|status)$ && $tag =~ ^[a-z0-9]{3,20}$ ]] || { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift 2; orgs=("$@")
here=$(cd "$(dirname "$0")" && pwd)
api=${LGR_API:-https://lgrai.app}
host=${LGR_BUILD_HOST:-mars}
port=${LGR_TEMP_ADMIN_PORT:-27124}
remote_checkout=${LGR_REMOTE_CHECKOUT:-'$HOME/lgr'}
key=${LGR_SSH_KEY:-$HOME/.ssh/id_ed25519}
SSH=(ssh -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=12 -i "$key" "$host")
# A script for the build host goes over without carriage returns. A checkout that hands it out with CRLF (Windows,
# autocrlf) would otherwise have bash there refuse its first line (`set -euo pipefail`), after the session file is
# written: found 2026-11-11 from a fresh worktree.
put() { tr -d '\r' < "$1" | "${SSH[@]}" "cat > '$2'"; }
user="jamesbond-$tag"; email="$user@lgr.internal"
if [[ -n ${LGR_SECRETS_DIR:-} ]]; then secrets=$LGR_SECRETS_DIR
else secrets="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")/.secrets"; fi
session="$secrets/lgr-session-$tag.env"
say() { echo "[$(date -u +%T)] $*"; }

# POST a sign-in and print only the HTTP status. The body is built here: the password never reaches a command line.
login_status() { # <json fields without the password>
  printf '{%s,"password":"%s"}' "$1" "$LGR_PASSWORD" | curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- "$api/api/auth/login"
}
login_token() { # <org slug> → the token on stdout, or nothing
  printf '{"orgSlug":"%s","username":"%s","password":"%s"}' "$1" "$user" "$LGR_PASSWORD" \
    | curl -s -X POST -H 'content-type: application/json' --data-binary @- "$api/api/auth/login" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}
remote_clean() { "${SSH[@]}" "rm -f /tmp/jb-$tag-*; if ss -ltn | grep -q ':$port '; then echo 'port $port STILL LISTENING'; else echo 'build host clean: no /tmp/jb-$tag-* file, port $port free'; fi"; }

case $cmd in
status)
  if [[ ! -f $session ]]; then echo "$session: absent"; exit 0; fi
  if grep -q '^LGR_PASSWORD=' "$session"; then echo "$session: LIVE credentials for $user"; else echo "$session: no credentials"; grep -m3 '^#' "$session" || true; fi
  ;;

create)
  ((${#orgs[@]})) || { echo "create needs at least one org slug"; exit 2; }
  [[ -e $session ]] && { echo "$session exists already: every job takes a new tag"; exit 1; }
  "${SSH[@]}" "if ss -ltn | grep -q ':$port '; then echo 'port $port is busy on the build host (another job holds a port-forward)'; exit 1; fi; ls /tmp/jb-$tag-* >/dev/null 2>&1 && { echo 'leftovers of this tag on the build host'; exit 1; }; exit 0"
  trap 'echo "create did not finish. Run: temp-admin.sh drop $tag ${orgs[*]}  (it removes whatever was made, proves it, and retires the tag), then start again with a new tag."' ERR
  pw=$(openssl rand -hex 16 | tr -d '\r\n'); [[ ${#pw} -eq 32 ]] || { echo "could not make a password"; exit 1; }
  mkdir -p "$secrets"; ( umask 077; printf 'LGR_USERNAME=%s\nLGR_PASSWORD=%s\n' "$user" "$pw" > "$session" )
  say "session file written: $session"
  put "$here/remote/seed.sh" "/tmp/jb-$tag-seed.sh"
  send_pw() { printf %s "$pw" | "${SSH[@]}" "umask 077; cat > /tmp/jb-$tag-pw"; }
  say "dry run on the build host"
  send_pw; "${SSH[@]}" "TAG=$tag ORGS='${orgs[*]}' PORT=$port CHECKOUT=$remote_checkout bash /tmp/jb-$tag-seed.sh" | grep -v -i -E 'password|^Permissions'
  say "creating"
  send_pw   # the remote script deletes the password file when it ends, so it is sent again
  "${SSH[@]}" "TAG=$tag ORGS='${orgs[*]}' PORT=$port CHECKOUT=$remote_checkout EXECUTE=--execute bash /tmp/jb-$tag-seed.sh" | grep -v -i -E 'password|^Permissions' | grep -E '^===|User created|Linked|already|rror' || true
  remote_clean
  export LGR_PASSWORD=$pw
  bad=0
  for o in "${orgs[@]}"; do
    s=$(login_status "\"orgSlug\":\"$o\",\"username\":\"$user\""); echo "sign-in $o: $s"; [[ $s == 200 ]] || bad=1
  done
  ((bad)) && { echo "FAILED: the account does not sign in everywhere. Drop it (temp-admin.sh drop $tag ${orgs[*]}) and start again with a new tag."; exit 1; }
  echo "CREATED $user in: ${orgs[*]}. Prove what its session sees before using it (daily-import: grant-check.ts)."
  ;;

drop)
  ((${#orgs[@]})) || { echo "drop needs the org slugs the account was created in"; exit 2; }
  [[ -f $session ]] || { echo "$session: absent"; exit 1; }
  grep -q '^LGR_PASSWORD=' "$session" || { echo "$session holds no credentials: already dropped?"; grep -m3 '^#' "$session" || true; exit 1; }
  set -a; source "$session"; set +a
  # Sessions made now, while the account exists: after the drop they must stop working.
  declare -A token
  for o in "${orgs[@]}"; do token[$o]=$(login_token "$o"); [[ -n ${token[$o]} ]] && echo "live session taken in $o" || echo "no session in $o (not a member there, or already gone)"; done
  put "$here/remote/drop.ts" "/tmp/jb-$tag-drop.ts"; put "$here/remote/drop.sh" "/tmp/jb-$tag-drop.sh"
  say "dropping $email in every org"
  result=$("${SSH[@]}" "TAG=$tag EMAIL=$email PORT=$port CHECKOUT=$remote_checkout bash /tmp/jb-$tag-drop.sh"); echo "$result"
  dropped=$(date -u +%s)
  remote_clean
  fail=0
  grep -q 'left: users 0 | identities 0' <<<"$result" || { echo "FAILED: rows are left"; fail=1; }
  # Sign-in must be refused: in each org, in its test copy (a sync may have copied the account there), by name and by e-mail.
  for o in "${orgs[@]}"; do for slug in "$o" "test-$o"; do
    s=$(login_status "\"orgSlug\":\"$slug\",\"username\":\"$user\""); echo "sign-in $slug: $s"; [[ $s == 200 ]] && fail=1
  done; done
  s=$(login_status "\"username\":\"$user\""); echo "sign-in by username, no org: $s"; [[ $s == 200 ]] && fail=1
  s=$(login_status "\"username\":\"$email\""); echo "sign-in by e-mail, no org: $s"; [[ $s == 200 ]] && fail=1
  # A pod keeps a session's person for about a minute. Wait it out, then the old sessions must answer 401.
  wait_until=$((dropped + 125)); now=$(date -u +%s); ((now < wait_until)) && sleep $((wait_until - now))
  for o in "${orgs[@]}"; do
    [[ -n ${token[$o]} ]] || continue
    s=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer ${token[$o]}" "$api/api/auth/me"); echo "old session of $o at +$(( $(date -u +%s) - dropped )) s: $s"; [[ $s == 401 ]] || fail=1
  done
  if ((fail)); then echo "NOT PROVEN: read the lines above. The session file is left as it is."; exit 1; fi
  printf '# %s (temp admin in: %s): DROPPED %s UTC.\n# %s\n# Sign-in refused in every org, its test copy, by username and by e-mail; old sessions answer 401. No credentials are kept here.\n' \
    "$user" "${orgs[*]}" "$(date -u -d "@$dropped" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -u '+%Y-%m-%d %H:%M:%S')" "$(grep -m1 'deleted' <<<"$result")" > "$session"
  echo "DROPPED and proven: $user"
  ;;
esac
