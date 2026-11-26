ALTER TABLE documents ADD COLUMN share_expires_at INTEGER;
ALTER TABLE documents ADD COLUMN share_password_salt TEXT;
ALTER TABLE documents ADD COLUMN share_password_hash TEXT;
