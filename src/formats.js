const MiB = 1024 * 1024;
const max = 50 * MiB;
const richOffice = { max, binary: true, preview: 'rich' };
const oldOffice = { max, binary: true, preview: 'download' };

export const imageTypes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

const imageFormats = Object.fromEntries(
  Object.entries(imageTypes).map(([format, type]) => [format, { type, max, binary: true, preview: 'image' }]),
);

export const formats = {
  html: { type: 'text/html; charset=utf-8', max },
  md: { max: MiB },
  pdf: { type: 'application/pdf', max, binary: true },
  txt: { type: 'text/plain; charset=utf-8', max: 2 * MiB },
  ...imageFormats,
  mhtml: { max, preview: 'rich' },
  xlsx: richOffice,
  docx: richOffice,
  pptx: richOffice,
  xls: oldOffice,
  doc: oldOffice,
  ppt: oldOffice,
};

export const formatAliases = { htm: 'html', markdown: 'md', jpeg: 'jpg', mht: 'mhtml' };

export function validSignature(format, bytes) {
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  switch (format) {
    case 'pdf': return ascii(0, 5) === '%PDF-';
    case 'png': return ascii(0, 8) === '\x89PNG\r\n\x1a\n';
    case 'jpg': return ascii(0, 3) === '\xff\xd8\xff';
    case 'gif': return /^GIF8[79]a$/.test(ascii(0, 6));
    case 'webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'avif': {
      if (ascii(4, 8) !== 'ftyp') return false;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const length = Math.min(view.getUint32(0), bytes.length, 256);
      for (let offset = 8; offset + 4 <= length; offset += 4) {
        if (offset !== 12 && /^(avif|avis)$/.test(ascii(offset, offset + 4))) return true;
      }
      return false;
    }
    case 'bmp': return ascii(0, 2) === 'BM';
    case 'svg':
      return /<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));
    case 'xlsx':
    case 'docx':
    case 'pptx':
      return ascii(0, 4) === 'PK\x03\x04' || ascii(0, 8) === '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1';
    default: return true;
  }
}
