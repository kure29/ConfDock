use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use uuid::Uuid;

use crate::dto::ValidationResultDto;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
    pub validation: Option<ValidationResultDto>,
    pub request_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    code: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation: Option<ValidationResultDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            validation: None,
            request_id: None,
        }
    }

    pub fn bad_request(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "auth.unauthorized",
            "登录已失效，请重新登录",
        )
    }

    pub fn not_found(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "revision.conflict",
            "配置已被其他页面更新，请重新加载后再保存",
        )
    }

    pub fn revision_not_found() -> Self {
        Self::not_found("revision.not_found", "版本不存在")
    }

    pub fn revision_invalid_cursor() -> Self {
        Self::bad_request("revision.invalid_cursor", "版本游标无效")
    }

    pub fn validation(validation: ValidationResultDto) -> Self {
        let (status, code, message) = if validation.has_code("encoding.unsupported") {
            (
                StatusCode::BAD_REQUEST,
                "encoding.unsupported",
                "配置编码不受支持，仅接受 UTF-8 或带 BOM 的 UTF-8",
            )
        } else {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation.failed",
                "配置校验未通过，未保存",
            )
        };
        Self {
            status,
            code,
            message,
            validation: Some(validation),
            request_id: None,
        }
    }

    pub fn too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request.too_large",
            "配置超过允许的大小",
        )
    }

    pub fn internal() -> Self {
        let request_id = Uuid::new_v4().to_string();
        tracing::error!(request_id = %request_id, "internal service error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal.error",
            message: "服务暂时无法完成请求",
            validation: None,
            request_id: Some(request_id),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        let body = ErrorResponse {
            code: self.code,
            message: self.message,
            validation: self.validation,
            request_id: self.request_id,
        };
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_errors_map_to_expected_statuses() {
        assert_eq!(ApiError::unauthorized().status, StatusCode::UNAUTHORIZED);
        assert_eq!(ApiError::conflict().status, StatusCode::CONFLICT);
        assert_eq!(ApiError::revision_not_found().code, "revision.not_found");
        assert_eq!(
            ApiError::revision_invalid_cursor().code,
            "revision.invalid_cursor"
        );
        assert_eq!(ApiError::too_large().status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(ApiError::internal().code, "internal.error");
    }
}
