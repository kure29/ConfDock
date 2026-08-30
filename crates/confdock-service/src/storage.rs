use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use sqlx::{pool::PoolConnection, sqlite::SqliteRow, Row, Sqlite, SqlitePool};
use uuid::Uuid;

use crate::{
    auth::{random_token, token_hash, unix_timestamp},
    dto::{
        timestamp_to_iso, AccessTokenDto, CreatedAccessTokenDto, ProjectDto, ProjectSummaryDto,
        RevisionDto, RevisionPageDto, RevisionSummaryDto, SaveResultDto, ValidationResultDto,
    },
    error::ApiError,
};

pub const DEFAULT_REVISION_PAGE_SIZE: usize = 50;
pub const MAX_REVISION_PAGE_SIZE: usize = 100;
const MAX_REVISION_CURSOR_BYTES: usize = 128;

const FULL_PROJECT_QUERY: &str =
    "SELECT p.id, p.name, p.target_id, p.file_name, p.current_revision_id, \
     p.served_revision_id, p.last_validation_result, p.updated_at, r.source_bytes \
     FROM projects p JOIN config_revisions r ON r.id = p.served_revision_id WHERE p.id = ?";
const SUMMARY_PROJECT_QUERY: &str =
    "SELECT p.id, p.name, p.target_id, p.file_name, p.last_validation_result, \
     p.updated_at, length(r.source_bytes) AS byte_length \
     FROM projects p JOIN config_revisions r ON r.id = p.served_revision_id WHERE p.id = ?";
const REVISION_LIST_QUERY: &str =
    "SELECT r.id, r.parent_revision_id, r.revision_no, length(r.source_bytes) AS byte_length, \
     r.content_hash, \
     r.validation_result, r.validator_version, r.created_at, \
     p.current_revision_id, p.served_revision_id \
     FROM config_revisions r JOIN projects p ON p.id = r.project_id \
     WHERE r.project_id = ? ORDER BY r.revision_no DESC, r.id LIMIT ?";
const REVISION_LIST_AFTER_QUERY: &str =
    "SELECT r.id, r.parent_revision_id, r.revision_no, length(r.source_bytes) AS byte_length, \
     r.content_hash, \
     r.validation_result, r.validator_version, r.created_at, \
     p.current_revision_id, p.served_revision_id \
     FROM config_revisions r JOIN projects p ON p.id = r.project_id \
     WHERE r.project_id = ? AND r.revision_no < ? \
     ORDER BY r.revision_no DESC, r.id LIMIT ?";
const REVISION_DETAIL_QUERY: &str =
    "SELECT r.id, r.parent_revision_id, r.revision_no, r.source_bytes, \
     length(r.source_bytes) AS byte_length, r.content_hash, \
     r.validation_result, r.validator_version, r.created_at, \
     p.current_revision_id, p.served_revision_id \
     FROM config_revisions r JOIN projects p ON p.id = r.project_id \
     WHERE r.project_id = ? AND r.id = ?";

pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<ProjectSummaryDto>, ApiError> {
    let rows = sqlx::query(
        "SELECT p.id, p.name, p.target_id, p.file_name, p.last_validation_result, \
         p.updated_at, length(r.source_bytes) AS byte_length \
         FROM projects p JOIN config_revisions r ON r.id = p.served_revision_id \
         ORDER BY p.updated_at DESC, p.id",
    )
    .fetch_all(pool)
    .await
    .map_err(|_| ApiError::internal())?;
    rows.iter().map(summary_from_row).collect()
}

pub async fn get_project(pool: &SqlitePool, id: &str) -> Result<ProjectDto, ApiError> {
    let row = sqlx::query(FULL_PROJECT_QUERY)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(|| ApiError::not_found("project.not_found", "配置不存在"))?;
    project_from_row(&row)
}

pub async fn get_target_id(pool: &SqlitePool, id: &str) -> Result<String, ApiError> {
    sqlx::query_scalar("SELECT target_id FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(|| ApiError::not_found("project.not_found", "配置不存在"))
}

pub async fn create_project(
    pool: &SqlitePool,
    name: &str,
    target_id: &str,
    file_name: &str,
    source: &[u8],
    validation: &ValidationResultDto,
) -> Result<ProjectDto, ApiError> {
    let mut connection = begin_immediate(pool).await?;
    let result = create_project_inner(
        &mut connection,
        name,
        target_id,
        file_name,
        source,
        validation,
    )
    .await;
    finish_transaction(connection, result).await
}

async fn create_project_inner(
    connection: &mut PoolConnection<Sqlite>,
    name: &str,
    target_id: &str,
    file_name: &str,
    source: &[u8],
    validation: &ValidationResultDto,
) -> Result<ProjectDto, ApiError> {
    let project_id = Uuid::new_v4().to_string();
    let revision_id = Uuid::new_v4().to_string();
    let now = unix_timestamp();
    let validation_json = serialize_validation(validation)?;
    sqlx::query(
        "INSERT INTO projects (id, name, target_id, file_name, current_revision_id, \
         served_revision_id, last_validation_level, last_validation_result, created_at, updated_at) \
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
    )
    .bind(&project_id)
    .bind(name)
    .bind(target_id)
    .bind(file_name)
    .bind(&validation.level)
    .bind(&validation_json)
    .bind(now)
    .bind(now)
    .execute(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?;

    insert_revision(
        connection,
        &revision_id,
        &project_id,
        None,
        1,
        source,
        validation,
        &validation_json,
        now,
    )
    .await?;
    sqlx::query("UPDATE projects SET current_revision_id = ?, served_revision_id = ? WHERE id = ?")
        .bind(&revision_id)
        .bind(&revision_id)
        .bind(&project_id)
        .execute(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?;
    fetch_project_connection(connection, &project_id).await
}

pub async fn save_revision(
    pool: &SqlitePool,
    project_id: &str,
    expected_revision_id: &str,
    source: &[u8],
    validation: &ValidationResultDto,
) -> Result<SaveResultDto, ApiError> {
    let mut connection = begin_immediate(pool).await?;
    let result = save_revision_inner(
        &mut connection,
        project_id,
        expected_revision_id,
        source,
        validation,
    )
    .await;
    finish_transaction(connection, result).await
}

pub async fn list_revisions(
    pool: &SqlitePool,
    project_id: &str,
    limit: Option<usize>,
    cursor: Option<&str>,
) -> Result<RevisionPageDto, ApiError> {
    let limit = limit.unwrap_or(DEFAULT_REVISION_PAGE_SIZE);
    if !(1..=MAX_REVISION_PAGE_SIZE).contains(&limit) {
        return Err(ApiError::bad_request(
            "request.invalid",
            "版本数量必须在 1 到 100 之间",
        ));
    }
    let mut connection = begin_deferred(pool).await?;
    let result = list_revisions_connection(&mut connection, project_id, limit, cursor).await;
    finish_transaction(connection, result).await
}

async fn list_revisions_connection(
    connection: &mut PoolConnection<Sqlite>,
    project_id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<RevisionPageDto, ApiError> {
    ensure_project_connection(connection, project_id).await?;
    let cursor_revision_no = match cursor {
        None => None,
        Some(cursor) if cursor.is_empty() || cursor.len() > MAX_REVISION_CURSOR_BYTES => {
            return Err(ApiError::revision_invalid_cursor())
        }
        Some(cursor) => Some(
            sqlx::query_scalar::<_, i64>(
                "SELECT revision_no FROM config_revisions WHERE project_id = ? AND id = ?",
            )
            .bind(project_id)
            .bind(cursor)
            .fetch_optional(&mut **connection)
            .await
            .map_err(|_| ApiError::internal())?
            .ok_or_else(ApiError::revision_invalid_cursor)?,
        ),
    };
    let fetch_limit = i64::try_from(limit + 1).map_err(|_| ApiError::internal())?;
    let rows = match cursor_revision_no {
        Some(revision_no) => sqlx::query(REVISION_LIST_AFTER_QUERY)
            .bind(project_id)
            .bind(revision_no)
            .bind(fetch_limit)
            .fetch_all(&mut **connection)
            .await
            .map_err(|_| ApiError::internal())?,
        None => sqlx::query(REVISION_LIST_QUERY)
            .bind(project_id)
            .bind(fetch_limit)
            .fetch_all(&mut **connection)
            .await
            .map_err(|_| ApiError::internal())?,
    };
    let has_more = rows.len() > limit;
    let items = rows
        .iter()
        .take(limit)
        .map(revision_summary_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = if has_more {
        items.last().map(|item| item.id.clone())
    } else {
        None
    };
    Ok(RevisionPageDto { items, next_cursor })
}

pub async fn get_revision(
    pool: &SqlitePool,
    project_id: &str,
    revision_id: &str,
) -> Result<RevisionDto, ApiError> {
    let mut connection = begin_deferred(pool).await?;
    let result = get_revision_connection(&mut connection, project_id, revision_id).await;
    finish_transaction(connection, result).await
}

async fn get_revision_connection(
    connection: &mut PoolConnection<Sqlite>,
    project_id: &str,
    revision_id: &str,
) -> Result<RevisionDto, ApiError> {
    ensure_project_connection(connection, project_id).await?;
    let row = sqlx::query(REVISION_DETAIL_QUERY)
        .bind(project_id)
        .bind(revision_id)
        .fetch_optional(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::revision_not_found)?;
    revision_from_row(&row)
}

async fn save_revision_inner(
    connection: &mut PoolConnection<Sqlite>,
    project_id: &str,
    expected_revision_id: &str,
    source: &[u8],
    validation: &ValidationResultDto,
) -> Result<SaveResultDto, ApiError> {
    let row = sqlx::query(
        "SELECT p.current_revision_id, r.source_bytes, r.revision_no \
         FROM projects p JOIN config_revisions r ON r.id = p.current_revision_id \
         WHERE p.id = ?",
    )
    .bind(project_id)
    .fetch_optional(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?
    .ok_or_else(|| ApiError::not_found("project.not_found", "配置不存在"))?;
    let current_revision_id: String = row
        .try_get("current_revision_id")
        .map_err(|_| ApiError::internal())?;
    if current_revision_id != expected_revision_id {
        return Err(ApiError::conflict());
    }
    let current_source: Vec<u8> = row
        .try_get("source_bytes")
        .map_err(|_| ApiError::internal())?;
    let revision_no: i64 = row
        .try_get("revision_no")
        .map_err(|_| ApiError::internal())?;
    let now = unix_timestamp();
    let validation_json = serialize_validation(validation)?;

    if current_source == source {
        sqlx::query(
            "UPDATE projects SET last_validation_level = ?, last_validation_result = ?, \
             updated_at = ? WHERE id = ?",
        )
        .bind(&validation.level)
        .bind(&validation_json)
        .bind(now)
        .bind(project_id)
        .execute(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?;
        return Ok(SaveResultDto {
            project: fetch_project_connection(connection, project_id).await?,
            validation: validation.clone(),
            unchanged: true,
        });
    }

    let revision_id = Uuid::new_v4().to_string();
    insert_revision(
        connection,
        &revision_id,
        project_id,
        Some(&current_revision_id),
        revision_no.saturating_add(1),
        source,
        validation,
        &validation_json,
        now,
    )
    .await?;
    sqlx::query(
        "UPDATE projects SET current_revision_id = ?, served_revision_id = ?, \
         last_validation_level = ?, last_validation_result = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&revision_id)
    .bind(&revision_id)
    .bind(&validation.level)
    .bind(&validation_json)
    .bind(now)
    .bind(project_id)
    .execute(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?;
    Ok(SaveResultDto {
        project: fetch_project_connection(connection, project_id).await?,
        validation: validation.clone(),
        unchanged: false,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_revision(
    connection: &mut PoolConnection<Sqlite>,
    revision_id: &str,
    project_id: &str,
    parent_revision_id: Option<&str>,
    revision_no: i64,
    source: &[u8],
    validation: &ValidationResultDto,
    validation_json: &str,
    created_at: i64,
) -> Result<(), ApiError> {
    let content_hash: [u8; 32] = Sha256::digest(source).into();
    sqlx::query(
        "INSERT INTO config_revisions (id, project_id, parent_revision_id, revision_no, \
         source_bytes, content_hash, validation_level, validation_result, validator_version, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(revision_id)
    .bind(project_id)
    .bind(parent_revision_id)
    .bind(revision_no)
    .bind(source)
    .bind(content_hash.as_slice())
    .bind(&validation.level)
    .bind(validation_json)
    .bind(created_at)
    .execute(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?;
    Ok(())
}

pub async fn rename_project(
    pool: &SqlitePool,
    id: &str,
    name: &str,
) -> Result<ProjectSummaryDto, ApiError> {
    let mut connection = begin_immediate(pool).await?;
    let result = rename_project_inner(&mut connection, id, name).await;
    finish_transaction(connection, result).await
}

async fn rename_project_inner(
    connection: &mut PoolConnection<Sqlite>,
    id: &str,
    name: &str,
) -> Result<ProjectSummaryDto, ApiError> {
    let result = sqlx::query("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(unix_timestamp())
        .bind(id)
        .execute(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("project.not_found", "配置不存在"));
    }
    let row = sqlx::query(SUMMARY_PROJECT_QUERY)
        .bind(id)
        .fetch_one(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?;
    summary_from_row(&row)
}

pub async fn delete_project(pool: &SqlitePool, id: &str) -> Result<(), ApiError> {
    let result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|_| ApiError::internal())?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("project.not_found", "配置不存在"));
    }
    Ok(())
}

pub async fn list_tokens(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Vec<AccessTokenDto>, ApiError> {
    let mut connection = begin_deferred(pool).await?;
    let result = list_tokens_connection(&mut connection, project_id).await;
    finish_transaction(connection, result).await
}

async fn list_tokens_connection(
    connection: &mut PoolConnection<Sqlite>,
    project_id: &str,
) -> Result<Vec<AccessTokenDto>, ApiError> {
    ensure_project_connection(connection, project_id).await?;
    let rows = sqlx::query(
        "SELECT id, token_prefix, token_suffix, created_at, last_used_at \
         FROM access_tokens WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id",
    )
    .bind(project_id)
    .fetch_all(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?;
    rows.iter().map(token_from_row).collect()
}

pub async fn create_token(
    pool: &SqlitePool,
    project_id: &str,
    public_url: &str,
) -> Result<CreatedAccessTokenDto, ApiError> {
    let mut connection = begin_immediate(pool).await?;
    let result = create_token_inner(&mut connection, project_id, public_url).await;
    finish_transaction(connection, result).await
}

async fn create_token_inner(
    connection: &mut PoolConnection<Sqlite>,
    project_id: &str,
    public_url: &str,
) -> Result<CreatedAccessTokenDto, ApiError> {
    ensure_project_connection(connection, project_id).await?;
    let plaintext = random_token();
    let hash = token_hash(&plaintext);
    let now = unix_timestamp();
    let token = AccessTokenDto {
        id: Uuid::new_v4().to_string(),
        prefix: plaintext.chars().take(6).collect(),
        suffix: plaintext
            .chars()
            .rev()
            .take(6)
            .collect::<String>()
            .chars()
            .rev()
            .collect(),
        created_at: timestamp_to_iso(now).ok_or_else(ApiError::internal)?,
        last_used_at: None,
    };
    sqlx::query(
        "INSERT INTO access_tokens (id, project_id, token_hash, token_prefix, token_suffix, \
         created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
    )
    .bind(&token.id)
    .bind(project_id)
    .bind(hash.as_slice())
    .bind(&token.prefix)
    .bind(&token.suffix)
    .bind(now)
    .execute(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?;
    Ok(CreatedAccessTokenDto {
        token,
        url: format!("{public_url}/sub/{plaintext}"),
        plaintext,
    })
}

pub async fn revoke_token(
    pool: &SqlitePool,
    project_id: &str,
    token_id: &str,
) -> Result<(), ApiError> {
    let mut connection = begin_immediate(pool).await?;
    let result = revoke_token_inner(&mut connection, project_id, token_id).await;
    finish_transaction(connection, result).await
}

async fn revoke_token_inner(
    connection: &mut PoolConnection<Sqlite>,
    project_id: &str,
    token_id: &str,
) -> Result<(), ApiError> {
    ensure_project_connection(connection, project_id).await?;
    let result = sqlx::query(
        "UPDATE access_tokens SET revoked_at = ? \
         WHERE id = ? AND project_id = ? AND revoked_at IS NULL",
    )
    .bind(unix_timestamp())
    .bind(token_id)
    .bind(project_id)
    .execute(&mut **connection)
    .await
    .map_err(|_| ApiError::internal())?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("token.not_found", "托管地址不存在"));
    }
    Ok(())
}

pub struct Subscription {
    pub source: Vec<u8>,
    pub file_name: String,
}

pub async fn subscription(pool: &SqlitePool, plaintext: &str) -> Result<Subscription, ApiError> {
    if plaintext.len() > 256 {
        return Err(ApiError::not_found("token.not_found", "托管地址不存在"));
    }
    let hash = token_hash(plaintext);
    let row = sqlx::query(
        "SELECT t.id, p.file_name, r.source_bytes \
         FROM access_tokens t JOIN projects p ON p.id = t.project_id \
         JOIN config_revisions r ON r.id = p.served_revision_id \
         WHERE t.token_hash = ? AND t.revoked_at IS NULL",
    )
    .bind(hash.as_slice())
    .fetch_optional(pool)
    .await
    .map_err(|_| ApiError::internal())?
    .ok_or_else(|| ApiError::not_found("token.not_found", "托管地址不存在"))?;
    let token_id: String = row.try_get("id").map_err(|_| ApiError::internal())?;
    let result = Subscription {
        source: row
            .try_get("source_bytes")
            .map_err(|_| ApiError::internal())?,
        file_name: row.try_get("file_name").map_err(|_| ApiError::internal())?,
    };
    sqlx::query("UPDATE access_tokens SET last_used_at = ? WHERE id = ?")
        .bind(unix_timestamp())
        .bind(token_id)
        .execute(pool)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(result)
}

async fn ensure_project_connection(
    connection: &mut PoolConnection<Sqlite>,
    id: &str,
) -> Result<(), ApiError> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)")
        .bind(id)
        .fetch_one(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?;
    if exists {
        Ok(())
    } else {
        Err(ApiError::not_found("project.not_found", "配置不存在"))
    }
}

async fn fetch_project_connection(
    connection: &mut PoolConnection<Sqlite>,
    id: &str,
) -> Result<ProjectDto, ApiError> {
    let row = sqlx::query(FULL_PROJECT_QUERY)
        .bind(id)
        .fetch_one(&mut **connection)
        .await
        .map_err(|_| ApiError::internal())?;
    project_from_row(&row)
}

fn summary_from_row(row: &SqliteRow) -> Result<ProjectSummaryDto, ApiError> {
    let validation_json: String = row
        .try_get("last_validation_result")
        .map_err(|_| ApiError::internal())?;
    Ok(ProjectSummaryDto {
        id: row.try_get("id").map_err(|_| ApiError::internal())?,
        name: row.try_get("name").map_err(|_| ApiError::internal())?,
        target_id: row.try_get("target_id").map_err(|_| ApiError::internal())?,
        file_name: row.try_get("file_name").map_err(|_| ApiError::internal())?,
        updated_at: timestamp_to_iso(
            row.try_get("updated_at")
                .map_err(|_| ApiError::internal())?,
        )
        .ok_or_else(ApiError::internal)?,
        byte_length: usize::try_from(
            row.try_get::<i64, _>("byte_length")
                .map_err(|_| ApiError::internal())?,
        )
        .map_err(|_| ApiError::internal())?,
        last_validation: serde_json::from_str(&validation_json)
            .map_err(|_| ApiError::internal())?,
    })
}

fn project_from_row(row: &SqliteRow) -> Result<ProjectDto, ApiError> {
    let source: Vec<u8> = row
        .try_get("source_bytes")
        .map_err(|_| ApiError::internal())?;
    let validation_json: String = row
        .try_get("last_validation_result")
        .map_err(|_| ApiError::internal())?;
    Ok(ProjectDto {
        summary: ProjectSummaryDto {
            id: row.try_get("id").map_err(|_| ApiError::internal())?,
            name: row.try_get("name").map_err(|_| ApiError::internal())?,
            target_id: row.try_get("target_id").map_err(|_| ApiError::internal())?,
            file_name: row.try_get("file_name").map_err(|_| ApiError::internal())?,
            updated_at: timestamp_to_iso(
                row.try_get("updated_at")
                    .map_err(|_| ApiError::internal())?,
            )
            .ok_or_else(ApiError::internal)?,
            byte_length: source.len(),
            last_validation: serde_json::from_str(&validation_json)
                .map_err(|_| ApiError::internal())?,
        },
        source: STANDARD.encode(source),
        current_revision_id: row
            .try_get("current_revision_id")
            .map_err(|_| ApiError::internal())?,
        served_revision_id: row
            .try_get("served_revision_id")
            .map_err(|_| ApiError::internal())?,
    })
}

fn revision_summary_from_row(row: &SqliteRow) -> Result<RevisionSummaryDto, ApiError> {
    let validation_json: String = row
        .try_get("validation_result")
        .map_err(|_| ApiError::internal())?;
    let content_hash: Vec<u8> = row
        .try_get("content_hash")
        .map_err(|_| ApiError::internal())?;
    let current_revision_id: String = row
        .try_get("current_revision_id")
        .map_err(|_| ApiError::internal())?;
    let served_revision_id: String = row
        .try_get("served_revision_id")
        .map_err(|_| ApiError::internal())?;
    let revision_id: String = row.try_get("id").map_err(|_| ApiError::internal())?;
    let revision_no: i64 = row
        .try_get("revision_no")
        .map_err(|_| ApiError::internal())?;
    let byte_length = usize::try_from(
        row.try_get::<i64, _>("byte_length")
            .map_err(|_| ApiError::internal())?,
    )
    .map_err(|_| ApiError::internal())?;
    if revision_no <= 0 || content_hash.len() != 32 {
        return Err(ApiError::internal());
    }
    Ok(RevisionSummaryDto {
        id: revision_id.clone(),
        revision_no,
        parent_revision_id: row
            .try_get("parent_revision_id")
            .map_err(|_| ApiError::internal())?,
        created_at: timestamp_to_iso(
            row.try_get("created_at")
                .map_err(|_| ApiError::internal())?,
        )
        .ok_or_else(ApiError::internal)?,
        byte_length,
        content_hash: hex_encode(&content_hash)?,
        validation: serde_json::from_str(&validation_json).map_err(|_| ApiError::internal())?,
        validator_version: row
            .try_get("validator_version")
            .map_err(|_| ApiError::internal())?,
        is_current: current_revision_id == revision_id,
        is_served: served_revision_id == revision_id,
    })
}

fn revision_from_row(row: &SqliteRow) -> Result<RevisionDto, ApiError> {
    let source: Vec<u8> = row
        .try_get("source_bytes")
        .map_err(|_| ApiError::internal())?;
    let content_hash: Vec<u8> = row
        .try_get("content_hash")
        .map_err(|_| ApiError::internal())?;
    if content_hash.as_slice() != Sha256::digest(&source).as_slice() {
        return Err(ApiError::internal());
    }
    Ok(RevisionDto {
        summary: revision_summary_from_row(row)?,
        source: STANDARD.encode(source),
    })
}

fn token_from_row(row: &SqliteRow) -> Result<AccessTokenDto, ApiError> {
    let last_used_at = match row
        .try_get::<Option<i64>, _>("last_used_at")
        .map_err(|_| ApiError::internal())?
    {
        Some(timestamp) => Some(timestamp_to_iso(timestamp).ok_or_else(ApiError::internal)?),
        None => None,
    };
    Ok(AccessTokenDto {
        id: row.try_get("id").map_err(|_| ApiError::internal())?,
        prefix: row
            .try_get("token_prefix")
            .map_err(|_| ApiError::internal())?,
        suffix: row
            .try_get("token_suffix")
            .map_err(|_| ApiError::internal())?,
        created_at: timestamp_to_iso(
            row.try_get("created_at")
                .map_err(|_| ApiError::internal())?,
        )
        .ok_or_else(ApiError::internal)?,
        last_used_at,
    })
}

fn serialize_validation(validation: &ValidationResultDto) -> Result<String, ApiError> {
    serde_json::to_string(validation).map_err(|_| ApiError::internal())
}

fn hex_encode(bytes: &[u8]) -> Result<String, ApiError> {
    if bytes.len() != 32 {
        return Err(ApiError::internal());
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(encoded)
}

async fn begin_deferred(pool: &SqlitePool) -> Result<PoolConnection<Sqlite>, ApiError> {
    let mut connection = pool.acquire().await.map_err(|_| ApiError::internal())?;
    sqlx::query("BEGIN")
        .execute(&mut *connection)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(connection)
}

async fn begin_immediate(pool: &SqlitePool) -> Result<PoolConnection<Sqlite>, ApiError> {
    let mut connection = pool.acquire().await.map_err(|_| ApiError::internal())?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(connection)
}

async fn finish_transaction<T>(
    mut connection: PoolConnection<Sqlite>,
    result: Result<T, ApiError>,
) -> Result<T, ApiError> {
    match result {
        Ok(value) => {
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(|_| ApiError::internal())?;
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}
