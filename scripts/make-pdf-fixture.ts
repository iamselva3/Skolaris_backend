/*
 * Generates a multi-page question-paper PDF fixture from ii.jpg for OCR
 * pipeline testing. Page 1 + page 2 both embed the same biology MCQ image
 * so the parser produces 8 drafts (4 per page) — verifies that PDF
 * rasterization → page-by-page OCR → cross-page draft ordering works.
 *
 * Run: ts-node scripts/make-pdf-fixture.ts <input-jpg> <output-pdf> [pages]
 */
import { createWriteStream } from 'fs';
import PDFDocument from 'pdfkit';

const [, , inputArg, outputArg, pagesArg] = process.argv;
const input = inputArg ?? 'C:\\Users\\hp\\Downloads\\ii.jpg';
const output = outputArg ?? 'C:\\Users\\hp\\Downloads\\ii-multipage.pdf';
const pageCount = Number(pagesArg ?? 2);

const doc = new PDFDocument({ autoFirstPage: false });
const stream = createWriteStream(output);
doc.pipe(stream);

for (let i = 0; i < pageCount; i++) {
  doc.addPage({ size: 'A4', margin: 0 });
  // Fit the image to the page (A4 = 595x842pt) preserving aspect ratio.
  doc.image(input, 0, 0, { fit: [595, 842], align: 'center', valign: 'center' });
}

doc.end();

stream.on('finish', () => {
  // eslint-disable-next-line no-console
  console.log(`Wrote ${pageCount}-page PDF: ${output}`);
});
