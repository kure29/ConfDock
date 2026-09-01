# Third-party license inventory

This file is a dependency inventory for development and release preparation.
It is not the complete third-party notices artifact distributed with a release.

ConfDock itself is Apache-2.0. This inventory does not relicense dependencies,
replace their upstream license files, or claim that every required copyright
statement and attribution has already been collected.

## Reproducible scope

The snapshot below was checked against the committed `Cargo.lock` and
`web/package-lock.json`. The supported executable inputs are the Linux x86-64
`confdock-service` graph and the `wasm32-unknown-unknown` `confdock-wasm` graph.

```bash
cargo tree --locked -p confdock-service \
  --target x86_64-unknown-linux-gnu -e normal --prefix none --format '{p}'
cargo tree --locked -p confdock-wasm \
  --target wasm32-unknown-unknown -e normal --prefix none --format '{p}'
cargo metadata --locked --format-version 1
npm ci --prefix web
npm ls --all --prefix web --json
```

`Cargo.lock` currently contains 266 registry package records across all
platforms and dependency kinds. The union of the two target-specific normal
dependency commands above contains 227 unique registry package/version
records plus three ConfDock workspace crates. These counts describe lock and
build inputs; they are not a substitute for a release notice or a claim that
every record is linked into the final executable.

The npm lockfile contains 152 installed package records: 141 MIT, 3
Apache-2.0, 6 ISC, 1 BSD-3-Clause, and 1 CC-BY-4.0.

## Rust runtime dependency inputs

The workspace manifests declare the following external direct normal
dependencies. Optional `rust-embed` is enabled for the distributed
single-binary build.

| Crate | Locked version | Published license expression |
| --- | ---: | --- |
| argon2 | 0.5.3 | MIT OR Apache-2.0 |
| axum | 0.8.9 | MIT |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| clap | 4.6.6 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| rpassword | 7.5.4 | Apache-2.0 |
| rust-embed | 8.12.0 | MIT |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| serde-wasm-bindgen | 0.6.5 | MIT |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| similar | 2.7.0 | Apache-2.0 |
| sqlx | 0.8.6 | MIT OR Apache-2.0 |
| thiserror | 2.0.20 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| tokio | 1.53.1 | MIT |
| toml | 1.1.4+spec-1.1.0 | MIT OR Apache-2.0 |
| tracing | 0.1.44 | MIT |
| tracing-subscriber | 0.3.23 | MIT |
| url | 2.5.8 | MIT OR Apache-2.0 |
| uuid | 1.26.0 | Apache-2.0 OR MIT |
| wasm-bindgen | 0.2.127 | MIT OR Apache-2.0 |
| yaml-rust2 | 0.12.0 | MIT OR Apache-2.0 |

The target-specific normal graphs currently contain permissive expressions
including MIT, Apache-2.0, BSD-2-Clause/BSD-3-Clause, ISC, Zlib, Unicode-3.0,
Unlicense, and BSL-1.0 combinations. A formal release process must still
resolve every dual-license choice and retain the applicable upstream text.
The all-platform lockfile also contains target-specific expressions such as
`r-efi`'s `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; a supported release target
must record the permissive choice explicitly rather than silently treating the
whole lockfile as Apache-2.0.

## Rust build and test dependency inputs

The workspace manifests declare no direct build dependencies. The service
crate declares three direct development dependencies used by tests:

| Crate | Locked version | Published license expression |
| --- | ---: | --- |
| http-body-util | 0.1.5 | MIT |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| tower | 0.5.3 | MIT |

Transitive procedural-macro, build, test, and unsupported-target records remain
in `Cargo.lock` for reproducibility. They are not presented here as content of
the released runtime artifact.

## Web runtime dependency inputs

The production dependency closure contains seven package records, all MIT:

| Package | Locked version |
| --- | ---: |
| react | 19.2.8 |
| react-dom | 19.2.8 |
| scheduler | 0.27.0 |
| react-router-dom | 7.18.3 |
| react-router | 7.18.3 |
| cookie | 1.1.1 |
| set-cookie-parser | 2.7.2 |

## Web build and test dependency inputs

The other 145 npm lockfile records support development, typechecking, testing,
or bundling. This includes `caniuse-lite` 1.0.30001810, which is marked as a
development dependency and publishes `CC-BY-4.0`. Its browser-compatibility
data originates from caniuse.com. The current production bundle inspection did
not identify `caniuse-lite` as a runtime module, but the Release Slice must
repeat that check and include the required attribution if any of its material
is distributed.

## Static third-party resources

ConfDock currently distributes no third-party client logos or client icon
image files. The client markers are original CSS text markers maintained by
ConfDock. No third-party font or remote runtime image is required by those
markers.

## Release blocker

Before the first public Release, a complete third-party notices artifact must
be generated from the fixed `Cargo.lock` and `package-lock.json`. It must
include the license texts, copyright statements, and attributions required by
the dependencies actually distributed, and CI must fail for unknown or
restricted licenses. That formal artifact is deferred to the Release Slice and
remains a Release blocker.
