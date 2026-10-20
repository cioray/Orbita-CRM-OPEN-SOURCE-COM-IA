import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { AppError } from './util.js';

export async function docxText(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) { reject(new AppError('invalid_docx')); return; }
      const sections: { name: string; text: string }[] = [];
      let total = 0;
      let finished = false;
      const fail = () => { if (!finished) { finished = true; archive.close(); reject(new AppError('invalid_docx_content')); } };
      archive.on('error', fail);
      archive.on('entry', entry => {
        if (!/^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(entry.fileName)) { archive.readEntry(); return; }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          let text = '';
          let insideText = false;
          const parser = new SaxesParser({ xmlns: true });
          parser.on('doctype', () => { fail(); stream.destroy(); });
          parser.on('error', () => { fail(); stream.destroy(); });
          parser.on('opentag', tag => {
            if (tag.local === 't') insideText = true;
            if (tag.local === 'tab') text += '\t';
            if (tag.local === 'br') text += '\n';
          });
          parser.on('text', content => { if (insideText) text += content; });
          parser.on('closetag', tag => {
            if (tag.local === 't') insideText = false;
            if (tag.local === 'p' || tag.local === 'tr') text += '\n';
            if (tag.local === 'tc') text += '\t';
          });
          stream.setEncoding('utf8');
          stream.on('data', chunk => {
            total += Buffer.byteLength(chunk);
            if (total > 20 * 1024 * 1024 || text.length > 500000) { fail(); stream.destroy(); return; }
            try { parser.write(String(chunk)); } catch { fail(); stream.destroy(); }
          });
          stream.on('error', fail);
          stream.on('end', () => {
            if (finished) return;
            try { parser.close(); } catch { fail(); return; }
            sections.push({ name: entry.fileName, text });
            archive.readEntry();
          });
        });
      });
      archive.on('end', () => {
        if (finished) return;
        finished = true;
        if (!sections.some(section => section.name === 'word/document.xml')) { reject(new AppError('docx_document_missing')); return; }
        sections.sort((first, second) => first.name === 'word/document.xml' ? -1 : second.name === 'word/document.xml' ? 1 : first.name.localeCompare(second.name));
        resolve(sections.map(section => `[${section.name}]\n${section.text}`).join('\n'));
      });
      archive.readEntry();
    });
  });
}
