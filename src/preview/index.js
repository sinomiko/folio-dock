import { renderArchive } from './archive.js';
import { renderOffice } from './office.js';

const container = document.querySelector('main[data-format]');
const { format } = container.dataset;
const download = location.pathname.replace(/\/preview$/, '/download');

function mountLayout(bytes, format) {
  const frame = document.createElement('iframe');
  frame.className = 'office-layout-frame';
  frame.title = format === 'docx' ? 'Word 版式预览' : 'PowerPoint 版式预览';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ type: 'folio-office-file', bytes: bytes.buffer }, '*', [bytes.buffer]);
  }, { once: true });
  frame.src = '/office-layout/' + format;
  container.replaceChildren(frame);
}

async function load() {
  if (!/^\/api\/(?:documents\/[a-f0-9]{32}|shared\/[a-f0-9]{48})\/download$/.test(download)) return;
  try {
    const response = await fetch(download, { cache: 'no-store' });
    if (!response.ok) throw new Error('文档暂时无法读取，或分享链接已失效。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (format === 'mhtml') await renderArchive(bytes, container);
    else if (format === 'docx' || format === 'pptx') mountLayout(bytes, format);
    else renderOffice(bytes, format, container);
  } catch (error) {
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
      ? error.message + ' 可下载原文件查看。'
      : '无法生成在线预览。可下载原文件查看。';
    container.replaceChildren(message);
  }
}

void load();
