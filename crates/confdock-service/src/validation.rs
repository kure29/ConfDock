use base64::{engine::general_purpose::STANDARD, Engine as _};
use confdock_core::TargetRegistry;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{dto::ValidationResultDto, error::ApiError};

pub const DEFAULT_TOKEN_DISPLAY_NAME: &str = "未命名地址";

pub fn token_display_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    let length = value.chars().count();
    if !(1..=64).contains(&length) || value.chars().any(char::is_control) {
        return Err(ApiError::token_invalid_name());
    }
    Ok(value.to_owned())
}

pub fn token_expiry(value: Option<&str>, now: i64) -> Result<Option<i64>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    let parsed =
        OffsetDateTime::parse(value, &Rfc3339).map_err(|_| ApiError::token_invalid_expiry())?;
    let timestamp = parsed.unix_timestamp();
    if timestamp <= now {
        return Err(ApiError::token_invalid_expiry());
    }
    Ok(Some(timestamp))
}

pub fn project_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    let length = value.chars().count();
    if !(1..=100).contains(&length) || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "project.invalid_name",
            "配置名称必须为 1 到 100 个字符，且不能包含控制字符",
        ));
    }
    Ok(value.to_owned())
}

pub fn file_name(value: &str) -> Result<String, ApiError> {
    let length = value.chars().count();
    if !(1..=255).contains(&length)
        || matches!(value, "." | "..")
        || value
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n' | '/' | '\\'))
    {
        return Err(ApiError::bad_request("request.invalid", "文件名无效"));
    }
    Ok(value.to_owned())
}

pub fn source_base64(value: &str, max_bytes: usize) -> Result<Vec<u8>, ApiError> {
    let maximum_encoded = max_bytes.saturating_add(2) / 3 * 4;
    if value.len() > maximum_encoded.saturating_add(4) {
        return Err(ApiError::too_large());
    }
    let source = STANDARD.decode(value).map_err(|_| {
        ApiError::bad_request("request.invalid", "配置 source 不是合法的标准 Base64")
    })?;
    if source.len() > max_bytes {
        return Err(ApiError::too_large());
    }
    Ok(source)
}

pub fn validate_source(
    registry: &TargetRegistry,
    target_id: &str,
    source: &[u8],
) -> Result<ValidationResultDto, ApiError> {
    let adapter = registry
        .get_str(target_id)
        .ok_or_else(|| ApiError::bad_request("target.unknown", "未知的配置目标"))?;
    let result = adapter.validate(source);
    let dto = ValidationResultDto::from_core(&result);
    if result.is_valid() {
        Ok(dto)
    } else {
        Err(ApiError::validation(dto))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_file_names_are_bounded() {
        assert_eq!(project_name("  家庭网络  ").unwrap(), "家庭网络");
        assert!(project_name("\n").is_err());
        assert!(project_name(&"x".repeat(101)).is_err());
        assert!(file_name("config.yaml").is_ok());
        assert!(file_name("../config.yaml").is_err());
        assert!(file_name("bad\rname").is_err());
    }

    #[test]
    fn base64_is_standard_and_size_checked_after_decode() {
        assert_eq!(source_base64("AQI=", 2).unwrap(), vec![1, 2]);
        assert!(source_base64("-_", 8).is_err());
        assert_eq!(
            source_base64("AQI=", 1).unwrap_err().code,
            "request.too_large"
        );
    }

    #[test]
    fn core_validation_rejects_unknown_targets_and_invalid_source() {
        let registry = TargetRegistry::builtin();
        assert_eq!(
            validate_source(&registry, "unknown", b"x")
                .unwrap_err()
                .code,
            "target.unknown"
        );
        assert_eq!(
            validate_source(&registry, "sing-box", b"{")
                .unwrap_err()
                .code,
            "validation.failed"
        );
    }

    #[test]
    fn token_names_and_expiry_are_strict_and_utc() {
        assert_eq!(token_display_name("  iPhone  ").unwrap(), "iPhone");
        assert!(token_display_name("").is_err());
        assert!(token_display_name(&"x".repeat(65)).is_err());
        assert!(token_display_name("bad\nname").is_err());
        assert_eq!(
            token_expiry(Some("2026-01-01T00:00:01Z"), 1_767_225_600).unwrap(),
            Some(1_767_225_601)
        );
        assert!(token_expiry(Some("2026-01-01T00:00:00"), 0).is_err());
        assert!(token_expiry(Some("2025-12-31T23:59:59Z"), 1_767_225_600).is_err());
        assert_eq!(token_expiry(None, 1_767_225_600).unwrap(), None);
    }
}
