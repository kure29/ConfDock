use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

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
    let index_source =
        fs::read_to_string(&index).expect("embedded-web requires a readable web/dist/index.html");
    if !index_source.contains("<div id=\"root\"></div>")
        || index_source.contains("/src/")
        || index_source.contains("sourceMappingURL")
    {
        panic!("web/dist/index.html is not a Vite production build");
    }

    // Cargo does not reliably notice a file being replaced when only the
    // directory mtime is watched. Register every generated file so changing
    // or replacing any asset forces rust-embed to run again.
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut files = Vec::new();
    collect_files(&dist, &mut files).expect("embedded-web could not scan web/dist");
    for file in files {
        if file
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(" 2."))
        {
            panic!(
                "web/dist contains a duplicate stale asset: {}",
                file.display()
            );
        }
        if file
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("map"))
        {
            panic!("web/dist contains a source map: {}", file.display());
        }
        println!("cargo:rerun-if-changed={}", file.display());
    }
}

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            panic!("web/dist contains a symlink: {}", path.display());
        }
        if metadata.is_dir() {
            collect_files(&path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }
    Ok(())
}
