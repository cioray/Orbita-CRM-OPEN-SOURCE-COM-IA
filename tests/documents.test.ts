import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { audioFormat, DOCUMENT_MAX_BYTES, extractDocument, validateDocument, validateDocxArchive } from '../src/documents.js';

describe('media input boundaries', () => {
  it('rejects documents above 20 MiB', () => {
    expect(() => validateDocument(Buffer.alloc(DOCUMENT_MAX_BYTES + 1), 'large.pdf')).toThrow('document_too_large');
  });
  it('checks content signatures, not only filenames', () => {
    expect(validateDocument(Buffer.from('%PDF-1.7\n'), 'example.pdf')).toBe('pdf');
    expect(() => validateDocument(Buffer.from('MZnotapdf'), 'example.pdf')).toThrow('unsupported_or_mismatched_document');
    expect(() => validateDocument(Buffer.from('%PDF-1.7\n'), 'program.exe')).toThrow();
  });
  it('recognizes WhatsApp audio and rejects arbitrary bytes', () => {
    expect(audioFormat(Buffer.from('OggSdata'))).toBe('ogg');
    expect(() => audioFormat(Buffer.from('executable'))).toThrow('unsupported_audio_format');
  });
  it('rejects a generic ZIP masquerading as a DOCX', async () => {
    const zip = new JSZip();
    zip.file('random.txt', 'not Word');
    await expect(validateDocxArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('invalid_docx');
  });
  it('rejects macro content', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<document/>');
    zip.file('word/vbaProject.bin', 'macro');
    await expect(validateDocxArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('unsafe_docx');
  });
  it('extracts text from a valid DOCX in an isolated worker', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Curso para barbeiros R$ 300,00</w:t></w:r></w:p></w:body></w:document>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    expect(validateDocument(buffer, 'course.docx')).toBe('docx');
    expect(await extractDocument(buffer, 'docx')).toContain('Curso para barbeiros R$ 300,00');
  });
});
