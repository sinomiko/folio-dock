import { renderAsync } from 'docx-preview';
import { unzipSync } from 'fflate';
import { startLayout } from './office-layout.js';

startLayout('docx', async (bytes, content) => {
  let size = 0;
  let count = 0;
  unzipSync(bytes, {
    filter(file) {
      size += file.originalSize;
      count += 1;
      if (size > 64 * 1024 * 1024 || count > 1500) throw new Error('Word package exceeds preview limits');
      return false;
    },
  });
  await renderAsync(bytes, content, undefined, {
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
  });
  for (const anchor of content.querySelectorAll('a[href]')) {
    if (!anchor.getAttribute('href').startsWith('#')) anchor.removeAttribute('href');
  }
  const pages = content.querySelectorAll('section.docx');
  if (!pages.length) throw new Error('Word package contains no pages');
  const fit = () => {
    for (const page of pages) {
      page.style.setProperty('--page-scale', Math.min(1, (content.clientWidth - 24) / page.offsetWidth));
    }
  };
  new ResizeObserver(fit).observe(content);
  fit();
});
