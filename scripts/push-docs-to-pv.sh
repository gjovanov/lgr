#!/usr/bin/env bash
# One-time transfer of the local _docs date folders into the lgr pod's PV, preserving the
# <date>/<file> layout. PDF + XLSX only (compare-*.csv/txt and versions/ are excluded).
# Then run scripts/register-docs-in-pv.ts INSIDE the pod to create the DocFile rows.
#
#   ORGID=6a5ddbafdf2fc7b03bf596d2 bash scripts/push-docs-to-pv.sh
set -euo pipefail
DOCS="${DOCS:-//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs}"
: "${ORGID:?set ORGID (regal-pz org id)}"
SSH="ssh -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519 mars"
DEST="/app/uploads/$ORGID/docs"

cd "$DOCS"
DATEDIRS=$(ls -d 2026-*/ 2>/dev/null | tr -d '/' || true)
[ -n "$DATEDIRS" ] || { echo "no 2026-* date folders under $DOCS"; exit 1; }
echo "date folders ($(echo "$DATEDIRS" | wc -l)):"; echo "$DATEDIRS" | tr '\n' ' '; echo
FILES=$(find $DATEDIRS -type f \( -iname '*.pdf' -o -iname '*.xlsx' \) 2>/dev/null | wc -l)
echo "pdf/xlsx files to transfer: $FILES"

# shellcheck disable=SC2086
tar czf - --exclude='*.csv' --exclude='*.txt' --exclude='versions' $DATEDIRS \
  | $SSH "kubectl -n lgr exec -i deploy/lgr -- sh -c 'mkdir -p $DEST && tar xzf - -C $DEST && echo POD: \$(find $DEST -type f \( -iname \"*.pdf\" -o -iname \"*.xlsx\" \) | wc -l) files now on PV'"
echo "transfer done."
