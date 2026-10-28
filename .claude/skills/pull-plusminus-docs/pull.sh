#!/usr/bin/env bash
# Copy one business day's PlusMinus exports off a store PC into the _docs day
# folder the import skills read, byte-exact (SHA-256 checked).
#
#   pull.sh [--day YYYY-MM-DD] [--since 'YYYY-MM-DD HH:mm'] [--until '…']
#           [--dest DIR] [--device HEX] [--pm-root 'C:\...'] [--all-xlsx] [--list]
#
# The window is the PC's local (Sofia) time and selects by LAST WRITE, i.e. when
# the file was exported, not the document date. Default: the day 00:00 to the
# next day 06:00, so an export finished after midnight still belongs to its day.
# Only the newest export of each spreadsheet report is kept unless --all-xlsx.
#
# --pm-root is the PlusMinus CLIENT's own install folder ON THE STORE PC (its
# `exports\` and `exports\docs\<firm>\` live under it) — NOT --dest, which is
# the LOCAL _docs destination. Different stores install to different paths:
# regal-pz is `C:\plusminusPOS 1` (the default); regal-sf is `C:\plusminus7`
# (confirmed 2026-10-27 — `where /r C:\ plusminus.exe` on the device, rather
# than guessed from the server's own folder, which is a different, unrelated
# path even on the SAME machine at regal-pz: server=C:\pmserver, client=
# C:\plusminusPOS 1).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEVICE="${PM_DEVICE:-6a61228270bf9a4044cd615c}"   # Regal-Elena-PZ (hex id: the CLI never resolves display names reliably)
ROOT="${PM_DOCS_ROOT:-//wsl.localhost/Ubuntu-24.04/home/gjovanov/gjovanov/_docs/regal-pz}"
PMROOT="${PM_CLIENT_ROOT:-C:\\plusminusPOS 1}"
DAY=""; SINCE=""; UNTIL=""; LIST=0; ALLX=0
CHUNK=600000   # raw bytes per call: ~820 KB of base64, under roomler ssh's old 1 MiB stdout cap

while [ $# -gt 0 ]; do
  case "$1" in
    --day) DAY="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --dest) ROOT="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --pm-root) PMROOT="$2"; shift 2 ;;
    --all-xlsx) ALLX=1; shift ;;
    --list) LIST=1; shift ;;
    *) echo "pull.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -z "$DAY" ]; then
  DAY=$(bun -e "console.log(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia'}).format(new Date()))")
  echo "pull.sh: --day not given, using today in Sofia: $DAY" >&2
fi
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "pull.sh: bad --day $DAY" >&2; exit 2; }
[ -n "$SINCE" ] || SINCE="$DAY 00:00"
[ -n "$UNTIL" ] || UNTIL="$(date -d "$DAY +1 day" +%F) 06:00"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/parts" "$TMP/files"

# remote MODE NAMES OFFSET COUNT: run pull.ps1 on the PC, print its output (CR stripped).
remote() {
  local list="" n try
  for n in $2; do list+="'$n',"; done
  {
    printf "\$Mode='%s'; \$Since='%s'; \$Until='%s'; \$Names=@(%s); \$Offset=%s; \$Count=%s; \$PmRoot='%s'\n" \
      "$1" "$SINCE" "$UNTIL" "${list%,}" "$3" "$4" "$PMROOT"
    cat "$HERE/pull.ps1"
  } > "$TMP/run.ps1"
  local b64; b64=$(iconv -f UTF-8 -t UTF-16LE "$TMP/run.ps1" | base64 -w0)
  for try in 1 2 3 4 5; do
    MSYS_NO_PATHCONV=1 timeout 300 roomler ssh "$DEVICE" -- \
      powershell -NoProfile -NonInteractive -EncodedCommand "$b64" < /dev/null > "$TMP/out" 2> "$TMP/err"
    local rc=$?
    if grep -qi "too many SSH requests" "$TMP/out" "$TMP/err"; then
      echo "pull.sh: SSH rate limit, retrying in $((try * 15)) s" >&2; sleep $((try * 15)); continue
    fi
    tr -d '\r' < "$TMP/out"
    [ $rc -eq 0 ] || { echo "pull.sh: roomler ssh exited $rc: $(head -c 400 "$TMP/err")" >&2; return $rc; }
    return 0
  done
  echo "pull.sh: gave up after 5 rate-limited attempts" >&2; return 1
}

remote list "" 0 0 > "$TMP/manifest" || exit 1
grep -q '^END ' "$TMP/manifest" || { echo "pull.sh: manifest incomplete:" >&2; head -20 "$TMP/manifest" >&2; exit 1; }
grep '^LOCK ' "$TMP/manifest" | sed 's/^LOCK /pull.sh: WARNING an export is open in Excel on the PC: /' >&2

# name size sha mtime, newest spreadsheet per report unless --all-xlsx
grep '^FILE ' "$TMP/manifest" | cut -d' ' -f2- > "$TMP/all"
if [ $ALLX -eq 0 ]; then
  { grep -v '\.xlsx ' "$TMP/all"
    grep '\.xlsx ' "$TMP/all" | sort -k4 | awk '{split($1, a, "_"); last[a[1]] = $0} END {for (k in last) print last[k]}'
  } | sort > "$TMP/want"
else
  cp "$TMP/all" "$TMP/want"
fi

if [ ! -s "$TMP/want" ]; then
  echo "pull.sh: nothing exported between $SINCE and $UNTIL on the PC" >&2; exit 3
fi
if [ $LIST -eq 1 ]; then
  echo "# exported on the PC between $SINCE and $UNTIL"
  awk '{printf "%-42s %9s  %s  %s\n", $1, $2, substr($3, 1, 12), $4}' "$TMP/want"
  exit 0
fi

# Plan the calls: small files batched up to CHUNK bytes, big ones split into CHUNK ranges.
: > "$TMP/calls"; batch=""; sum=0
while read -r name size _; do
  if [ "$size" -gt $CHUNK ]; then
    off=0; while [ $off -lt "$size" ]; do echo "$name $off $CHUNK" >> "$TMP/calls"; off=$((off + CHUNK)); done
    continue
  fi
  if [ -n "$batch" ] && [ $((sum + size)) -gt $CHUNK ]; then echo "$batch 0 0" >> "$TMP/calls"; batch=""; sum=0; fi
  batch="${batch:+$batch,}$name"; sum=$((sum + size))
done < "$TMP/want"
[ -n "$batch" ] && echo "$batch 0 0" >> "$TMP/calls"

ncalls=$(wc -l < "$TMP/calls"); i=0
while read -r names off cnt; do
  i=$((i + 1)); echo "pull.sh: transfer $i/$ncalls" >&2
  remote get "${names//,/ }" "$off" "$cnt" > "$TMP/get" || exit 1
  grep -q '^DONE$' "$TMP/get" || { echo "pull.sh: transfer $i cut short" >&2; exit 1; }
  if grep -q '^MISSING ' "$TMP/get"; then grep '^MISSING ' "$TMP/get" >&2; exit 1; fi
  awk -v dir="$TMP/parts" '
    /^BEGIN / { f = sprintf("%s/%s.%012d.b64", dir, $2, $3); next }
    /^END /   { close(f); f = ""; next }
    f != ""   { print > f }' "$TMP/get"
  [ $i -lt "$ncalls" ] && sleep 2
done < "$TMP/calls"

# Reassemble in offset order and verify against the manifest before anything lands in the day folder.
bad=0
while read -r name size sha mtime; do
  for part in "$TMP/parts/$name".*.b64; do base64 -d "$part"; done > "$TMP/files/$name" 2>/dev/null
  got=$(sha256sum "$TMP/files/$name" | cut -d' ' -f1); len=$(stat -c %s "$TMP/files/$name")
  if [ "$got" != "$sha" ] || [ "$len" != "$size" ]; then
    echo "pull.sh: CHECKSUM MISMATCH $name ($len of $size bytes)" >&2; bad=1
  fi
done < "$TMP/want"
[ $bad -eq 0 ] || exit 1

DEST="$ROOT/$DAY"; mkdir -p "$DEST"
while read -r name size sha mtime; do
  if [ -f "$DEST/$name" ]; then
    if [ "$(sha256sum "$DEST/$name" | cut -d' ' -f1)" = "$sha" ]; then state=same; else state=REPLACED; fi
  else
    state=new
  fi
  [ "$state" = same ] || cp "$TMP/files/$name" "$DEST/$name"
  printf '%-9s %-42s %9s  %s\n' "$state" "$name" "$size" "$mtime"
done < "$TMP/want"
cp "$TMP/want" "$DEST/pull-manifest.txt"

# Per family: count and number range, with any gap inside the range named.
echo "--- $DEST"
for fam in invoicem invoiceProf stokrazp sklrazp sklisk; do
  nums=$(grep -oE "^${fam}_[0-9]+\.pdf" "$TMP/want" | grep -oE '[0-9]+' | sort -n)
  [ -n "$nums" ] || continue
  echo "$nums" | awk -v fam="$fam" '
    NR == 1 { first = $1 } { if (NR > 1 && $1 != prev + 1) gaps = gaps " " prev + 1 "-" $1 - 1; prev = $1 }
    END { printf "%-12s %3d  %s..%s%s\n", fam, NR, first, prev, gaps ? "  GAPS:" gaps : "" }'
done
grep -oE '^[A-Za-z]+_[0-9]{8}_[0-9]{6}\.xlsx' "$TMP/want" | sed 's/^/xlsx         /'
