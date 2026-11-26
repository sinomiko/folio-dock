import { renderOffice } from './office.js';

const caption = message => {
  const element = document.createElement('p');
  element.setAttribute('role', 'status');
  element.className = 'layout-notice';
  element.textContent = message;
  return element;
};

export function startLayout(format, render) {
  const output = document.querySelector('#layout');
  // The containing preview owns authentication. This frame receives only the file bytes.
  window.addEventListener('message', receive);
  output.addEventListener('click', event => {
    if (event.target.closest('a')) event.preventDefault();
  });

  async function receive(event) {
    if (event.source !== parent || event.origin !== location.origin ||
        event.data?.type !== 'folio-office-file' || !(event.data.bytes instanceof ArrayBuffer)) return;
    window.removeEventListener('message', receive);
    const bytes = new Uint8Array(event.data.bytes);
    const content = document.createElement('div');
    content.className = format === 'docx' ? 'word-layout' : 'slide-layout';
    output.append(content);
    try {
      await render(bytes, content);
      output.querySelector(':scope > [role="status"]')?.remove();
    } catch {
      try {
        renderOffice(bytes, format, output);
        output.prepend(caption('版式预览暂不可用，已切换为内容预览。'));
      } catch {
        output.replaceChildren(caption('无法生成在线预览。可下载原文件查看。'));
      }
    }
  }
}
