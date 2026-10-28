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

# Headless Chrome's runtime libraries and fonts. The reporting tests render PDFs through
# Puppeteer's bundled Chrome, which the hosted image can start and a minimal one cannot: the first
# run here failed every PDF test with "libglib-2.0.so.0: cannot open shared object file". Names are
# noble's (the t64 transition renamed several).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-dejavu-core libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
      libcairo2 libcups2t64 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0t64 libgtk-3-0t64 \
      libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
      libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 \
      libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6 xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# ⚠ An explicit UID that no account on mars uses. A default `useradd` took 1001, which on mars is a
# real person's account, so the runner's state (its credentials included) would have belonged to
# them on the host. The state also lives in named volumes, under the root-only /var/lib/docker.
RUN useradd -m -u 10001 -s /bin/bash runner \
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
