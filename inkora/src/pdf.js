// Hidden helper page: renders PDF pages to images so they can be used as board pages.
import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

const asset = (p) => new URL(`../node_modules/pdfjs-dist/${p}`, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = asset('build/pdf.worker.min.mjs');

window.annotator.onRequest(async (name, arg) => {
  if (name !== 'render-pdf') return null;
  // No scripting or eval: a PDF is untrusted input.
  const task = pdfjs.getDocument({
    data: arg.data,
    isEvalSupported: false,
    enableScripting: false,
    // Bundled fonts and character maps, so PDFs in any script (Arabic, CJK...) render offline.
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    iccUrl: asset('iccs/'),
    wasmUrl: asset('wasm/'),
  });
  const doc = await task.promise;
  const pages = [];
  const count = Math.min(doc.numPages, arg.maxPages);
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const unit = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(arg.width / unit.width, arg.height / unit.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    pages.push({ src: canvas.toDataURL('image/jpeg', 0.9), w: canvas.width, h: canvas.height });
    page.cleanup();
  }
  const total = doc.numPages;
  await task.destroy();
  return { pages, total };
});
window.annotator.ready();
