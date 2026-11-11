#!/bin/bash
# tags.sh — fastener tags and categories for the products an import created (scripts/assign-din-tags.ts), run on the
# build host over a private port-forward to the production Mongo. The importers create a product untagged, in „Общи".
#
#   tags.sh <org> [<org> ...]             dry run: how many products need tags, per org
#   tags.sh --execute <org> [<org> ...]   write them, then run it dry again: every org must then need 0
#
# Environment (all optional), as for temp-admin.sh: LGR_BUILD_HOST (mars) · LGR_SSH_KEY (~/.ssh/id_ed25519) ·
# LGR_REMOTE_CHECKOUT (~/lgr, a checkout at the deployed commit) · LGR_TEMP_ADMIN_PORT (27124).
set -euo pipefail
execute=''
[[ ${1:-} == --execute ]] && { execute=--execute; shift; }
(($#)) || { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
host=${LGR_BUILD_HOST:-mars}
port=${LGR_TEMP_ADMIN_PORT:-27124}
checkout=${LGR_REMOTE_CHECKOUT:-'$HOME/lgr'}
key=${LGR_SSH_KEY:-$HOME/.ssh/id_ed25519}
SSH=(ssh -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=12 -i "$key" "$host")
remote=/tmp/jb-tags-$$.sh
# Without carriage returns: a checkout that hands the script out with CRLF (Windows, autocrlf) would have bash on the
# build host refuse its first line (`set -euo pipefail`).
tr -d '\r' < "$here/remote/tags.sh" | "${SSH[@]}" "cat > $remote"
trap '"${SSH[@]}" "rm -f $remote" || true' EXIT
pass() { "${SSH[@]}" "ORGS='$*' PORT=$port CHECKOUT=$checkout EXECUTE=${mode:-} bash $remote"; }
echo "[$(date -u +%T)] ${execute:+writing }tags for: $*"
mode=$execute; pass "$@"
if [[ -n $execute ]]; then
  echo "[$(date -u +%T)] dry again: every org must need 0"
  mode=''; out=$(pass "$@"); echo "$out"
  if grep -q -E 'needing tag updates: [1-9]' <<<"$out"; then echo "NOT DONE: products still need tags"; exit 1; fi
  echo "tags done: nothing left to tag"
fi
