# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.14.0
ARG RUST_VERSION=1.88.0
ARG DEBIAN_VERSION=bookworm-slim

FROM node:${NODE_VERSION}-bookworm-slim AS node-toolchain

FROM rust:${RUST_VERSION}-bookworm AS builder
ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup
WORKDIR /src

# Copy only Node 22 into the Rust builder. Node, npm, Cargo, and all source
# material remain in intermediate layers and are never copied to runtime.
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=node-toolchain /usr/local/bin/npm /usr/local/bin/npm
COPY --from=node-toolchain /usr/local/bin/npx /usr/local/bin/npx
COPY --from=node-toolchain /usr/local/lib/node_modules /usr/local/lib/node_modules

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

# This repository script enforces Node 22, Rust/Cargo 1.88.0,
# wasm-bindgen 0.2.127, a clean web/dist, and embedded production assets.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/root/.npm,sharing=locked \
    ./scripts/build-single-binary.sh

FROM debian:${DEBIAN_VERSION} AS runtime

ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="ConfDock" \
      org.opencontainers.image.description="Self-hosted native configuration manager" \
      org.opencontainers.image.url="https://github.com/kure29/ConfDock" \
      org.opencontainers.image.source="https://github.com/kure29/ConfDock" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV DEBIAN_FRONTEND=noninteractive

# curl is used only by the healthcheck. The final stage has no compiler,
# package-manager cache, Node.js, Cargo, source tree, or build output.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 confdock \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin confdock \
    && install --directory --owner=10001 --group=10001 --mode=0700 /var/lib/confdock \
    && install --directory --owner=10001 --group=10001 --mode=0700 /tmp

COPY --from=builder /src/target/confdock-rust-1.88.0/native/release/confdock /usr/local/bin/confdock
COPY LICENSE /LICENSE
COPY deploy/docker/config.toml /etc/confdock/config.toml

RUN chown root:root /usr/local/bin/confdock /LICENSE /etc/confdock/config.toml \
    && chmod 0755 /usr/local/bin/confdock \
    && chmod 0644 /LICENSE /etc/confdock/config.toml

USER 10001:10001
WORKDIR /var/lib/confdock
VOLUME ["/var/lib/confdock"]

EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/confdock"]
CMD ["--config", "/etc/confdock/config.toml"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:8787/healthz"]
