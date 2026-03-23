#!/bin/bash
# Run the full walkthrough E2E test with video recording against production
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RECORDINGS_DIR="/home/gjovanov/_recordings"

mkdir -p "$RECORDINGS_DIR"

echo "Running full E2E walkthrough against ${BASE_URL:-https://lgrai.app}..."
echo "Video will be recorded to test-results/"

cd "$E2E_DIR"
BASE_URL="${BASE_URL:-https://lgrai.app}" bunx playwright test \
  --project=full-walkthrough \
  --reporter=list \
  2>&1 | tee "$RECORDINGS_DIR/walkthrough-$(date +%Y%m%d-%H%M%S).log"

# Convert recorded videos from WebM to MP4
echo "Converting videos..."
for webm in test-results/*/video.webm; do
  if [ -f "$webm" ]; then
    mp4="${RECORDINGS_DIR}/lgr-walkthrough-$(date +%Y%m%d-%H%M%S).mp4"
    ffmpeg -y -i "$webm" -c:v libx264 -preset fast -crf 23 "$mp4" 2>/dev/null
    echo "Video saved: $mp4"
  fi
done

echo "Done! Recordings in $RECORDINGS_DIR"
