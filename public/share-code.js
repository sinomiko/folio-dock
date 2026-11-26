export function formatShareCode(token) {
  return token ? token.slice(0, 16).toUpperCase().match(/.{4}/g).join('-') : null;
}

export function normalizeShareCode(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{16}$/.test(normalized) ? normalized : null;
}
