export function dataUrl(type, bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof view.toBase64 === 'function') return 'data:' + type + ';base64,' + view.toBase64();
  const chunks = [];
  for (let index = 0; index < view.length; index += 8192) {
    chunks.push(String.fromCharCode(...view.subarray(index, index + 8192)));
  }
  return 'data:' + type + ';base64,' + btoa(chunks.join(''));
}
