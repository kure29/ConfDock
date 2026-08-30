use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    dto::{
        CreateProjectRequest, ProjectDto, ProjectSummaryDto, RenameProjectRequest, RevisionDiffDto,
        RevisionDto, RevisionPageDto, SaveResultDto, SaveRevisionRequest,
    },
    error::ApiError,
    state::AppState,
    storage,
    validation::{file_name, project_name, source_base64, validate_source},
};

use super::json;

#[derive(Debug, Default, Deserialize)]
pub struct RevisionListQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

const MAX_REVISION_ID_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
pub struct RevisionDiffQuery {
    #[serde(rename = "fromRevisionId")]
    pub from_revision_id: String,
    #[serde(rename = "toRevisionId")]
    pub to_revision_id: String,
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<ProjectSummaryDto>>, ApiError> {
    Ok(Json(storage::list_projects(&state.pool).await?))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProjectDto>, ApiError> {
    Ok(Json(storage::get_project(&state.pool, &id).await?))
}

pub async fn create(
    State(state): State<AppState>,
    input: Result<Json<CreateProjectRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<ProjectDto>), ApiError> {
    let input = json(input)?;
    let name = project_name(&input.name)?;
    let file_name = file_name(&input.file_name)?;
    let source = source_base64(&input.source, state.config.max_config_bytes)?;
    let validation = validate_source(&state.registry, &input.target_id, &source)?;
    let project = storage::create_project(
        &state.pool,
        &name,
        &input.target_id,
        &file_name,
        &source,
        &validation,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn save_revision(
    State(state): State<AppState>,
    Path(id): Path<String>,
    input: Result<Json<SaveRevisionRequest>, JsonRejection>,
) -> Result<Json<SaveResultDto>, ApiError> {
    let input = json(input)?;
    if input.expected_revision_id.is_empty() {
        return Err(ApiError::bad_request(
            "request.invalid",
            "expectedRevisionId 不能为空",
        ));
    }
    let target_id = storage::get_target_id(&state.pool, &id).await?;
    let source = source_base64(&input.source, state.config.max_config_bytes)?;
    let validation = validate_source(&state.registry, &target_id, &source)?;
    Ok(Json(
        storage::save_revision(
            &state.pool,
            &id,
            &input.expected_revision_id,
            &source,
            &validation,
        )
        .await?,
    ))
}

pub async fn list_revisions(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: Result<Query<RevisionListQuery>, QueryRejection>,
) -> Result<Json<RevisionPageDto>, ApiError> {
    let Query(query) =
        query.map_err(|_| ApiError::bad_request("request.invalid", "版本查询参数无效"))?;
    Ok(Json(
        storage::list_revisions(&state.pool, &id, query.limit, query.cursor.as_deref()).await?,
    ))
}

pub async fn get_revision(
    State(state): State<AppState>,
    Path((id, revision_id)): Path<(String, String)>,
) -> Result<Json<RevisionDto>, ApiError> {
    Ok(Json(
        storage::get_revision(&state.pool, &id, &revision_id).await?,
    ))
}

pub async fn diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: Result<Query<RevisionDiffQuery>, QueryRejection>,
) -> Result<Json<RevisionDiffDto>, ApiError> {
    let Query(query) =
        query.map_err(|_| ApiError::bad_request("request.invalid", "版本差异查询参数无效"))?;
    validate_revision_id(&query.from_revision_id)?;
    validate_revision_id(&query.to_revision_id)?;
    Ok(Json(
        storage::get_revision_diff(
            &state.pool,
            &state.diff_slots,
            &id,
            &query.from_revision_id,
            &query.to_revision_id,
        )
        .await?,
    ))
}

fn validate_revision_id(value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > MAX_REVISION_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request("request.invalid", "版本 ID 无效"));
    }
    Ok(())
}

pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    input: Result<Json<RenameProjectRequest>, JsonRejection>,
) -> Result<Json<ProjectSummaryDto>, ApiError> {
    let input = json(input)?;
    let name = project_name(&input.name)?;
    Ok(Json(
        storage::rename_project(&state.pool, &id, &name).await?,
    ))
}

pub async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    storage::delete_project(&state.pool, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
