ALTER TABLE access_tokens
    ADD COLUMN display_name TEXT NOT NULL DEFAULT '未命名地址';

ALTER TABLE access_tokens
    ADD COLUMN expires_at INTEGER;

CREATE INDEX access_tokens_expires_at_idx ON access_tokens(expires_at);
