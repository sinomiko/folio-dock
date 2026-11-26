CREATE TABLE documents_with_formats (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN (
    'html', 'md', 'pdf', 'txt', 'png', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg',
    'mhtml', 'xlsx', 'docx', 'pptx', 'xls', 'doc', 'ppt'
  )),
  size INTEGER NOT NULL CHECK (size > 0),
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting')),
  share_token TEXT UNIQUE
);

INSERT INTO documents_with_formats (id, owner_id, name, format, size, created_at, state, share_token)
SELECT id, owner_id, name, format, size, created_at, state, share_token FROM documents;

DROP TABLE documents;
ALTER TABLE documents_with_formats RENAME TO documents;
CREATE INDEX documents_by_owner ON documents(owner_id, created_at DESC);
CREATE INDEX documents_by_state ON documents(state, created_at DESC);
