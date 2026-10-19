ALTER TABLE records
ADD COLUMN user_id TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS records_by_owner
ON records (user_id);
