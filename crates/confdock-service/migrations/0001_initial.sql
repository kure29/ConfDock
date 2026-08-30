PRAGMA foreign_keys = ON;

CREATE TABLE admins (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    current_revision_id TEXT,
    served_revision_id TEXT,
    last_validation_level TEXT NOT NULL,
    last_validation_result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (current_revision_id) REFERENCES config_revisions(id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (served_revision_id) REFERENCES config_revisions(id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE config_revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_revision_id TEXT,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    source_bytes BLOB NOT NULL,
    content_hash BLOB NOT NULL CHECK (length(content_hash) = 32),
    validation_level TEXT NOT NULL,
    validation_result TEXT NOT NULL,
    validator_version TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_revision_id) REFERENCES config_revisions(id),
    UNIQUE (project_id, revision_no)
);

CREATE INDEX config_revisions_project_idx ON config_revisions(project_id, revision_no);

CREATE TRIGGER config_revisions_immutable
BEFORE UPDATE ON config_revisions
BEGIN
    SELECT RAISE(ABORT, 'config revisions are immutable');
END;

CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    token_prefix TEXT NOT NULL,
    token_suffix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX access_tokens_project_idx ON access_tokens(project_id, revoked_at, created_at);
