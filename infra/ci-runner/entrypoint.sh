#!/bin/bash
# Registers with GitHub ONCE, then keeps the runner's identity in /runner-state across restarts and
# image rebuilds, so a restarted container needs no new registration token.
#
# Expects: REPO_URL, RUNNER_NAME, RUNNER_LABELS, and a mounted /runner-state holding either the
# saved identity (.runner, .credentials, .credentials_rsaparams) or, on first start only, a
# `registration-token` file. That file is deleted as soon as it has been used: the token is
# short-lived, and nothing should keep it.
set -euo pipefail

cd /home/runner/actions-runner
state=/runner-state

if [ -f "$state/.runner" ]; then
  cp -a "$state/.runner" "$state/.credentials" "$state/.credentials_rsaparams" .
else
  token_file="$state/registration-token"
  if [ ! -s "$token_file" ]; then
    echo "no saved runner identity in $state and no $token_file to register with" >&2
    exit 1
  fi
  # ⚠ The SAME work folder as GitHub's hosted runners. actions/cache stores paths relative to the
  # workspace, so a cache saved on a hosted runner (/home/runner/work/lgr/lgr) and restored here
  # under the default `_work` (two levels deeper) unpacks `~/.bun` to the wrong directory, and
  # setup-bun then fails with "Unable to locate executable file" (first run, 2026-10-10).
  ./config.sh --unattended \
    --url "$REPO_URL" \
    --token "$(cat "$token_file")" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --work /home/runner/work \
    --replace
  cp -a .runner .credentials .credentials_rsaparams "$state/"
  rm -f "$token_file"
fi

exec ./run.sh
