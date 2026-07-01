import { isPdfBytes } from './ocr-engine';

/**
 * Proves the PDF detector that both the OCR ROUTING (extractDrafts) and the HARD GUARD
 * (runOcr, before Tesseract.recognize) rely on. A real PDF starts with the "%PDF-" magic;
 * content-types lie (S3/MinIO/fake-gcs return application/octet-stream), so magic bytes are
 * the authoritative signal that a buffer must be rasterised before OCR — never OCR'd raw.
 */
describe('isPdfBytes — the OCR PDF guard', () => {
  it('detects a PDF by its %PDF- magic signature (even with a non-pdf content-type)', () => {
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj', 'latin1');
    expect(isPdfBytes(pdf)).toBe(true);
  });

  it('does NOT flag a PNG image buffer', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(isPdfBytes(png)).toBe(false);
  });

  it('does NOT flag a JPEG image buffer', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(isPdfBytes(jpeg)).toBe(false);
  });

  it('does NOT flag a tiny / empty buffer', () => {
    expect(isPdfBytes(Buffer.alloc(0))).toBe(false);
    expect(isPdfBytes(Buffer.from('%PD'))).toBe(false); // shorter than the signature
  });

  it('flags a PDF whose magic is exactly at the start, not mid-buffer', () => {
    expect(isPdfBytes(Buffer.from('garbage %PDF-1.4'))).toBe(false); // not at offset 0 → not a PDF stream
  });
});
