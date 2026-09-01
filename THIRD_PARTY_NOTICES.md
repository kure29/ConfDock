# Third-party notices

This file records the third-party software and static resources that are part
of the ConfDock source tree and of the Linux x86-64 / WASM build described by
the current `Cargo.lock` and `web/package-lock.json`. ConfDock itself is
Apache-2.0; this file does not relicense any dependency.

There is no root `NOTICE` file because the project does not currently carry a
project-owned upstream NOTICE requirement. If a future dependency requires
one, add its real attribution text here (or in a generated release notice)
instead of creating an empty placeholder.

## How this snapshot was checked

The Rust list was resolved from the lock file with Cargo's package metadata
for both supported build targets:

```bash
cargo tree --locked --target x86_64-unknown-linux-gnu
cargo tree --locked --target wasm32-unknown-unknown
cargo metadata --locked --format-version 1
```

The Web list comes from the `license` fields in the npm lockfile (lockfile
version 3):

```bash
npm ci --prefix web
npm ls --all --prefix web --json
```

When dependency versions change, regenerate this snapshot from those files and
review any new or changed license expression before publishing. Do not infer a
license from a package name, `npm audit`, or a missing field. A release job must
also include the applicable upstream license texts and copyright notices in
the distribution archive.

## Rust crates

Direct dependencies are listed here with the license expression published in
their Cargo package metadata. Their transitive dependencies are resolved by
`Cargo.lock`; the target-relevant snapshot contained 185 registry packages.

| Crate | Version | License expression |
| --- | ---: | --- |
| argon2 | 0.5.3 | MIT OR Apache-2.0 |
| axum | 0.8.9 | MIT |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| clap | 4.6.6 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| rpassword | 7.5.4 | Apache-2.0 |
| rust-embed | 8.12.0 | MIT |
| serde / serde_json | 1.0.229 / 1.0.151 | MIT OR Apache-2.0 |
| serde-wasm-bindgen | 0.6.5 | MIT |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| similar | 2.7.0 | Apache-2.0 |
| sqlx | 0.8.6 | MIT OR Apache-2.0 |
| thiserror | 2.0.20 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| tokio | 1.53.1 | MIT |
| toml | 1.1.4+spec-1.1.0 | MIT OR Apache-2.0 |
| tracing / tracing-subscriber | 0.1.44 / 0.3.23 | MIT |
| url | 2.5.8 | MIT OR Apache-2.0 |
| uuid | 1.26.0 | Apache-2.0 OR MIT |
| wasm-bindgen | 0.2.127 | MIT OR Apache-2.0 |
| yaml-rust2 | 0.12.0 | MIT OR Apache-2.0 |

The target-relevant transitive set uses only permissive expressions observed in
the lockfile metadata: MIT, Apache-2.0, BSD-2-Clause/BSD-3-Clause, Zlib,
Unicode-3.0, Unlicense, and BSL-1.0 combinations. No GPL, AGPL, SSPL,
Commons Clause, or unknown license was found in the Linux x86-64 or WASM
dependency trees. Windows/Redox-only lockfile entries are not part of those
artifacts and must be rechecked if another target is added.

## npm packages

The Web bundle and its build/test tools resolve 152 packages in the current
lockfile: 141 MIT, 3 Apache-2.0, 6 ISC, 1 BSD-3-Clause, and 1 CC-BY-4.0. The
direct runtime packages are:

| Package | Version | License |
| --- | ---: | --- |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-router-dom | 7.18.3 | MIT |

Build and test packages (including Vite, Vitest, TypeScript, esbuild, Rollup,
React plugin, and their transitive packages) are development dependencies but
are included in the lockfile snapshot so a source checkout can reproduce the
audit. No GPL, AGPL, SSPL, Commons Clause, or unknown npm license was present.

## Static resources

ConfDock bundles five nominative PNGs for non-Mihomo targets under
`web/public/client-icons/`. Their source pages, revisions, processing notes,
and trademark limitations are recorded in
[`web/public/client-icons/SOURCES.md`](web/public/client-icons/SOURCES.md).
Mihomo has no bundled third-party artwork: its picker marker is a neutral `M`
implemented with ConfDock CSS. There are no bundled third-party fonts, Base64
images, or remote runtime asset requests.

No additional legal review was identified for the verified Linux/WASM and Web
sets. Any future dependency, icon, font, target, or release platform with a
different license expression requires a fresh review; do not silently classify
it as Apache-2.0.
