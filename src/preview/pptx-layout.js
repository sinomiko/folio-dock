import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer';
import { startLayout } from './office-layout.js';

startLayout('pptx', async (bytes, content) => {
  const viewer = await PptxViewer.open(bytes, content, {
    externalMedia: 'block',
    pdfjs: false,
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazyMedia: true,
    lazySlides: true,
    renderMode: 'list',
    listOptions: { windowed: true },
  });
  if (!viewer.slideCount) {
    viewer.destroy();
    throw new Error('Presentation package contains no slides');
  }
  window.addEventListener('pagehide', () => viewer.destroy(), { once: true });
});
