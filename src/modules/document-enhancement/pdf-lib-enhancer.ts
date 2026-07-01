/*
 * DOCUMENT ENHANCEMENT — Phase 2 PRIMARY package: pdf-lib safe structural removal.
 *
 * Pure functions. The ONLY mutation pdf-lib performs is removing DECORATIVE
 * ANNOTATION objects (Watermark / Stamp) from each page's /Annots array. That is
 * lossless and OBJECT-LEVEL:
 *   • annotations are overlays, NOT part of the page content stream;
 *   • pdf-lib copies every content stream through VERBATIM on save, so question
 *     numbers / text / options / diagrams / tables / chemical structures /
 *     match-connectors are byte-for-byte untouched.
 *
 * Everything that would need a content-stream edit, a rasterize, or a semantic
 * decision is DECLINED (kept) and flows to the caller's fallback, per the Golden
 * Rule: if uncertain, KEEP THE PIXELS.
 *
 *   - OCG (optional content groups): hiding a layer means editing the BDC/EMC
 *     marked-content inside the content stream ⇒ FORBIDDEN ⇒ DECLINE.
 *   - repeated decorative XObjects: removing the `Do` invocation is a
 *     content-stream edit, and neutralising the object risks blanking real
 *     content ⇒ DECLINE.
 *
 * NEVER: edit content streams, rasterize, flatten, convert PDF→image→PDF, or
 * remove anything but the two unambiguous decorative annotation subtypes.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';

/** The only annotation subtypes we treat as unambiguous decoration. Everything else is KEPT. */
const DECORATIVE_ANNOTATION_SUBTYPES = new Set(['Watermark', 'Stamp']);

export type CandidateKind = 'annotation' | 'ocg' | 'repeated-object';

export interface Candidate {
  kind: CandidateKind;
  subtype?: string;
  page?: number;
  reason: string;
}

export interface EnhanceResult {
  removed: Candidate[];
  declined: Candidate[];
  /** New PDF bytes — present ONLY when removed.length > 0. Null on a safe no-op. */
  pdf: Buffer | null;
  /** True if pdf-lib could not even load/process the document (caller may try the fallback). */
  errored: boolean;
  errorMessage?: string;
}

const subtypeOf = (dict: PDFDict): string => {
  const sub = dict.get(PDFName.of('Subtype'));
  if (!sub) return '';
  // PDFName stringifies as '/Watermark' — strip the leading slash.
  return String(sub).replace(/^\//, '');
};

export interface EnhanceHints {
  /** From the profiler: repeated XObject count (decline → keep). */
  repeatedXObjects?: number;
  /** From the profiler: OCG layer count (decline → keep). */
  ocgLayers?: number;
}

/**
 * Run pdf-lib safe removal on the ORIGINAL bytes. Returns {removed, declined, pdf}.
 * `pdf` is non-null only when at least one decorative annotation was removed.
 */
export const enhanceWithPdfLib = async (
  bytes: Buffer,
  hints: EnhanceHints = {},
): Promise<EnhanceResult> => {
  const removed: Candidate[] = [];
  const declined: Candidate[] = [];

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    return {
      removed: [],
      declined: [],
      pdf: null,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const pages = doc.getPages();
    for (let p = 0; p < pages.length; p += 1) {
      const node = pages[p].node;
      const annots = node.Annots();
      if (!(annots instanceof PDFArray)) continue;
      // Walk high→low so removals don't shift the indices we still need to visit.
      for (let j = annots.size() - 1; j >= 0; j -= 1) {
        let dict: unknown;
        try {
          dict = doc.context.lookup(annots.get(j));
        } catch {
          continue; // unresolvable entry ⇒ leave it (keep)
        }
        if (!(dict instanceof PDFDict)) continue;
        const subtype = subtypeOf(dict);
        if (DECORATIVE_ANNOTATION_SUBTYPES.has(subtype)) {
          annots.remove(j); // detaches the overlay; content stream untouched
          removed.push({
            kind: 'annotation',
            subtype,
            page: p + 1,
            reason: `decorative ${subtype} annotation removed (overlay, not page content)`,
          });
        } else if (subtype) {
          declined.push({
            kind: 'annotation',
            subtype,
            page: p + 1,
            reason: `non-decorative ${subtype} annotation kept`,
          });
        }
      }
    }

    // OCG present? Declining — removal would require a content-stream edit.
    let hasOcProperties = false;
    try {
      hasOcProperties = !!doc.catalog.get(PDFName.of('OCProperties'));
    } catch {
      hasOcProperties = false;
    }
    if (hasOcProperties || (hints.ocgLayers ?? 0) > 0) {
      declined.push({
        kind: 'ocg',
        reason: 'OCG layer present — safe removal needs a content-stream edit ⇒ KEEP PIXELS',
      });
    }

    if ((hints.repeatedXObjects ?? 0) > 0) {
      declined.push({
        kind: 'repeated-object',
        reason: `${hints.repeatedXObjects} repeated object(s) — removal needs a content-stream edit ⇒ KEEP PIXELS`,
      });
    }

    if (removed.length === 0) {
      // Nothing safely removable. Safe no-op — original is left for the caller.
      return { removed, declined, pdf: null, errored: false };
    }

    const out = Buffer.from(await doc.save({ useObjectStreams: false }));
    return { removed, declined, pdf: out, errored: false };
  } catch (err) {
    // Any mid-process failure ⇒ produce NO output (caller keeps the original).
    return {
      removed: [],
      declined,
      pdf: null,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
};
