import { Injectable } from '@nestjs/common';
import { BBox, Finding, ShadowDraft } from './contracts';

/**
 * CORRECTION APPLIER. Applies the already-detected corrections to the framework's DERIVED draft set
 * (it never touches the engine or live persistence — those are frozen). Four operations:
 *   1. Explanation Trim — shrink a crop's bottom to the explanation onset (keep Question + Options).
 *   2. Split Merge — absorb an orphan option region into its stem (one crop).
 *   3. Cross-page Merge — absorb a next-page continuation into its stem (one logical question).
 *   4. Boundary application — the surviving crops ARE Question+Options only.
 *
 * Safety: a trim is applied only when the explanation is the LOWER portion of the crop (the kept
 * Question+Options is ≥ half the height) — never an aggressive trim. Merges only act on the
 * gate-passed findings the detectors produced. No values, no PDF-specific logic.
 */
/** Per-surviving-draft provenance — the basis for the production bridge object. */
export interface CorrectionProvenance {
  draftIndex: number;
  mergedRegions: BBox[]; // constituent regions (split/cross-page); [self] when not merged
  sourcePages: number[]; // pages the logical question spans (>1 only for cross-page)
  trimmedToY: number | null; // explanation trim boundary, or null
}

export interface AppliedResult {
  drafts: ShadowDraft[];
  explanationTrims: number;
  splitMerges: number;
  crossPageMerges: number;
  /** draftIndex → the y the crop was trimmed to (so leakage can be re-measured on the kept region). */
  trimmedTo: Map<number, number>;
  /** per-surviving-draft provenance (merged regions / source pages / trim boundary). */
  provenance: Map<number, CorrectionProvenance>;
  /** draft indices where an explanation trim was DECLINED by the anti-aggressive guard — these must
   *  be routed to review (no silent leakage), not auto-trimmed. */
  skippedExplanationTrims: number[];
}

const union = (a: BBox, b: BBox): BBox => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const xOverlap = (a: BBox, b: BBox): boolean => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
/** `inner` sits within `span` (a few px tolerance) and shares its column band. */
const within = (span: BBox, inner: BBox): boolean =>
  inner.y0 >= span.y0 - 4 && inner.y1 <= span.y1 + 4 && xOverlap(span, inner);

@Injectable()
export class CorrectionApplier {
  apply(
    corrected: ReadonlyArray<ShadowDraft>,
    explanationFindings: ReadonlyArray<Finding>,
    splitAssociable: ReadonlyArray<Finding>,
    crossPageFindings: ReadonlyArray<Finding>,
  ): AppliedResult {
    const work = corrected.map((d) => ({ ...d, coords: d.coords ? { ...d.coords } : undefined }));
    const byIdx = new Map(work.map((d) => [d.index, d]));
    // provenance starts as single-region per draft; merges/trims update it
    const prov = new Map<number, CorrectionProvenance>(
      work.map((d) => [d.index, { draftIndex: d.index, mergedRegions: d.coords ? [{ ...d.coords }] : [], sourcePages: [d.page], trimmedToY: null }]),
    );
    // TRANSITIVE assembly: an absorbed region redirects to its group ROOT, so a chain
    // (stem ← continuation ← options across pages) collapses into ONE crop — not a broken pairwise
    // merge that drops the tail. `resolve` follows the redirect chain to the surviving root.
    const redirect = new Map<number, number>();
    const resolve = (i: number): number => { let r = i; const seen = new Set<number>(); while (redirect.has(r) && !seen.has(r)) { seen.add(r); r = redirect.get(r)!; } return r; };
    const absorb = (rootIdx: number, childIdx: number, crossPage: boolean): boolean => {
      const root = byIdx.get(resolve(rootIdx));
      const child = byIdx.get(childIdx);
      if (!root || !child || root === child || !root.coords || !child.coords) return false;
      root.coords = union(root.coords, child.coords);
      const rp = prov.get(root.index)!;
      rp.mergedRegions.push({ ...child.coords });
      if (crossPage && !rp.sourcePages.includes(child.page)) rp.sourcePages.push(child.page);
      byIdx.delete(childIdx);
      prov.delete(childIdx);
      redirect.set(childIdx, root.index);
      return true;
    };

    // 2 — SPLIT FLATTEN: union an option-only orphan into its INCOMPLETE candidate stem (transitively).
    // STOP RULE: never flatten across another VALID QUESTION — if any other marker-bearing region lies
    // inside the stem→orphan span, this is not a tight column/row split (it would swallow a real
    // question, as happened on RE NEET) ⇒ refuse and leave it for review. Never a false merge.
    let splitMerges = 0;
    for (const f of splitAssociable) {
      const stemIdx = (f.evidence as { candidateStem?: number | null }).candidateStem;
      const orphanIdx = (f.evidence as { orphanDraft?: number }).orphanDraft;
      if (stemIdx == null || orphanIdx == null) continue;
      const stemD = byIdx.get(resolve(stemIdx));
      const orphanD = byIdx.get(orphanIdx);
      if (!stemD || !orphanD || !stemD.coords || !orphanD.coords) continue;
      const span = union(stemD.coords, orphanD.coords);
      const crossesQuestion = [...byIdx.values()].some(
        (m) => m !== stemD && m !== orphanD && m.coords && m.questionNumber != null && within(span, m.coords),
      );
      if (crossesQuestion) continue; // STOP — a valid question is inside the span; route to review
      if (absorb(stemIdx, orphanIdx, false)) splitMerges += 1;
    }

    // 3 — CROSS-PAGE MERGE: absorb the next-page continuation into its stem (transitively → one
    // logical question even across 3+ pages: stem ← cont(N+1) ← options(N+2) all reach the root)
    let crossPageMerges = 0;
    for (const f of crossPageFindings) {
      const contIdx = (f.evidence as { toDraft?: number }).toDraft;
      const stemIdx = (f.evidence as { fromDraft?: number }).fromDraft;
      if (contIdx == null || stemIdx == null) continue;
      if (absorb(stemIdx, contIdx, true)) crossPageMerges += 1;
    }

    // 2.5 — INTERPOSED CONTENT ABSORPTION: any region that sits WITHIN an assembled question's
    // stem→options span and does NOT itself begin a new question (structural: it carries no question
    // marker) is part of that logical question — a diagram / table / image / passage between the stem
    // and its options. Absorb it so the question is ONE crop, not a crop + an orphan figure crop.
    // Marker-bearing regions (a real next question) are NEVER absorbed → no question is ever swallowed.
    let absorbedInterposed = 0;
    for (const root of [...byIdx.values()]) {
      if (!byIdx.has(root.index) || !root.coords) continue; // may have been absorbed by an earlier root
      const rp = prov.get(root.index);
      if (!rp || rp.mergedRegions.length < 2) continue; // only assembled (merged) questions have a span
      for (const other of [...byIdx.values()]) {
        if (other === root || !byIdx.has(other.index) || !other.coords) continue;
        if (other.questionNumber != null) continue; // carries a marker ⇒ a new question ⇒ never absorb
        if (other.page !== root.page && !rp.sourcePages.includes(other.page)) continue;
        if (within(root.coords, other.coords)) { if (absorb(root.index, other.index, other.page !== root.page)) absorbedInterposed += 1; }
      }
    }

    // 1 — EXPLANATION TRIM: stop the crop at the explanation onset (anti-aggressive guard)
    let explanationTrims = 0;
    const trimmedTo = new Map<number, number>();
    const skippedExplanationTrims: number[] = [];
    for (const f of explanationFindings) {
      const idx0 = f.target.draftIndex;
      if (idx0 == null) continue;
      const idx = resolve(idx0); // a trailing solution on an absorbed region trims the assembled root
      const d = byIdx.get(idx);
      if (!d || !d.coords) continue;
      const trimToY = (f.evidence as { trimToY?: number }).trimToY;
      if (typeof trimToY !== 'number' || trimToY >= d.coords.y1) continue;
      // Anti-aggressive guard — STRUCTURAL, not a height ratio. The explanation detector guarantees
      // the onset (trimToY) sits BELOW a verified-complete option block (completeAtY = bottom of the
      // last option line). A trim is safe iff it preserves that whole option block — i.e. the cut is
      // at/below completeAtY. We skip ONLY when the boundary is missing or the cut would bite into the
      // options; never merely because the solution block is taller than the Question+Options. Skips ⇒
      // review, never silent.
      const completeAtY = (f.evidence as { completeAtY?: number }).completeAtY;
      if (typeof completeAtY !== 'number' || trimToY < completeAtY) { skippedExplanationTrims.push(idx); continue; }
      d.coords = { ...d.coords, y1: Math.round(trimToY) };
      trimmedTo.set(idx, Math.round(trimToY));
      const p = prov.get(idx); if (p) p.trimmedToY = Math.round(trimToY);
      explanationTrims += 1;
    }

    // prune provenance to survivors only
    const survivors = new Set(byIdx.keys());
    for (const k of [...prov.keys()]) if (!survivors.has(k)) prov.delete(k);
    return { drafts: [...byIdx.values()], explanationTrims, splitMerges, crossPageMerges, trimmedTo, provenance: prov, skippedExplanationTrims };
  }
}
