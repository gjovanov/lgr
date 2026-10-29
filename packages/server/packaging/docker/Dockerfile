# syntax=docker/dockerfile:1
# LGR Server as an image (FR-20.12, gjovanov/lgr#367, option A): the .deb's own home, run the way its
# systemd unit runs it, so a master from Compose or Kubernetes is the same server as a .deb install:
# - /opt/lgr-server/versions/<v>/ with `current` pointing at it, laid out by the package's own postinst;
# - the supervisor as the main process, mongod and the API its children, all as the user `lgr`;
# - the data on ONE volume, /var/lib/lgr: the database, the keys, the backups, config/api.env;
# - the host's network (`network_mode: host`, `hostNetwork: true`): the setup console and mongod on
#   the host's loopback, the LAN ingress on the host's 4443, and DNS-SD multicast, which a bridge
#   network does not carry.
# An image is updated by its tag: `lgr-server update apply` refuses inside a container.
#
# Built by .github/workflows/server-release.yml from the .deb that run made, as the build context's
# lgr-server.deb:
#   docker build --build-arg VERSION=<v> -t ghcr.io/gjovanov/lgr-server:<v> \
#     -f packages/server/packaging/docker/Dockerfile <a directory holding lgr-server.deb>

# The .deb's own base, pinned; its packages are brought up to date at every build, below.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ARG VERSION
# ⚠ FIXED, so a volume's owner and a pod's runAsUser stay right from one image to the next. The
# package's postinst makes `lgr` only when there is none, so this one is made first.
ARG LGR_UID=10001
ARG LGR_GID=10001

LABEL org.opencontainers.image.title="LGR Server" \
      org.opencontainers.image.description="The on-premises master of LGR: the API and its apps, MongoDB, the PDF renderer and the link to lgrai.app, supervised as one process" \
      org.opencontainers.image.source="https://github.com/gjovanov/lgr" \
      org.opencontainers.image.url="https://lgrai.app" \
      org.opencontainers.image.vendor="G ROX LTD" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary AND SSPL-1.0"

RUN groupadd --system --gid "${LGR_GID}" lgr \
 && useradd --system --uid "${LGR_UID}" --gid lgr --home-dir /var/lib/lgr --no-create-home --shell /usr/sbin/nologin lgr

# The .deb is bind-mounted, never copied: a COPY would keep its few hundred MB in a layer for good.
# - LGR_SERVER_IMAGE_BUILD=1: the preinst's machine check (AC 14) would measure THIS build machine.
#   The container checks the machine it runs on, at every start (`lgr-server preflight`).
# - The installer's copy of the bundle goes: its version is unpacked into versions/<v>/, and an image
#   never installs another one.
# - tini: PID 1. tzdata: TZ names the shop's zone. ca-certificates: the supervisor trusts lgrai.app
#   through the OS's roots. The fonts are the package's Recommends (Cyrillic in printed documents).
RUN --mount=type=bind,source=lgr-server.deb,target=/tmp/lgr-server.deb \
    set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get -y upgrade; \
    LGR_SERVER_IMAGE_BUILD=1 apt-get install -y --no-install-recommends \
      /tmp/lgr-server.deb tini tzdata ca-certificates fonts-dejavu-core fonts-liberation; \
    rm -f /opt/lgr-server/installer/lgr-server-bundle.tar.gz; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -o lgr -g lgr -m 0750 /run/lgr-server; \
    test "$(readlink /opt/lgr-server/current)" = "versions/${VERSION}"; \
    test "$(id -u lgr):$(id -g lgr)" = "${LGR_UID}:${LGR_GID}"; \
    /opt/lgr-server/current/lgr-server --version

# LGR_SERVER_IMAGE: what `update apply` and the status name when they say how this server updates.
ENV LGR_SERVER_DATA=/var/lib/lgr \
    LGR_SERVER_IMAGE=ghcr.io/gjovanov/lgr-server
VOLUME ["/var/lib/lgr"]
WORKDIR /var/lib/lgr
USER lgr:lgr

# What `docker stop` and Kubernetes send. The supervisor stops the API, which finishes a receipt in
# flight, and mongod, which writes its last checkpoint, as on systemd's stop: give it the unit's 30 s
# (`stop_grace_period`, `terminationGracePeriodSeconds`).
STOPSIGNAL SIGTERM

# The API serving under the supervisor, as the release's install tests ask it. For `docker ps` and
# `depends_on`: nothing restarts a master for it.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
  CMD lgr-server status --json 2>/dev/null | grep -qz '"name": *"api"[^}]*"state": *"running"' || exit 1

# tini reaps what is orphaned to it (Chrome's helpers, as in the lgr image) and passes SIGTERM on.
# `-s`: still the reaper under another init (`docker run --init`). ⚠ No `-g`: the supervisor stops
# its children's process groups itself.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/lgr-server/current/lgr-server"]
CMD ["run"]
