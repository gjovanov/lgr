# Self-hosted GitHub Actions runner for this repository's Linux CI, run on mars.
#
# Why: lgr is private, so GitHub-hosted minutes come out of the account's monthly allowance, and in
# October 2026 they ran out on the 7th; GitHub then refused every job, the Linux gate included. A
# self-hosted runner's minutes are free. See README.md here.
#
# The official actions/runner release, SHA-256 checked (the digest is the one GitHub publishes in
# the release notes). Jobs run INSIDE this container as the unprivileged `runner` user, whose
# `sudo` is container-local: a workflow's `sudo apt-get install` never touches mars itself.
FROM ubuntu:24.04

ARG RUNNER_VERSION=2.338.0
ARG RUNNER_SHA256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32

ENV DEBIAN_FRONTEND=noninteractive

# What the hosted ubuntu image provides that these workflows lean on without saying so: git, curl,
# jq, zstd (actions/cache), xz/unzip (tool downloads), a C toolchain + pkg-config + OpenSSL headers
# (cargo), python3, and libcurl4 (the mongod that mongodb-memory-server downloads links it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq sudo unzip xz-utils zip zstd \
      build-essential pkg-config libssl-dev libcurl4 python3 \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash runner \
 && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner

WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tgz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  runner.tgz" | sha256sum -c - \
 && tar xzf runner.tgz \
 && rm runner.tgz \
 && ./bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
# A Windows checkout loses the exec bit, so set it here rather than trusting the build context.
RUN chmod 0755 /home/runner/entrypoint.sh
USER runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
