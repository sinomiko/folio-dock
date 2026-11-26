CREATE INDEX documents_by_share_code ON documents(substr(share_token, 1, 16))
WHERE share_token IS NOT NULL AND state = 'ready';
