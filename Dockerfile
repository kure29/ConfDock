# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.14.0
ARG RUST_VERSION=1.88.0
ARG DEBIAN_VERSION=bookworm-slim
ARG VERSION=1.0.0

FROM node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de AS node-toolchain

ARG NODE_VERSION
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH
RUN if [ "${TARGETPLATFORM}" != "linux/amd64" ] \
      || [ "${TARGETOS}" != "linux" ] \
      || [ "${TARGETARCH}" != "amd64" ] \
      || [ "$(node -p 'process.arch')" != "x64" ]; then \
      echo 'ConfDock Docker builds currently support Linux amd64 only' >&2; \
      exit 1; \
    fi
RUN if [ "${NODE_VERSION}" != "22.14.0" ] || [ "$(node --version)" != "v22.14.0" ]; then \
      echo 'Node.js 22.14.0 is required' >&2; \
      exit 1; \
    fi

FROM rust:1.88.0-bookworm@sha256:4727898c104ecd2e22d780925832502faee9fe4e70581b8572af081370b315a0 AS builder
ARG RUST_VERSION
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    CONFDOCK_REQUIRE_NODE_VERSION=22.14.0
WORKDIR /src

RUN if [ "${RUST_VERSION}" != "1.88.0" ] \
      || [ "${TARGETPLATFORM}" != "linux/amd64" ] \
      || [ "${TARGETOS}" != "linux" ] \
      || [ "${TARGETARCH}" != "amd64" ] \
      || ! rustc --version | grep -Eq '^rustc 1\.88\.0 \(' \
      || ! cargo --version | grep -Eq '^cargo 1\.88\.0 \(' \
      || ! rustc -vV | grep -Eq '^host: x86_64-unknown-linux-gnu$'; then \
      echo 'Rust/Cargo 1.88.0 is required' >&2; \
      exit 1; \
    fi

# Copy Node 22 (including npm's launcher and its library) into the Rust
# builder. Node, npm, Cargo, and all source material remain in intermediate
# layers and are never copied to runtime.
COPY --from=node-toolchain /usr/local /usr/local

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    rustup target add wasm32-unknown-unknown --toolchain ${RUST_VERSION} \
    && RUSTUP_TOOLCHAIN=${RUST_VERSION} cargo install wasm-bindgen-cli --version 0.2.127 --locked

# Manifests are copied before sources to keep dependency layers cacheable.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/confdock-core/Cargo.toml crates/confdock-core/Cargo.toml
COPY crates/confdock-service/Cargo.toml crates/confdock-service/Cargo.toml
COPY crates/confdock-validator/Cargo.toml crates/confdock-validator/Cargo.toml
COPY crates/confdock-wasm/Cargo.toml crates/confdock-wasm/Cargo.toml
COPY web/package.json web/package-lock.json web/
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --prefix web --ignore-scripts

COPY . .

# This repository script enforces Node 22.14.0 for this Docker build,
# Rust/Cargo 1.88.0,
# wasm-bindgen 0.2.127, a clean web/dist, and embedded production assets.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/root/.npm,sharing=locked \
    lock_before="$(sha256sum Cargo.lock web/package-lock.json)" \
    && ./scripts/build-single-binary.sh \
    && test "${lock_before}" = "$(sha256sum Cargo.lock web/package-lock.json)"

FROM debian:bookworm-slim@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867 AS runtime

ARG VCS_REF=unknown
ARG VERSION
ARG BUILD_DATE=unknown
ARG DEBIAN_VERSION
ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH

# Keep the runtime user space explicit. The FROM manifest is the verified
# Linux amd64 digest for the named Debian release, and runtime packages are
# installed only from the fixed 2026-08-24 Debian Snapshot below.
RUN if [ "${DEBIAN_VERSION}" != "bookworm-slim" ]; then \
      echo 'Debian bookworm-slim is required for the runtime image' >&2; \
      exit 1; \
    elif [ "${TARGETPLATFORM}" != "linux/amd64" ] \
      || [ "${TARGETOS}" != "linux" ] \
      || [ "${TARGETARCH}" != "amd64" ] \
      || [ "$(dpkg --print-architecture)" != "amd64" ]; then \
      echo 'ConfDock Docker images currently support Linux amd64 only' >&2; \
      exit 1; \
    fi

RUN if [ "${VCS_REF}" != "unknown" ] \
      && ! printf '%s' "${VCS_REF}" | grep -Eq '^[0-9a-fA-F]{7,64}$'; then \
      echo 'VCS_REF must be a Git commit SHA or unknown' >&2; \
      exit 1; \
    fi

RUN if [ "${VERSION}" != "1.0.0" ]; then \
      echo 'ConfDock VERSION must be 1.0.0 for this source tree' >&2; \
      exit 1; \
    elif [ "${BUILD_DATE}" != "unknown" ] \
      && ! printf '%s' "${BUILD_DATE}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then \
      echo 'BUILD_DATE must be an RFC 3339 UTC timestamp or unknown' >&2; \
      exit 1; \
    fi

LABEL org.opencontainers.image.title="ConfDock" \
      org.opencontainers.image.description="Self-hosted native configuration manager" \
      org.opencontainers.image.url="https://github.com/kure29/ConfDock" \
      org.opencontainers.image.source="https://github.com/kure29/ConfDock" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# curl is used by the healthcheck; sqlite3 and tar are used by the
# maintenance/restore flow. The final stage has no compiler,
# package-manager cache, Node.js, Cargo, source tree, or build output.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
    && printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260824T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260824T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260824T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && DEBIAN_FRONTEND=noninteractive apt-get \
      -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends --yes \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
      findutils=4.9.0-4 \
      passwd=1:4.13+dfsg1-1+deb12u2 \
      sqlite3=3.40.1-2+deb12u2 \
      tar=1.34+dfsg-1.2+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/* \
    && groupadd --gid 10001 confdock \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin confdock \
    && install --directory --owner=10001 --group=10001 --mode=0700 /var/lib/confdock \
    && install --directory --owner=10001 --group=10001 --mode=0700 /tmp

COPY --from=builder /src/target/confdock-rust-1.88.0/native/release/confdock /usr/local/bin/confdock
COPY LICENSE /LICENSE
COPY THIRD_PARTY_NOTICES.md /THIRD_PARTY_NOTICES.md
COPY deploy/docker/config.toml /etc/confdock/config.toml
COPY scripts/volume-init.sh /usr/local/libexec/confdock-volume-init

RUN chown root:root /usr/local/bin/confdock /usr/local/libexec/confdock-volume-init \
      /LICENSE /THIRD_PARTY_NOTICES.md /etc/confdock/config.toml \
    && chmod 0755 /usr/local/bin/confdock /usr/local/libexec/confdock-volume-init \
    && chmod 0644 /LICENSE /THIRD_PARTY_NOTICES.md /etc/confdock/config.toml

USER 10001:10001
WORKDIR /var/lib/confdock
VOLUME ["/var/lib/confdock"]

EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/confdock"]
CMD ["--config", "/etc/confdock/config.toml"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:8787/healthz"]
