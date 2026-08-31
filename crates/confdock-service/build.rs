use std::{env, path::PathBuf};

fn main() {
    if env::var_os("CARGO_FEATURE_EMBEDDED_WEB").is_none() {
        return;
    }

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest_dir.join("../../web/dist");
    let index = dist.join("index.html");
    if !index.is_file() {
        panic!("embedded-web requires web/dist/index.html; run `npm run build --prefix web` first");
    }
    println!("cargo:rerun-if-changed={}", dist.display());
}
