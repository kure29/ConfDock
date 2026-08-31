use axum::{
    extract::Path,
    http::{header, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist/"]
struct WebAssets;

pub async fn index(method: Method) -> Response {
    serve("index.html", &method)
}

pub async fn favicon(method: Method) -> Response {
    serve("favicon.svg", &method)
}

pub async fn file(Path(path): Path<String>, method: Method) -> Response {
    let path = path.trim_start_matches('/');
    let key = if WebAssets::get(path).is_some() {
        path.to_owned()
    } else {
        format!("assets/{path}")
    };
    serve(&key, &method)
}

pub async fn icon(Path(path): Path<String>, method: Method) -> Response {
    let path = path.trim_start_matches('/');
    serve(&format!("client-icons/{path}"), &method)
}

pub async fn fallback(method: Method, uri: Uri) -> Response {
    let path = uri.path();
    let relative = path.strip_prefix('/').unwrap_or(path);
    if !matches!(method.as_str(), "GET" | "HEAD")
        || path == "/api"
        || path.starts_with("/api/")
        || path == "/sub"
        || path.starts_with("/sub/")
        || path == "/healthz"
        || path.contains('%')
        || relative
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.'))
    {
        return not_found();
    }
    serve("index.html", &method)
}

fn serve(path: &str, method: &Method) -> Response {
    if !matches!(method.as_str(), "GET" | "HEAD")
        || path.is_empty()
        || path.contains('%')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return not_found();
    }

    let Some(file) = WebAssets::get(path) else {
        return not_found();
    };
    let bytes = file.data.into_owned();
    let content_type = content_type(path);
    let cache_control = cache_control(path);
    let mut response = Response::new(if *method == Method::HEAD {
        axum::body::Body::empty()
    } else {
        axum::body::Body::from(bytes)
    });
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    if let Some(length) = WebAssets::get(path).map(|file| file.data.len()) {
        if let Ok(value) = HeaderValue::try_from(length.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, value);
        }
    }
    response
}

fn not_found() -> Response {
    let mut response = StatusCode::NOT_FOUND.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn content_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn cache_control(path: &str) -> &'static str {
    if path == "index.html" {
        "no-cache"
    } else if is_hashed_asset(path) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn is_hashed_asset(path: &str) -> bool {
    if !path.starts_with("assets/") {
        return false;
    }
    let Some(file_name) = path.rsplit('/').next() else {
        return false;
    };
    let Some(stem) = file_name.rsplit_once('.').map(|(stem, _)| stem) else {
        return false;
    };
    // Vite's base64url digest may itself contain `-`, so split at the first
    // separator rather than treating only the final segment as the hash.
    let Some((_, hash)) = stem.split_once('-') else {
        return false;
    };
    hash.len() >= 8
        && hash
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_assets_use_immutable_cache_only_when_the_name_is_hashed() {
        assert!(is_hashed_asset("assets/index-AbCd1234.js"));
        assert!(is_hashed_asset("assets/index-C0P-BXNx.js"));
        assert!(!is_hashed_asset("assets/index.js"));
        assert!(!is_hashed_asset("client-icons/mihomo.png"));
        assert_eq!(cache_control("index.html"), "no-cache");
    }

    #[test]
    fn embedded_manifest_contains_production_assets() {
        let paths = WebAssets::iter().collect::<Vec<_>>();
        assert!(paths.iter().any(|path| path == "index.html"));
        assert!(paths.iter().any(|path| path.starts_with("assets/")));
    }

    #[test]
    fn supported_raster_and_wasm_mime_types_are_explicit() {
        assert_eq!(
            content_type("assets/app.js"),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(content_type("assets/app.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("assets/core.wasm"), "application/wasm");
        assert_eq!(content_type("client-icons/client.png"), "image/png");
        assert_eq!(content_type("client-icons/client.webp"), "image/webp");
    }
}
