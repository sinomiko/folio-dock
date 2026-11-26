import PostalMime from 'postal-mime';
import { imageTypes } from '../formats.js';
import { dataUrl } from './shared.js';

const capturedImages = new Set(Object.values(imageTypes));
const fontTypes = new Set(['font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'application/font-woff']);
const thisMessage = 'https://snapshot.invalid/';
const outputLimit = 30 * 1024 * 1024;
const archiveCsp = [
  "default-src 'none'", "style-src 'unsafe-inline' data:", 'img-src data:', 'font-src data:',
  "base-uri 'none'", "form-action 'none'",
].join('; ');

function header(part, name) {
  return part.headers.find(item => item.key === name)?.value.trim() || '';
}

function absolute(ref, base) {
  if (!ref) return '';
  try {
    const url = new URL(ref, base);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function cid(value) {
  return value.trim().replace(/^<|>$/g, '');
}

function descendants(part) {
  return [part, ...part.childNodes.flatMap(descendants)];
}

export async function renderArchive(bytes, container) {
  const parser = new PostalMime({ maxNestingDepth: 16, maxPartCount: 2000, maxHeadersSize: 512 * 1024, maxRfc822NestingDepth: 0 });
  await parser.parse(bytes);
  // Keep MIME locations and individual HTML parts that the email-oriented return value flattens.
  const tree = parser.root;
  const parts = descendants(tree);
  const start = cid(tree.contentType.parsed.params.start || '');
  const preferred = start && parts.find(part => cid(header(part, 'content-id')) === start);
  const isHtml = part => part.contentType.parsed.value === 'text/html' && Boolean(part.content);
  const root = (preferred && descendants(preferred).find(isHtml)) || parts.find(isHtml);
  if (!root) throw new Error('归档中没有可预览的 HTML 页面。');

  const archiveBase = absolute(header(tree, 'content-location') || header(tree, 'snapshot-content-location'), thisMessage) || thisMessage;
  const pageBase = absolute(header(root, 'content-location'), archiveBase) || archiveBase;
  const template = document.createElement('template');
  template.innerHTML = root.getTextContent();
  const content = template.content;
  const base = absolute(content.querySelector('base[href]')?.getAttribute('href'), pageBase) || pageBase;
  const byUrl = new Map();
  const byId = new Map();
  const encoded = new Map();

  for (const part of parts) {
    const location = header(part, 'content-location');
    const key = absolute(location, pageBase);
    const id = cid(header(part, 'content-id'));
    if (key && !byUrl.has(key)) byUrl.set(key, part);
    const archiveKey = absolute(location, archiveBase);
    if (archiveKey && !byUrl.has(archiveKey)) byUrl.set(archiveKey, part);
    if (id && !byId.has(id)) byId.set(id, part);
  }

  function findPart(ref, resourceBase) {
    if (/^cid:/i.test(ref)) {
      let id = ref.slice(4);
      try { id = decodeURIComponent(id); } catch { /* Use the original Content-ID. */ }
      return byId.get(cid(id));
    }
    return byUrl.get(absolute(ref, resourceBase));
  }

  let expanded = 0;
  function include(value) {
    expanded += value.length;
    return expanded <= outputLimit ? value : '';
  }

  function assetUrl(value, resourceBase, allowed) {
    const ref = value?.trim();
    if (!ref) return '';
    const dataType = ref.match(/^data:([^;,]+)[;,]/i)?.[1].toLowerCase();
    if (dataType && allowed(dataType)) return include(ref);
    const part = findPart(ref, resourceBase);
    const type = part?.contentType.parsed.value;
    if (!part?.content || !allowed(type)) return '';
    if (!encoded.has(part)) encoded.set(part, dataUrl(type, part.content));
    return include(encoded.get(part));
  }

  function rewriteCss(css, resourceBase) {
    return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, double, single, raw) => {
      const ref = (double ?? single ?? raw).trim();
      if (/^#[\w.-]+$/.test(ref)) return 'url("' + ref + '")';
      const url = assetUrl(ref, resourceBase, type => capturedImages.has(type) || fontTypes.has(type));
      return url ? 'url("' + url.replace(/["\\\r\n]/g, encodeURIComponent) + '")' : 'url("data:,")';
    });
  }

  for (const element of content.querySelectorAll('script, iframe, frame, frameset, object, embed, base, meta[http-equiv], audio, video, template')) {
    element.remove();
  }
  for (const element of content.querySelectorAll('link')) {
    const part = findPart(element.getAttribute('href') || '', base);
    if (!element.relList.contains('stylesheet') || part?.contentType.parsed.value !== 'text/css') {
      element.remove();
      continue;
    }
    const cssBase = absolute(header(part, 'content-location'), base) || base;
    const url = dataUrl('text/css;charset=utf-8', new TextEncoder().encode(rewriteCss(part.getTextContent(), cssBase)));
    if (!include(url)) {
      element.remove();
      continue;
    }
    element.removeAttribute('integrity');
    element.removeAttribute('crossorigin');
    element.setAttribute('href', url);
  }
  for (const style of content.querySelectorAll('style')) {
    style.textContent = rewriteCss(style.textContent, base).replace(/<\/style/gi, '\\3c /style');
  }
  for (const element of content.querySelectorAll('[style]')) {
    element.setAttribute('style', rewriteCss(element.getAttribute('style'), base));
  }
  for (const element of content.querySelectorAll('[srcset]')) {
    if (element.localName === 'img' && !element.hasAttribute('src')) {
      const first = element.getAttribute('srcset').trim().split(/\s+/)[0];
      if (first) element.setAttribute('src', first.replace(/,$/, ''));
    }
    element.removeAttribute('srcset');
  }
  for (const element of content.querySelectorAll('img[src], [background], svg image')) {
    for (const name of ['src', 'background', 'href', 'xlink:href']) {
      if (!element.hasAttribute(name)) continue;
      const url = assetUrl(element.getAttribute(name), base, type => capturedImages.has(type));
      if (url) element.setAttribute(name, url);
      else element.removeAttribute(name);
    }
  }
  for (const element of content.querySelectorAll('a, area')) {
    for (const name of ['href', 'xlink:href', 'ping', 'target']) {
      if (name === 'href' && element.getAttribute(name)?.startsWith('#')) continue;
      element.removeAttribute(name);
    }
  }

  const frame = document.createElement('iframe');
  frame.className = 'archive-frame';
  frame.title = 'MHTML 网页快照';
  frame.setAttribute('sandbox', '');
  frame.referrerPolicy = 'no-referrer';
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    archiveCsp + '"><meta name="viewport" content="width=device-width, initial-scale=1">' + template.innerHTML;
  container.replaceChildren(frame);
}
