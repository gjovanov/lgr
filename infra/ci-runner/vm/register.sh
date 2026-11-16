#!/bin/bash
# Runs INSIDE the guest, with a registration token on stdin (never on a command line).
# The README's recipe, for the one runner of this guest.
set -euo pipefail
i=1
sudo docker volume create gh-runner-lgr-$i-state >/dev/null
sudo docker run --rm -i --user root --entrypoint sh \
  -v gh-runner-lgr-$i-state:/s gh-runner-lgr:2.338.0 \
  -c 'umask 077; cat > /s/registration-token; chown -R 10001:10001 /s; chmod 700 /s; echo "token stored: $(wc -c < /s/registration-token) bytes"'
sudo docker run -d --name gh-runner-lgr-$i --restart unless-stopped \
  --cpus 8 --memory 8g --pids-limit 8192 \
  --tmpfs /tmp:rw,exec,nosuid,size=3g \
  -e REPO_URL=https://github.com/gjovanov/lgr \
  -e RUNNER_NAME=jupiter-lgr-$i \
  -e RUNNER_LABELS=lgr-linux,lgr-jupiter \
  -v gh-runner-lgr-$i-state:/runner-state \
  gh-runner-lgr:2.338.0
