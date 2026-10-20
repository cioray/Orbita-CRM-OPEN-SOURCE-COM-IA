import { parentPort, workerData } from 'node:worker_threads';
const buffer = Buffer.from(workerData.buffer);
try {
  let text = '';
  if (workerData.type === 'docx') {
    const modulePath = import.meta.url.endsWith('.ts') ? './docx.ts' : './docx.js';
    const { docxText } = await import(modulePath);
    text = await docxText(buffer);
  }
  else {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, stopAtErrors: true });
    const document = await loading.promise;
    if (document.numPages > 500) throw new Error('page_limit');
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        text += `\n[page ${pageNumber}]\n${content.items.map(item => 'str' in item ? item.str : '').join(' ')}\n`;
        if (text.length > 500000) throw new Error('text_limit');
        page.cleanup();
      }
    } finally { await loading.destroy(); }
  }
  if (text.length > 500000) throw new Error('text_limit');
  parentPort?.postMessage({ text });
} catch { parentPort?.postMessage({ error: 'document_parse_error' }); }
