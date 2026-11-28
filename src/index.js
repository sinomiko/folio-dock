import MarkdownIt from 'markdown-it';
import { handleMcp, maxMcpBody } from './mcp.js';
import { formats, formatAliases } from './formats.js';
import { HttpError } from './http-error.js';
import { streamUpload, uploadLength, validateUploadSignature } from './uploads.js';
import { formatShareCode, normalizeShareCode } from '../public/share-code.js';

const encoder = new TextEncoder();
const md = new MarkdownIt({ html: false, maxNesting: 20 });
const cookieName = '__Host-folio_session';
const sessionSeconds = 30 * 24 * 60 * 60;
const MiB = 1024 * 1024;
const maxDocuments = 100;
const maxStorage = 150 * MiB;
const documentFields = 'id, name, format, size, created_at';
const ownerShareFields = 'share_token, share_expires_at, (share_password_hash IS NOT NULL) AS share_requires_password';
const shareGrantCookie = '__Secure-folio_share';
const shareGrantLifetime = 12 * 60 * 60;
const shareExpiryFilter = '(share_expires_at IS NULL OR share_expires_at > unixepoch())';
const activeDocumentOwner = "EXISTS (SELECT 1 FROM users WHERE users.id = documents.owner_id AND users.status = 'active')";
const incomplete = "(state = 'deleting' OR (state = 'pending' AND created_at < ?))";
const security = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};
const appCsp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "img-src 'self' data:", "connect-src 'self'", "frame-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const frameCsp = [
  "default-src 'none'", "style-src 'unsafe-inline'", "img-src data: blob:",
  'font-src data:', 'media-src data: blob:', "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'self'",
].join('; ');
const richPreviewCsp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline' data:",
  'img-src data: blob:', 'font-src data:', "frame-src 'self' about:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join('; ');
const officeLayoutCsp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  'img-src data: blob:', 'font-src data: blob:', "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'self'", 'sandbox allow-scripts',
].join('; ');
const markdownStyle = 'html{color-scheme:light}body{font:16px/1.72 system-ui,sans-serif;color:#29263a;margin:0;padding:clamp(20px,5vw,56px);overflow-wrap:anywhere}main{max-width:760px;margin:auto}h1,h2,h3{line-height:1.25;margin:1.4em 0 .55em}main>:first-child{margin-top:0}a{color:#5240a3}pre,code{background:#f1eef9;border-radius:5px}code{padding:.12em .35em}pre{padding:16px;overflow:auto}pre code{padding:0}blockquote{border-left:3px solid #b7a9f1;margin-left:0;padding-left:16px;color:#5d5670}img{max-width:100%}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #dfd9ee;padding:7px 12px}';
const now = () => Math.floor(Date.now() / 1000);

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { ...security, 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function missing() {
  return new HttpError(404, '文档不存在，或链接已失效。');
}

function randomHex(length) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  return Uint8Array.from(value.match(/.{2}/g), byte => Number.parseInt(byte, 16));
}

function digest(value) {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

async function passwordVerifier(password, salt, pepper) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const input = await crypto.subtle.sign('HMAC', key, encoder.encode(password));
  const derived = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: 100_000,
  }, derived, 256);
}

async function readBody(request, max) {
  if (!request.body) throw new HttpError(400, '请求内容为空。');
  if (Number(request.headers.get('Content-Length')) > max) {
    throw new HttpError(413, '文件或请求超出大小限制。');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, '文件或请求超出大小限制。');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readJson(request, max = 4096) {
  const bytes = await readBody(request, max);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Malformed JSON is reported the same way as a non-object payload.
  }
  throw new HttpError(400, '请求格式无效。');
}

function sessionToken(request) {
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-folio_session=([a-f0-9]{64})(?:;|$)/);
  return match?.[1];
}

function sessionCookie(token, seconds) {
  return [cookieName + '=' + token, 'Max-Age=' + seconds, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'].join('; ');
}

async function getUser(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT users.id, users.username, users.is_admin FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ? AND users.status = 'active'",
  ).bind(hex(await digest(token)), now()).first();
}

function readCredentials(input) {
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const { password } = input;
  if (!/^[a-z0-9_][a-z0-9_.-]{2,31}$/.test(username) || !validPassword(password)) {
    throw new HttpError(400, '用户名须为 3–32 位英文、数字或 ._-，密码须为 12–128 位。');
  }
  return { username, password };
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

async function makePassword(password, env) {
  if (!env.PASSWORD_PEPPER) throw new HttpError(503, '暂时无法设置密码。');
  const salt = randomHex(16);
  return { salt, verifier: hex(await passwordVerifier(password, salt, env.PASSWORD_PEPPER)) };
}

async function createUser(env, username, password) {
  const { salt, verifier } = await makePassword(password, env);
  const user = { id: randomHex(16), username, verifier };
  const result = await env.DB.prepare(
    'INSERT INTO users (id, username, salt, verifier) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING',
  ).bind(user.id, username, salt, verifier).run();
  if (!result.meta.changes) throw new HttpError(409, '此用户名已被使用。');
  return user;
}

async function auth(request, env, registration) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const { success } = await env.AUTH_LIMIT.limit({ key: 'folio-auth:' + ip });
  if (!success) throw new HttpError(429, '尝试次数过多，请稍后重试。');
  if (!env.PASSWORD_PEPPER) throw new HttpError(503, '登录暂不可用。');

  const input = await readJson(request);
  const { username, password } = readCredentials(input);

  let user;
  if (registration) {
    if (!env.INVITE_CODE) throw new HttpError(403, '当前暂停注册。');
    const code = typeof input.invite === 'string' ? input.invite.trim() : '';
    const [provided, expected] = await Promise.all([digest(code), digest(env.INVITE_CODE)]);
    if (!crypto.subtle.timingSafeEqual(provided, expected)) throw new HttpError(403, '邀请码无效。');

    user = await createUser(env, username, password);
  } else {
    user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    const verifier = await passwordVerifier(password, user?.salt || '0'.repeat(32), env.PASSWORD_PEPPER);
    if (!user || !crypto.subtle.timingSafeEqual(verifier, fromHex(user.verifier))) {
      throw new HttpError(401, '用户名或密码错误。');
    }
    if (user.status !== 'active') throw new HttpError(403, '此账号已暂停使用。');
  }

  const token = randomHex(32);
  const time = now();
  const existing = sessionToken(request);
  const existingHash = existing ? hex(await digest(existing)) : '';
  const [, created] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?').bind(time, existingHash),
    env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) SELECT ?, id, ? FROM users WHERE id = ? AND verifier = ? AND status = 'active'",
    ).bind(hex(await digest(token)), time + sessionSeconds, user.id, user.verifier),
  ]);
  if (!created.meta.changes) throw new HttpError(401, '账号状态或密码已变化，请重新登录。');
  return json({ username, is_admin: Boolean(user.is_admin) }, registration ? 201 : 200, {
    'Set-Cookie': sessionCookie(token, sessionSeconds),
  });
}

function readFilename(header) {
  try {
    return decodeURIComponent(header || '');
  } catch {
    throw new HttpError(400, '文件名无效。');
  }
}

function cleanFilename(value) {
  const name = value.normalize('NFC')
    .replace(/[\x00-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!name || name.length > 180 || /[/\\]/.test(name)) throw new HttpError(400, '文件名无效或过长。');
  return name.toWellFormed();
}

function getFormat(name) {
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  if (Object.hasOwn(formatAliases, extension)) return formatAliases[extension];
  if (Object.hasOwn(formats, extension)) return extension;
  throw new HttpError(415, '请选择 HTML、Markdown、PDF、TXT、图片、MHTML 或 Office 文件。');
}

function placeholders(count) {
  return Array(count).fill('?').join(', ');
}

async function purgeDocuments(env, ids) {
  if (!ids.length) return 0;
  await env.FILES.delete(ids);
  const result = await env.DB.prepare(
    "DELETE FROM documents WHERE state = 'deleting' AND id IN (" + placeholders(ids.length) + ')',
  ).bind(...ids).run();
  return result.meta.changes;
}

async function cleanupIncomplete(env, owner = null) {
  const ownerFilter = owner ? ' AND owner_id = ?' : '';
  const { results } = await env.DB.prepare(
    "UPDATE documents SET state = 'deleting', share_token = NULL WHERE id IN (" +
    'SELECT id FROM documents WHERE ' + incomplete + ownerFilter + ' ORDER BY created_at LIMIT 50) RETURNING id',
  ).bind(now() - 3600, ...(owner ? [owner] : [])).all();
  return purgeDocuments(env, results.map(({ id }) => id));
}

async function upload(request, env, owner, ctx) {
  const name = cleanFilename(readFilename(request.headers.get('X-Folio-Filename')));
  const format = getFormat(name);
  const length = uploadLength(request, format);
  const stored = storeFile(env, owner, name, format, length ?? 1,
    id => streamUpload(env.FILES, id, request.body, format, length));
  // Let cleanup finish when the client disconnects during an upload.
  ctx.waitUntil(stored.catch(() => {}));
  return json({ document: await stored }, 201);
}

async function storeDocument(env, owner, name, format, bytes, shared, settings = {}) {
  if (!bytes.byteLength) throw new HttpError(400, '文件为空。');
  if (bytes.byteLength > formats[format].max) throw new HttpError(413, '文件超出大小限制。');
  validateUploadSignature(format, bytes);
  return storeFile(env, owner, name, format, bytes.length,
    async id => (await env.FILES.put(id, bytes)).size, shared, settings);
}

async function requireActiveOwner(env, owner) {
  const active = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(owner).first();
  if (!active) throw new HttpError(403, '此账号已暂停使用。');
}

function storageLimit() {
  return new HttpError(409, '已达到 100 份文档或 150 MB 的空间上限。');
}

async function storeFile(env, owner, name, format, reservedSize, writeObject, shared = false, settings = {}) {
  const policy = shared ? await readSharePolicy(settings, env) : {};
  await cleanupIncomplete(env, owner);
  const id = randomHex(16);
  const time = now();
  const reservation = await env.DB.prepare(
    "INSERT INTO documents (id, owner_id, name, format, size, created_at, state) " +
    "SELECT ?, ?, ?, ?, ?, ?, 'pending' FROM (" +
    'SELECT COUNT(*) AS document_count, COALESCE(SUM(size), 0) AS total_size FROM documents WHERE owner_id = ?' +
    ") WHERE document_count < ? AND total_size + ? <= ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')",
  ).bind(id, owner, name, format, reservedSize, time, owner, maxDocuments, reservedSize, maxStorage, owner).run();
  if (!reservation.meta.changes) {
    await requireActiveOwner(env, owner);
    throw storageLimit();
  }

  const discardUpload = async () => {
    await env.DB.prepare("UPDATE documents SET state = 'deleting' WHERE id = ? AND state = 'pending'").bind(id).run();
    await purgeDocuments(env, [id]);
  };

  let size;
  try {
    size = await writeObject(id);
  } catch (error) {
    await discardUpload().catch(() => {});
    throw error;
  }
  // Chunked requests reserve a slot first and check the exact size at publication.
  const uploaded = await env.DB.prepare(
    "UPDATE documents SET state = 'ready', size = ?, share_token = ?, share_expires_at = ?, share_password_salt = ?, " +
    "share_password_hash = ? WHERE id = ? AND owner_id = ? AND state = 'pending' AND " + activeDocumentOwner +
    ' AND (size = ? OR ? + (SELECT COALESCE(SUM(other.size), 0) FROM documents AS other WHERE other.owner_id = documents.owner_id AND other.id != documents.id) <= ?)' +
    ' RETURNING ' + documentFields + ', ' + ownerShareFields,
  ).bind(size, shared ? randomHex(24) : null, policy.expiresAt ?? null, policy.salt ?? null, policy.verifier ?? null,
    id, owner, size, size, maxStorage).first();
  if (!uploaded) {
    await discardUpload();
    await requireActiveOwner(env, owner);
    if (size !== reservedSize) throw storageLimit();
    throw new HttpError(409, '上传已取消，请重试。');
  }
  return uploaded;
}

async function deleteDocument(env, owner, id) {
  const document = await env.DB.prepare(
    "UPDATE documents SET state = 'deleting', share_token = NULL WHERE id = ? AND owner_id = ? AND state != 'pending' RETURNING id",
  ).bind(id, owner).first();
  if (!document) throw missing();
  await purgeDocuments(env, [id]);
  return json({ ok: true });
}

async function listDocuments(env, owner) {
  const { results } = await env.DB.prepare(
    "SELECT " + documentFields + ", " + ownerShareFields + " FROM documents WHERE owner_id = ? AND state = 'ready' ORDER BY created_at DESC, id DESC",
  ).bind(owner).all();
  return results;
}

async function readSharePolicy(settings, env) {
  const { expires_in, password } = settings;
  const policy = {};
  if (expires_in !== undefined) {
    if (expires_in !== null && (!Number.isSafeInteger(expires_in) || expires_in < 1 || expires_in > 365 * 86400)) {
      throw new HttpError(400, '分享有效期须介于 1 秒和 365 天。');
    }
    policy.expiresAt = expires_in === null ? null : now() + expires_in;
  }
  if (password !== undefined) {
    if (password !== null && (typeof password !== 'string' || password.length < 4 || password.length > 64 || !password.trim())) {
      throw new HttpError(400, '分享口令须为 4–64 位字符。');
    }
    policy.salt = password === null ? null : randomHex(16);
    if (password !== null && !env.PASSWORD_PEPPER) throw new HttpError(503, '暂时无法设置口令。');
    policy.verifier = password === null ? null : hex(await passwordVerifier(password, policy.salt, env.PASSWORD_PEPPER));
  }
  return policy;
}

async function changeShare(env, owner, id, settings) {
  const condition = " WHERE id = ? AND owner_id = ? AND state = 'ready'";
  const returning = ' RETURNING ' + ownerShareFields;
  if (!settings.enabled) {
    const stopped = await env.DB.prepare(
      'UPDATE documents SET share_token = NULL, share_expires_at = NULL, share_password_salt = NULL, share_password_hash = NULL' +
      condition + returning,
    ).bind(id, owner).first();
    if (!stopped) throw missing();
    return stopped;
  }

  const policy = await readSharePolicy(settings, env);
  const hasExpiry = Object.hasOwn(policy, 'expiresAt');
  const fields = ['share_token = CASE WHEN share_token IS NULL OR NOT ' + shareExpiryFilter + ' THEN ? ELSE share_token END'];
  const values = [randomHex(24)];
  if (hasExpiry) {
    fields.push('share_expires_at = ?');
    values.push(policy.expiresAt);
  }
  if (Object.hasOwn(policy, 'verifier')) {
    fields.push('share_password_salt = ?', 'share_password_hash = ?');
    values.push(policy.salt, policy.verifier);
  }
  const update = await env.DB.prepare(
    'UPDATE documents SET ' + fields.join(', ') + condition +
    (hasExpiry ? '' : ' AND ' + shareExpiryFilter) + returning,
  ).bind(...values, id, owner).first();
  if (!update && !hasExpiry) {
    const existing = await env.DB.prepare('SELECT id FROM documents' + condition).bind(id, owner).first();
    if (existing) throw new HttpError(409, '此分享已过期，请选择新的有效期。');
  }
  if (!update) throw missing();
  return update;
}

async function mcpToken(request, env, owner) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT created_at FROM mcp_tokens WHERE user_id = ?').bind(owner).first();
    return json({ created_at: row?.created_at ?? null });
  }
  if (request.method === 'POST') {
    const token = 'fd_' + randomHex(32);
    const time = now();
    const result = await env.DB.prepare(
      'INSERT INTO mcp_tokens (user_id, token_hash, created_at) ' +
      "SELECT users.id, ?, ? FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.id = ? AND users.status = 'active' " +
      'ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at',
    ).bind(hex(await digest(token)), time, hex(await digest(sessionToken(request))), time, owner).run();
    if (!result.meta.changes) throw new HttpError(401, '登录已失效，请重新登录。');
    return json({ token, created_at: time }, 201);
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM mcp_tokens WHERE user_id = ?').bind(owner).run();
    return json({ ok: true });
  }
  throw new HttpError(405, '此请求方式不可用。');
}

function shareFields(origin, document) {
  const { share_token, share_expires_at, share_requires_password } = document;
  const token = share_expires_at !== null && share_expires_at <= now() ? null : share_token;
  return {
    share_url: token ? origin + '/share/' + token : null,
    share_code: formatShareCode(token),
    share_expires_at,
    share_requires_password: Boolean(share_requires_password),
  };
}

async function resolveShareCode(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const { success } = await env.AUTH_LIMIT.limit({ key: 'folio-share-code:' + ip });
  if (!success) throw new HttpError(429, '尝试次数过多，请稍后重试。');
  const body = await readJson(request);
  const code = normalizeShareCode(body.code);
  if (!code) throw new HttpError(400, '请输入 16 位分享码。');
  const { results } = await env.DB.prepare(
    "SELECT share_token FROM documents WHERE share_token IS NOT NULL AND state = 'ready' AND " +
    shareExpiryFilter + ' AND ' + activeDocumentOwner + ' AND substr(share_token, 1, 16) = ? LIMIT 2',
  ).bind(code).all();
  if (results.length !== 1) throw new HttpError(404, '分享码无效或分享已关闭。');
  return json({ path: '/share/' + results[0].share_token });
}

async function shareGrantSignature(env, token, verifier, expires) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.PASSWORD_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(['folio-share-v1', token, verifier, expires].join(':')));
}

async function hasShareGrant(request, env, token, verifier) {
  const grant = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Secure-folio_share=(\d{1,12})\.([a-f0-9]{64})(?:;|$)/);
  if (!grant || Number(grant[1]) <= now() || !env.PASSWORD_PEPPER) return false;
  const signature = await shareGrantSignature(env, token, verifier, grant[1]);
  return crypto.subtle.timingSafeEqual(signature, fromHex(grant[2]));
}

async function verifySharePassword(request, env, token, share) {
  if (!share.share_password_hash) return json({ ok: true });
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const { success } = await env.AUTH_LIMIT.limit({ key: 'folio-share-password:' + ip });
  if (!success) throw new HttpError(429, '尝试次数过多，请稍后重试。');
  const { password } = await readJson(request);
  if (typeof password !== 'string' || password.length > 64) throw new HttpError(400, '请输入有效的分享口令。');
  if (!env.PASSWORD_PEPPER) throw new HttpError(503, '暂时无法验证口令。');
  const verifier = await passwordVerifier(password, share.share_password_salt, env.PASSWORD_PEPPER);
  if (!crypto.subtle.timingSafeEqual(verifier, fromHex(share.share_password_hash))) {
    throw new HttpError(403, '分享口令不正确。');
  }

  const time = now();
  const expires = Math.min(time + shareGrantLifetime, share.share_expires_at ?? Infinity);
  if (expires <= time) throw missing();
  const signature = hex(await shareGrantSignature(env, token, share.share_password_hash, expires));
  const cookie = shareGrantCookie + '=' + expires + '.' + signature + '; Max-Age=' + (expires - time) +
    '; Path=/api/shared/' + token + '; Secure; HttpOnly; SameSite=Lax';
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function mcp(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) throw new HttpError(403, '此请求不受信任。');
  const token = request.headers.get('Authorization')?.match(/^Bearer (fd_[a-f0-9]{64})$/i)?.[1];
  const user = token ? await env.DB.prepare(
    "SELECT user_id FROM mcp_tokens JOIN users ON users.id = mcp_tokens.user_id WHERE token_hash = ? AND users.status = 'active'",
  )
    .bind(hex(await digest(token))).first() : null;
  if (!user) return json({ error: '需要有效的 MCP 令牌。' }, 401, {
    'WWW-Authenticate': 'Bearer realm="Folio Dock"',
  });
  if (request.method !== 'POST') return new Response(null, {
    status: 405,
    headers: { ...security, 'Cache-Control': 'no-store', Allow: 'POST' },
  });

  const body = await readJson(request, maxMcpBody);
  const result = await handleMcp(request, body, {
    async list(query, limit) {
      const docs = await listDocuments(env, user.user_id);
      return {
        documents: docs.filter(doc => doc.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit).map(({ share_token, ...doc }) => ({ ...doc, ...shareFields(url.origin, { ...doc, share_token }) })),
      };
    },
    async upload({ filename, text, base64, share, ...settings }) {
      const name = cleanFilename(filename);
      const format = getFormat(name);
      if (formats[format].binary && base64 === undefined) {
        throw new HttpError(400, '上传 .' + format + ' 文件请使用 base64。');
      }
      let bytes;
      try {
        bytes = base64 === undefined ? encoder.encode(text) : Uint8Array.fromBase64(base64);
      } catch {
        throw new HttpError(400, 'base64 内容无效。');
      }
      if (bytes.byteLength > 4 * MiB) throw new HttpError(413, 'MCP 单文件上限为 4 MB。');
      const { share_token, ...doc } = await storeDocument(env, user.user_id, name, format, bytes, share, settings);
      return { ...doc, ...shareFields(url.origin, { ...doc, share_token }) };
    },
    async share({ document_id, ...settings }) {
      const result = await changeShare(env, user.user_id, document_id, settings);
      return { document_id, ...shareFields(url.origin, result) };
    },
    errorMessage(error) {
      if (error instanceof HttpError) return error.message;
      console.error('Folio Dock MCP tool failed', error.message);
      return '操作暂时不可用，请稍后重试。';
    },
  });
  const response = new Response(result.body, result);
  for (const [name, value] of Object.entries(security)) response.headers.set(name, value);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function activateAdmin(request, env, user) {
  if (user.is_admin) return json({ is_admin: true });
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const { success } = await env.AUTH_LIMIT.limit({ key: 'folio-admin:' + ip });
  if (!success) throw new HttpError(429, '尝试次数过多，请稍后重试。');
  const { code } = await readJson(request);
  if (typeof code !== 'string' || !env.ADMIN_SETUP_CODE) throw new HttpError(403, '管理员激活码无效。');
  const [provided, expected] = await Promise.all([digest(code.trim()), digest(env.ADMIN_SETUP_CODE)]);
  if (!crypto.subtle.timingSafeEqual(provided, expected)) throw new HttpError(403, '管理员激活码无效。');
  const result = await env.DB.prepare(
    "UPDATE users SET is_admin = 1 WHERE id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)",
  ).bind(user.id).run();
  if (!result.meta.changes) throw new HttpError(409, '管理员已完成设置。');
  return json({ is_admin: true });
}

async function adminDocuments(env, url) {
  const filter = url.searchParams.get('filter') ?? 'all';
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new HttpError(400, '页码无效。');
  const filters = {
    all: '1 = 1',
    shared: "documents.state = 'ready' AND documents.share_token IS NOT NULL AND users.status = 'active' AND " + shareExpiryFilter,
    private: "documents.state = 'ready' AND (documents.share_token IS NULL OR users.status != 'active' OR NOT " + shareExpiryFilter + ')',
    incomplete: "documents.state != 'ready'",
  };
  if (!Object.hasOwn(filters, filter)) throw new HttpError(400, '筛选条件无效。');
  const from = ' FROM documents JOIN users ON documents.owner_id = users.id WHERE ' + filters[filter] +
    ' AND (instr(lower(documents.name), lower(?)) > 0 OR instr(users.username, lower(?)) > 0)';
  const [items, count, stats] = await env.DB.batch([
    env.DB.prepare(
      'SELECT documents.id, documents.name, documents.format, documents.size, documents.created_at, documents.state, ' +
      "(documents.share_token IS NOT NULL AND users.status = 'active' AND " + shareExpiryFilter + ') AS shared, users.username AS owner' + from +
      ' ORDER BY documents.created_at DESC, documents.id DESC LIMIT ? OFFSET ?',
    ).bind(query, query, pageSize, (page - 1) * pageSize),
    env.DB.prepare('SELECT COUNT(*) AS total' + from).bind(query, query),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS size, COALESCE(SUM(CASE WHEN " +
      incomplete + ' THEN 1 ELSE 0 END), 0) AS cleanable FROM documents',
    ).bind(now() - 3600),
  ]);
  return json({ documents: items.results, total: count.results[0].total, page_size: pageSize, stats: stats.results[0] });
}

async function listUsers(env, url) {
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 32);
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new HttpError(400, '页码无效。');
  const filter = ' FROM users WHERE instr(username, ?) > 0';
  const [items, count] = await env.DB.batch([
    env.DB.prepare(
      'SELECT id, username, is_admin, status, ' +
      '(SELECT COUNT(*) FROM documents WHERE owner_id = users.id) AS document_count' +
      filter + ' ORDER BY is_admin DESC, username ASC LIMIT ? OFFSET ?',
    ).bind(query, pageSize, (page - 1) * pageSize),
    env.DB.prepare('SELECT COUNT(*) AS total' + filter).bind(query),
  ]);
  return json({ users: items.results, total: count.results[0].total, page_size: pageSize });
}

async function updateMember(env, id, assignments, values, { revoke, allowDeleting = false }) {
  const predicate = "id = ? AND is_admin = 0" + (allowDeleting ? '' : " AND status != 'deleting'");
  const statements = [env.DB.prepare('UPDATE users SET ' + assignments + ' WHERE ' + predicate).bind(...values, id)];
  if (revoke) {
    statements.push(
      env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? AND is_admin = 0)').bind(id),
      env.DB.prepare('DELETE FROM mcp_tokens WHERE user_id IN (SELECT id FROM users WHERE id = ? AND is_admin = 0)').bind(id),
    );
  }
  const [result] = await env.DB.batch(statements);
  if (!result.meta.changes) throw new HttpError(409, '用户状态已变化，请刷新后重试。');
}

async function deleteMember(id, env) {
  await updateMember(env, id, 'status = ?', ['deleting'], { revoke: true, allowDeleting: true });
  const { results } = await env.DB.prepare(
    "UPDATE documents SET state = 'deleting', share_token = NULL WHERE owner_id = ? AND (state != 'pending' OR created_at < ?) RETURNING id",
  ).bind(id, now() - 3600).all();
  for (let offset = 0; offset < results.length; offset += 50) {
    await purgeDocuments(env, results.slice(offset, offset + 50).map(document => document.id));
  }

  const deleted = await env.DB.prepare(
    "DELETE FROM users WHERE id = ? AND status = 'deleting' AND NOT EXISTS (SELECT 1 FROM documents WHERE owner_id = users.id)",
  ).bind(id).run();
  if (!deleted.meta.changes) {
    const pending = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
    if (pending) return json({ status: 'deleting' }, 202);
  }
  return json({ status: 'deleted' });
}

async function manageMember(request, env, id, action) {
  const member = await env.DB.prepare('SELECT is_admin, status FROM users WHERE id = ?').bind(id).first();
  if (!member) throw new HttpError(404, '找不到此用户。');
  if (member.is_admin) throw new HttpError(403, '此操作仅支持普通用户。');
  if (request.method === 'DELETE' && !action) return deleteMember(id, env);
  if (member.status === 'deleting') throw new HttpError(409, '此账号正在删除。');

  if (request.method === 'PATCH' && action === 'password') {
    const { password } = await readJson(request);
    if (!validPassword(password)) throw new HttpError(400, '密码须为 12–128 位。');
    const { salt, verifier } = await makePassword(password, env);
    await updateMember(env, id, 'salt = ?, verifier = ?', [salt, verifier], { revoke: true });
    return json({ ok: true });
  }
  if (request.method === 'PATCH' && action === 'status') {
    const { status } = await readJson(request);
    if (status !== 'active' && status !== 'disabled') throw new HttpError(400, '用户状态无效。');
    await updateMember(env, id, 'status = ?', [status], { revoke: status === 'disabled' });
    return json({ status });
  }
  throw new HttpError(405, '此请求方式不可用。');
}

async function admin(request, env, url, user) {
  const { pathname } = url;
  if (pathname === '/api/admin/activate') {
    if (request.method === 'POST') return activateAdmin(request, env, user);
    if (request.method === 'GET') {
      const administrator = await env.DB.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').first();
      return json({ available: !administrator && Boolean(env.ADMIN_SETUP_CODE) });
    }
  }
  if (!user.is_admin) throw new HttpError(403, '需要管理员权限。');
  if (pathname === '/api/admin/users' && request.method === 'GET') return listUsers(env, url);
  if (pathname === '/api/admin/users' && request.method === 'POST') {
    const { username, password } = readCredentials(await readJson(request));
    await createUser(env, username, password);
    return json({ username }, 201);
  }
  const member = pathname.match(/^\/api\/admin\/users\/([a-f0-9]{32})(?:\/(password|status))?$/);
  if (member) return manageMember(request, env, member[1], member[2]);
  if (pathname === '/api/admin/documents' && request.method === 'GET') return adminDocuments(env, url);
  if (pathname === '/api/admin/cleanup' && request.method === 'POST') {
    return json({ deleted: await cleanupIncomplete(env) });
  }
  if (pathname === '/api/admin/documents/delete' && request.method === 'POST') {
    const { ids } = await readJson(request);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
        ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) {
      throw new HttpError(400, '请选择 1–50 份文档。');
    }
    const { results } = await env.DB.prepare(
      "UPDATE documents SET state = 'deleting', share_token = NULL WHERE state != 'pending' AND id IN (" +
      placeholders(ids.length) + ') RETURNING id',
    ).bind(...ids).all();
    return json({ deleted: await purgeDocuments(env, results.map(({ id }) => id)) });
  }
  throw new HttpError(404, '页面不存在。');
}

function documentHeaders(type, csp) {
  return {
    ...security,
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    'Content-Type': type,
  };
}

function disposition(name, mode) {
  const escaped = encodeURIComponent(name).replace(/[!'()*]/g, character =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return mode + "; filename*=UTF-8''" + escaped;
}

async function contents(env, document, download) {
  const { name, format } = document;
  if (!download && formats[format].preview === 'rich') {
    return new Response(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>文档预览</title><link rel="stylesheet" href="/preview.css"><script defer src="/preview.js"></script>' +
      '<main data-format="' + format + '"><p role="status">正在加载预览…</p></main></html>',
      { headers: documentHeaders(formats.html.type, richPreviewCsp) },
    );
  }
  const file = await env.FILES.get(document.id);
  if (!file) throw missing();
  if (download || formats[format].preview === 'download') {
    return new Response(file.body, {
      headers: {
        ...documentHeaders('application/octet-stream', "default-src 'none'; sandbox"),
        'Content-Disposition': disposition(name, 'attachment'),
        'Content-Length': String(file.size),
      },
    });
  }
  if (format === 'md') {
    const body = md.render(await file.text());
    return new Response(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Markdown 预览</title><style>' + markdownStyle + '</style><main>' + body + '</main></html>',
      { headers: documentHeaders(formats.html.type, frameCsp + '; sandbox') },
    );
  }

  let csp = frameCsp;
  if (format === 'html') csp += "; sandbox allow-scripts; script-src 'unsafe-inline' blob:";
  if (format === 'txt' || formats[format].preview === 'image') csp += '; sandbox';
  return new Response(file.body, {
    headers: {
      ...documentHeaders(formats[format].type, csp),
      'Content-Disposition': disposition(name, 'inline'),
      'Content-Length': String(file.size),
    },
  });
}

async function api(request, env, url, ctx) {
  const { pathname } = url;
  const method = request.method;
  if (method !== 'GET' && (
    request.headers.get('X-Folio-Action') !== '1' ||
    (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
  )) throw new HttpError(403, '此请求不受信任。');

  if (method === 'POST' && pathname === '/api/register') return auth(request, env, true);
  if (method === 'POST' && pathname === '/api/login') return auth(request, env, false);
  if (method === 'POST' && pathname === '/api/share-code') return resolveShareCode(request, env);
  if (method === 'POST' && pathname === '/api/logout') {
    const token = sessionToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hex(await digest(token))).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const shared = pathname.match(/^\/api\/shared\/([a-f0-9]{48})(?:\/(preview|download|verify))?$/);
  if (shared) {
    const [, token, action] = shared;
    if (action === 'verify' ? method !== 'POST' : method !== 'GET') throw new HttpError(405, '此请求方式不可用。');
    const record = await env.DB.prepare(
      'SELECT ' + documentFields + ', share_expires_at, share_password_salt, share_password_hash ' +
      "FROM documents WHERE share_token = ? AND state = 'ready' AND " + shareExpiryFilter + ' AND ' + activeDocumentOwner,
    ).bind(token).first();
    if (!record) throw missing();
    if (action === 'verify') return verifySharePassword(request, env, token, record);
    const { share_expires_at, share_password_salt, share_password_hash, ...document } = record;
    if (share_password_hash && !await hasShareGrant(request, env, token, share_password_hash)) {
      return json({ error: '此分享需要口令。', code: 'share_password_required' }, 403);
    }
    return action ? contents(env, document, action === 'download') : json({ document });
  }

  const user = await getUser(request, env);
  if (method === 'GET' && pathname === '/api/session') {
    return json({ username: user?.username ?? null, is_admin: Boolean(user?.is_admin) });
  }
  if (!user) throw new HttpError(401, '请先登录。');
  if (pathname === '/api/mcp-token') return mcpToken(request, env, user.id);
  if (pathname.startsWith('/api/admin/')) return admin(request, env, url, user);
  if (pathname === '/api/documents') {
    if (method === 'GET') return json({ documents: await listDocuments(env, user.id) });
    if (method === 'POST') return upload(request, env, user.id, ctx);
  }

  const owned = pathname.match(/^\/api\/documents\/([a-f0-9]{32})(?:\/(preview|download|share))?$/);
  if (!owned) throw new HttpError(404, '页面不存在。');
  const [, id, action] = owned;
  if (method === 'DELETE' && !action) return deleteDocument(env, user.id, id);
  if (method === 'PATCH' && action === 'share') {
    const settings = await readJson(request);
    if (typeof settings.enabled !== 'boolean') throw new HttpError(400, '缺少分享状态。');
    return json(await changeShare(env, user.id, id, settings));
  }
  if (method === 'GET' && action !== 'share') {
    const document = await env.DB.prepare(
      "SELECT " + documentFields + ", " + ownerShareFields + " FROM documents WHERE id = ? AND owner_id = ? AND state = 'ready'",
    ).bind(id, user.id).first();
    if (!document) throw missing();
    return action ? contents(env, document, action === 'download') : json({ document });
  }
  throw new HttpError(405, '此请求方式不可用。');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url, ctx);
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') return await mcp(request, env, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, '此请求方式不可用。');
      const layout = url.pathname.match(/^\/office-layout\/(docx|pptx)$/);
      if (layout) {
        return new Response(
          request.method === 'HEAD' ? null :
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>Office 版式预览</title><link rel="stylesheet" href="/preview.css">' +
            '<script defer src="/' + layout[1] + '-layout.js"></script><main id="layout"><p role="status">正在排版…</p></main></html>',
          { headers: documentHeaders(formats.html.type, officeLayoutCsp) },
        );
      }
      if (/^\/(?:share|document)\/[a-f0-9]+\/?$/.test(url.pathname) || /^\/admin\/?$/.test(url.pathname)) {
        url.pathname = '/';
      }
      const asset = await env.ASSETS.fetch(new Request(url, request));
      const response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(security)) response.headers.set(name, value);
      response.headers.set('Content-Security-Policy', appCsp);
      return response;
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Folio Dock request failed', error.message);
      return json({ error: '服务暂时不可用，请稍后重试。' }, 503);
    }
  },
};
