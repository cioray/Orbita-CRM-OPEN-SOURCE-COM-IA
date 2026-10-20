import { Worker } from 'node:worker_threads';
import yauzl from 'yauzl';
import { AppError } from './util.js';
import { docxText } from './docx.js';

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export function validateDocument(buffer: Buffer, filename: string): 'pdf' | 'docx' {
  if (buffer.length > DOCUMENT_MAX_BYTES) throw new AppError('document_too_large', 413);
  if (buffer.length < 5) throw new AppError('invalid_document', 415);
  const extension = filename.toLowerCase().split('.').at(-1);
  if (extension === 'pdf' && buffer.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (extension === 'docx' && buffer.readUInt32LE(0) === 0x04034b50) return 'docx';
  throw new AppError('unsupported_or_mismatched_document', 415);
}
export async function validateDocxArchive(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) { reject(new AppError('invalid_docx', 415)); return; }
      let totalBytes = 0;
      let entries = 0;
      let hasDocument = false;
      let finished = false;
      const fail = () => { if (!finished) { finished = true; archive.close(); reject(new AppError('unsafe_docx', 415)); } };
      archive.on('error', fail);
      archive.on('entry', entry => {
        totalBytes += entry.uncompressedSize;
        entries++;
        if (totalBytes > 80 * 1024 * 1024 || entry.uncompressedSize > 20 * 1024 * 1024 || entries > 4000 || /vbaProject|\.\.|^[/\\]/i.test(entry.fileName) || (entry.generalPurposeBitFlag & 1) !== 0) { fail(); return; }
        if (entry.fileName === 'word/document.xml') hasDocument = true;
        archive.readEntry();
      });
      archive.on('end', () => {
        if (finished) return;
        finished = true;
        if (!hasDocument) reject(new AppError('invalid_docx', 415));
        else resolve();
      });
      archive.readEntry();
    });
  });
}
export async function extractDocument(buffer: Buffer, type: 'pdf' | 'docx'): Promise<string> {
  if (type === 'docx') await validateDocxArchive(buffer);
  if (type === 'docx') return docxText(buffer);
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./document-worker.${extension}`, import.meta.url), { workerData: { buffer, type }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new AppError('document_parser_timeout', 422)); }, 30000);
    worker.once('message', (result: { text?: string; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (typeof result.text === 'string') resolve(result.text);
      else reject(new AppError('document_extraction_failed', 422));
    });
    worker.once('error', () => { clearTimeout(timer); reject(new AppError('document_parser_failed', 422)); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new AppError('document_parser_terminated', 422)); });
  });
}
export function audioFormat(buffer: Buffer): string {
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (buffer.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'm4a';
  if (buffer.length > 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  throw new AppError('unsupported_audio_format', 415);
}
