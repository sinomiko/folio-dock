ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'disabled', 'deleting'));

CREATE INDEX sessions_by_user ON sessions(user_id);
