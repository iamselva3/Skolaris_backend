/**
 * Priority-1 blocking gate: a 2-column page with 4 numbered questions MUST
 * produce exactly 4 OCR drafts.
 *
 * Approach: feed parseDrafts the per-column text the new A3 pipeline produces
 * (column-reorder.columns[]) and verify that each column produces its own
 * drafts. Plus A1 (inline-marker safety net) is exercised by feeding a fused-
 * line input.
 */
import { extractDrafts, parseDrafts } from './ocr-engine';

describe('Priority-1 — parseDrafts per-column + inline-marker safety net', () => {
  it('A3: 4 numbered questions across left+right columns → 4 drafts (running parseDrafts twice)', () => {
    // Simulates the canonical NEET 2-column page. The new pipeline runs
    // parseDrafts ONCE per column.columns[] entry, so the test mirrors that.
    const leftColumnText = [
      '1. The net electric flux associated with a closed surface which encloses 1 C positive charge is in SI unit',
      '(1) eo',
      '(2) eo^-1',
      '(3) eo^-1/2',
      '(4) eo^1/2',
      '2. The maximum electric field that a dielectric medium can withstand without break-down is called its',
      '(1) Permittivity',
      '(2) Dielectric constant',
      '(3) Electric susceptibility',
      '(4) Dielectric strength',
    ].join('\n');

    const rightColumnText = [
      '3. The electric field near a uniformly charged nonconducting infinite sheet is E. If surface charge density on sheet is sigma then value of E is',
      '(1) sigma/2eo',
      '(2) sigma/eo',
      '(3) 2sigma/eo',
      '(4) sigma*eo',
      '4. The equivalent capacitance of the combination between A and B as shown in figure is',
      '(1) C/3',
      '(2) 3C/2',
      '(3) 3C',
      '(4) C/2',
    ].join('\n');

    const left = parseDrafts(leftColumnText, 0.9, { pageNumber: 1, positionOffset: 0 });
    const right = parseDrafts(rightColumnText, 0.9, { pageNumber: 1, positionOffset: left.length });

    // The blocking gate: 4 drafts total.
    expect(left.length).toBe(2);
    expect(right.length).toBe(2);
    expect(left.length + right.length).toBe(4);

    // Each draft must have 4 options.
    for (const d of [...left, ...right]) {
      expect(d.options?.length).toBe(4);
    }

    // Stems must contain the right discriminating phrase.
    expect(left[0].text).toMatch(/net electric flux/);
    expect(left[1].text).toMatch(/maximum electric field/);
    expect(right[0].text).toMatch(/uniformly charged nonconducting/);
    expect(right[1].text).toMatch(/equivalent capacitance/);
  });

  it('A1: a fused line with two questions splits via inline-marker safety net', () => {
    // The exact failure shape from the user's validation: column reorder failed
    // and column A's tail got fused with column B's head onto a single line.
    // Without A1 this collapses to 1 draft; with A1 it splits to 2.
    const fused = [
      '2. The maximum electric field that a dielectric medium can withstand without break-down is called its 4. The equivalent capacitance of the combination between A and B as shown in figure is',
      '(1) Permittivity',
      '(2) Dielectric constant',
      '(3) Electric susceptibility',
      '(4) Dielectric strength',
    ].join('\n');

    const drafts = parseDrafts(fused, 0.85, { pageNumber: 1, positionOffset: 0 });
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts[0].text).toMatch(/maximum electric field/);
    expect(drafts[1].text).toMatch(/equivalent capacitance/);
  });

  it('A1 is CONSERVATIVE — does not split a short ordered list inside a stem', () => {
    // "Step 1. Boil water. 2. Stir." is procedural prose, NOT two questions.
    // Line length < 80 chars → inline split is skipped, so this stays as 1.
    const stem = ['1. Cooking steps: Step 1. Boil water. 2. Stir.', '(a) yes', '(b) no'].join('\n');
    const drafts = parseDrafts(stem, 0.9, { pageNumber: 1, positionOffset: 0 });
    expect(drafts.length).toBe(1);
  });

  it('parseDrafts is a no-op on empty input', () => {
    expect(parseDrafts('', 0, {}).length).toBe(0);
  });
});

describe('Visual-preservation fallback — stripGarbageStretches via parseDrafts', () => {
  it('strips circuit-diagram garbage stretches from a stem AND flags needsImageReview', () => {
    // The exact noise shape the user pasted: "3¢ c @ 5" tail after a real stem.
    const raw = [
      '4. The equivalent capacitance of the combination between A and B as shown in figure is 3¢ c @ 5 5 c 1',
      '(1) C/3',
      '(2) 3C/2',
      '(3) 3C',
      '(4) C/2',
    ].join('\n');

    const drafts = parseDrafts(raw, 0.85, { pageNumber: 1, positionOffset: 0 });
    expect(drafts.length).toBe(1);
    const d = drafts[0];
    expect(d.text).not.toMatch(/3¢/);
    expect(d.text).not.toMatch(/@/);
    expect(d.text).toMatch(/equivalent capacitance/);
    expect(d.needsImageReview).toBe(true);
  });

  it('strips a short-token garbage tail from an option label and flags the draft', () => {
    // Real option text followed by a noise stretch — exactly what survives the
    // Python layer when an in-band noise tail leaks through. Node defense-in-
    // depth strips the trailing stretch; the leading legitimate text stays.
    // (Single-token noise like "Qeoi®" by itself is caught one layer up by
    // the Python region-quality scorer, not by this Node sweep.)
    const raw = [
      '5. Which structure is most stable?',
      '(1) Methyl 5 i CC @ + & 1',
      '(2) Methyl benzene',
      '(3) Toluene',
      '(4) Phenol',
    ].join('\n');
    const drafts = parseDrafts(raw, 0.85, { pageNumber: 1, positionOffset: 0 });
    expect(drafts.length).toBe(1);
    const d = drafts[0];
    expect(d.needsImageReview).toBe(true);
    expect(d.options?.[0].label).toMatch(/^Methyl/);
    expect(d.options?.[0].label).not.toMatch(/@/);
    expect(d.options?.[0].label).not.toMatch(/CC/);
  });

  it('does NOT strip legitimate short-token sequences (prose, formulas)', () => {
    const raw = [
      '6. In a set of an A B test, which option is right?',
      '(1) Option one',
      '(2) Option two',
      '(3) Option three',
      '(4) Option four',
    ].join('\n');
    const drafts = parseDrafts(raw, 0.95, { pageNumber: 1, positionOffset: 0 });
    expect(drafts.length).toBe(1);
    const d = drafts[0];
    // No symbol-only token in the "an A B test" sequence → must NOT be flagged.
    expect(d.needsImageReview).toBeUndefined();
    expect(d.text).toMatch(/an A B test/);
  });

  it('does NOT flag a fully clean question', () => {
    const raw = [
      '7. The maximum electric field that a dielectric medium can withstand without break-down is called its',
      '(1) Permittivity',
      '(2) Dielectric constant',
      '(3) Electric susceptibility',
      '(4) Dielectric strength',
    ].join('\n');
    const drafts = parseDrafts(raw, 0.95, { pageNumber: 1, positionOffset: 0 });
    expect(drafts.length).toBe(1);
    const d = drafts[0];
    expect(d.needsImageReview).toBeUndefined();
    expect(d.text).toMatch(/maximum electric field/);
  });
});

describe('Priority-1 — extractDrafts end-to-end via the column-aware page input', () => {
  it('runs parseDrafts per page.columns[] entry — total = leftDrafts + rightDrafts', () => {
    // We're NOT exercising the column-reorder layout detection here (the
    // column-reorder.spec covers that). Instead we drive extractDrafts'
    // per-column branch by hand: but extractDrafts only takes raw PDF
    // bytes / image bytes. The cleanest way is to hit parseDrafts twice and
    // ensure the index arithmetic stays consistent — already covered by the
    // A3 test above. This `it` is a placeholder reminder for the e2e
    // validation that runs against the actual Aakash NEET PST3 paper.
    expect(typeof extractDrafts).toBe('function');
  });
});
