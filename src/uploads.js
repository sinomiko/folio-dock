import { formats, validSignature } from './formats.js';
import { HttpError } from './http-error.js';

const signatureBytes = 4096;
const partSize = 5 * 1024 * 1024;

export function uploadLength(request, format) {
  if (!request.body) throw new HttpError(400, '文件为空。');
  const header = request.headers.get('Content-Length');
  if (header === null) return null;
  const length = Number(header);
  if (!/^\d+$/.test(header) || !Number.isSafeInteger(length)) throw new HttpError(400, '上传长度无效。');
  if (!length) throw new HttpError(400, '文件为空。');
  if (length > formats[format].max) throw new HttpError(413, '文件超出大小限制。');
  return length;
}

export function validateUploadSignature(format, bytes) {
  if (!validSignature(format, bytes)) throw new HttpError(400, '文件内容与 .' + format + ' 格式不符。');
}

async function* checkedChunks(body, format, length) {
  const reader = body.getReader();
  const prefix = new Uint8Array(signatureBytes);
  const max = formats[format].max;
  let prefixLength = 0;
  let size = 0;
  let checked = false;
  let finished = false;
  try {
    while (true) {
      let chunk;
      let done;
      try {
        ({ value: chunk, done } = await reader.read());
      } catch {
        throw new HttpError(400, '上传连接已中断。');
      }
      if (done) {
        finished = true;
        break;
      }
      size += chunk.byteLength;
      if (size > max) throw new HttpError(413, '文件超出大小限制。');
      if (length !== null && size > length) throw new HttpError(400, '上传长度与文件内容不符。');

      if (!checked) {
        const copied = Math.min(signatureBytes - prefixLength, chunk.byteLength);
        prefix.set(chunk.subarray(0, copied), prefixLength);
        prefixLength += copied;
        if (prefixLength < signatureBytes) continue;
        validateUploadSignature(format, prefix);
        checked = true;
        yield prefix;
        chunk = chunk.subarray(copied);
      }
      if (chunk.byteLength) yield chunk;
    }
    if (!size) throw new HttpError(400, '文件为空。');
    if (length !== null && size !== length) throw new HttpError(400, '上传长度与文件内容不符。');
    if (!checked) {
      const bytes = prefix.subarray(0, prefixLength);
      validateUploadSignature(format, bytes);
      yield bytes;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function putFixedLength(bucket, id, chunks, length) {
  const { readable, writable } = new FixedLengthStream(length);
  const abort = new AbortController();
  const piping = ReadableStream.from(chunks).pipeTo(writable, { signal: abort.signal });
  const writing = bucket.put(id, readable).catch(error => {
    abort.abort(error);
    throw error;
  });
  // Wait for both ends to stop before the caller can remove a failed upload.
  const [piped, stored] = await Promise.allSettled([piping, writing]);
  if (piped.status === 'rejected') throw piped.reason;
  if (stored.status === 'rejected') throw stored.reason;
  return stored.value;
}

async function putUnknownLength(bucket, id, chunks, max) {
  // R2 requires known lengths per write. Use one bounded buffer for chunked requests.
  const buffer = new Uint8Array(Math.min(partSize, max));
  let used = 0;
  let multipart;
  const parts = [];
  try {
    for await (const chunk of chunks) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (used === buffer.length) {
          multipart ??= await bucket.createMultipartUpload(id);
          parts.push(await multipart.uploadPart(parts.length + 1, buffer));
          used = 0;
        }
        const copied = Math.min(buffer.length - used, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + copied), used);
        used += copied;
        offset += copied;
      }
    }
    const last = buffer.subarray(0, used);
    if (!multipart) return await bucket.put(id, last);
    parts.push(await multipart.uploadPart(parts.length + 1, last));
    return await multipart.complete(parts);
  } catch (error) {
    if (multipart) await multipart.abort().catch(() => {});
    throw error;
  }
}

export async function streamUpload(bucket, id, body, format, length) {
  const chunks = checkedChunks(body, format, length);
  const object = length === null
    ? await putUnknownLength(bucket, id, chunks, formats[format].max)
    : await putFixedLength(bucket, id, chunks, length);
  return object.size;
}
