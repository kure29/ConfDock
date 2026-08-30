use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    dto::{
        CreateProjectRequest, ProjectDto, ProjectSummaryDto, RenameProjectRequest, SaveResultDto,
        SaveRevisionRequest,
    },
    error::ApiError,
    state::AppState,
    storage,
    validation::{file_name, project_name, source_base64, validate_source},
};

use super::json;

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
