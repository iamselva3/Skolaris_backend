import {
  buildQualityReport,
  buildRegions,
  classifyBlock,
  countOptionMarkers,
  detectColumns,
  detectQuestionPunct,
  findQuestionMarkers,
  hasStem,
  isCompleteBlock,
  medianHeight,
  mergeIncompleteRegions,
  recoverCenturyMisreads,
  recoverSequenceGaps,
  recoverTruncatedNumbers,
  splitRegionsByInternalMarkers,
  validateMarkerSequence,
} from './visual-segment';
import type { Column, Region } from './visual-segment';
import type { OcrWordBox } from './column-reorder';

const w = (text: string, x0: number, y0: number, h = 30, len = 20): OcrWordBox => ({
  text,
  x0,
  y0,
  x1: x0 + len,
  y1: y0 + h,
});

describe('visual-segment', () => {
  describe('medianHeight', () => {
    it('returns the median word height', () => {
      expect(medianHeight([w('a', 0, 0, 20), w('b', 0, 50, 30), w('c', 0, 100, 40)])).toBe(30);
    });
    it('falls back to 20 when empty', () => {
      expect(medianHeight([])).toBe(20);
    });
  });

  describe('findQuestionMarkers', () => {
    it('keeps ) / Q / Question markers and drops . / letter / paren options', () => {
      const markers = findQuestionMarkers(
        [
          w('1)', 50, 100), // question
          w('1.', 50, 160), // option — dropped
          w('A.', 50, 200), // option — dropped
          w('(a)', 50, 240), // option — dropped
          w('2)', 50, 400), // question
          w('Q3', 50, 600), // question (Q-prefix)
        ],
        30,
      );
      expect(markers.map((m) => m.y0)).toEqual([100, 400, 600]);
    });

    it('auto-detects "N." question style (NEET): "." numbers are questions, "(1)" are options', () => {
      // Questions "1." "2." "3." "4." at the far-left margin; options "(1)".."(4)"
      // indented. The "." family has 4 distinct values, ")" has 0 → questions = ".".
      const words = [
        w('1.', 40, 100),
        w('Question', 90, 100, 30, 90),
        w('(1)', 120, 150),
        w('(2)', 260, 150),
        w('2.', 40, 300),
        w('3.', 40, 500),
        w('4.', 40, 700),
      ];
      const markers = findQuestionMarkers(words, 30);
      expect(markers.map((m) => m.y0)).toEqual([100, 300, 500, 700]);
    });

    it('accepts a question number whose period was OCR-corrupted to ";" or "," (43; / 44,)', () => {
      // Real RE NEET cases: "43." read as "43;" (page 7), "44." read as "44," (page 8).
      // Both must still be recognised as question markers (generalised punct recovery).
      const words = [
        w('41.', 622, 100),
        w('42.', 622, 300),
        w('43;', 622, 500),
        w('44,', 622, 700),
      ];
      expect(findQuestionMarkers(words, 30).map((m) => m.num)).toEqual([41, 42, 43, 44]);
    });

    it('the ";"/"," terminator does NOT promote a thousands number ("1,000") to a marker', () => {
      // Decimal/thousands guard keeps a line-start "1,000" out of the marker set.
      const nums = findQuestionMarkers([w('1,000', 50, 100, 60, 14), w('2.', 50, 300)], 30).map(
        (m) => m.num,
      );
      expect(nums).not.toContain(1);
      expect(nums).toContain(2);
    });

    it('drops an out-of-range phantom number (in-text "273" misread as a marker)', () => {
      // Real page-13 case: an in-text "273" became a spurious mid-page marker/column.
      const words = [w('73.', 37, 100), w('273.', 250, 300), w('74.', 37, 500)];
      expect(findQuestionMarkers(words, 30).map((m) => m.num)).toEqual([73, 74]); // 273 dropped
    });

    it('Infinity ceiling keeps a high spike so recovery passes can correct it (270→170)', () => {
      // The recovery passes call findQuestionMarkers with no ceiling so they can SEE
      // and rewrite a correctable spike before the default ceiling drops a true phantom.
      const words = [w('73.', 37, 100), w('273.', 250, 300)];
      expect(
        findQuestionMarkers(words, 30, '.', Number.POSITIVE_INFINITY).map((m) => m.num),
      ).toContain(273);
    });

    it('rejects a "5)" sitting mid-line (not a line start)', () => {
      const markers = findQuestionMarkers(
        [
          w('Choose', 50, 100, 30, 80),
          w('option', 140, 100, 30, 80),
          w('5)', 230, 100), // mid-sentence — a word is immediately to its left
          w('2)', 50, 300), // real question start
        ],
        30,
      );
      expect(markers.map((m) => m.y0)).toEqual([300]);
    });

    it('detects a number GLUED to its question text ("104.Select") — the merge-failure fix', () => {
      const markers = findQuestionMarkers(
        [
          w('103.', 40, 100),
          w('Major', 90, 100, 30, 80),
          w('104.Select', 40, 400, 30, 110), // no space before text → still a marker
          w('correct', 160, 400, 30, 90),
        ],
        30,
      );
      expect(markers.map((m) => m.num)).toEqual([103, 104]);
      expect(markers.map((m) => m.y0)).toEqual([100, 400]);
    });

    it('does NOT treat a decimal ("1.5") as a question marker', () => {
      const markers = findQuestionMarkers([w('1.5', 40, 100, 30, 40), w('3.', 40, 300)], 30);
      expect(markers.map((m) => m.num)).toEqual([3]);
    });

    it('detects a marker glued to a letter mis-read as a digit ("108.0bserve" = Q108)', () => {
      // "Observe" OCR'd as "0bserve" → "108.0bserve" looked like the decimal
      // "108.0" to the old `(?!\d)` guard and was dropped (the real Q108 miss).
      const markers = findQuestionMarkers(
        [w('108.0bserve', 40, 100, 30, 110), w('109.The', 40, 400, 30, 80)],
        30,
      );
      expect(markers.map((m) => m.num)).toEqual([108, 109]);
    });

    it('detects a marker with leading OCR noise ("\\"103.Major" = Q103)', () => {
      // A stray quote prepended by OCR ("\"103.Major") hid the number from the
      // `^`-anchored regex → the real Q103 miss. Leading noise is now stripped.
      const markers = findQuestionMarkers(
        [w('"103.Major', 40, 100, 30, 90), w('104.Select', 40, 400, 30, 110)],
        30,
      );
      expect(markers.map((m) => m.num)).toEqual([103, 104]);
    });

    it('still rejects a true time/decimal even with letters absent ("12:30")', () => {
      const markers = findQuestionMarkers([w('12:30', 40, 100, 30, 40), w('5.', 40, 300)], 30);
      expect(markers.map((m) => m.num)).toEqual([5]);
    });

    it('rejects OPTION shapes "(1)" "(a)" "a)" as question starts', () => {
      const markers = findQuestionMarkers(
        [
          w('5.', 40, 100), // question
          w('(1)', 40, 200),
          w('(a)', 40, 260),
          w('a)', 40, 320),
          w('6.', 40, 500), // question
        ],
        30,
      );
      expect(markers.map((m) => m.num)).toEqual([5, 6]);
    });

    it('detects a glued, punctuation-less question marker ("150Match")', () => {
      const markers = findQuestionMarkers(
        [w('149.', 40, 100), w('150Match', 40, 400, 30, 120)],
        30,
      );
      expect(markers.map((m) => m.num)).toEqual([149, 150]);
    });
  });

  describe('validateMarkerSequence', () => {
    const col = (markers: Array<{ x0: number; y0: number; num?: number }>): Column => ({
      left: 40,
      right: 1000,
      markers,
    });

    it('keeps a monotonically increasing run and drops option/stray numbers', () => {
      const [out] = validateMarkerSequence([
        col([
          { x0: 40, y0: 100, num: 103 },
          { x0: 60, y0: 200, num: 1 }, // option number — not increasing
          { x0: 60, y0: 230, num: 2 },
          { x0: 60, y0: 260, num: 3 },
          { x0: 60, y0: 290, num: 4 },
          { x0: 40, y0: 400, num: 104 }, // next question
          { x0: 40, y0: 700, num: 105 },
        ]),
      ]);
      expect(out.markers.map((m) => m.num)).toEqual([103, 104, 105]);
    });

    it('always keeps number-less markers (a bare "Question" word)', () => {
      const [out] = validateMarkerSequence([
        col([
          { x0: 40, y0: 100, num: NaN },
          { x0: 40, y0: 300, num: NaN },
        ]),
      ]);
      expect(out.markers).toHaveLength(2);
    });
  });

  describe('splitRegionsByInternalMarkers (one question number per crop)', () => {
    it('splits a region that contains two question numbers (103 + 104)', () => {
      // A single geometric region covering both Q103 and Q104 (markers glued, so
      // the column splitter missed the boundary).
      const region: Region = { x0: 40, y0: 80, x1: 1000, y1: 1000 };
      const words = [
        w('103.', 40, 100),
        w('Major', 90, 100, 30, 80),
        w('(1)', 60, 200),
        w('(2)', 200, 200),
        w('104.Select', 40, 500, 30, 110),
        w('the', 170, 500, 30, 40),
        w('(1)', 60, 600),
        w('(2)', 200, 600),
      ];
      const out = splitRegionsByInternalMarkers([region], words, 30, '.', 12);
      expect(out).toHaveLength(2);
      expect(out[0].y0).toBe(80); // first piece keeps the parent top (number kept)
      expect(out[1].y0).toBe(488); // 500 - padTop(12) → 104's number stays inside
      expect(out[1].y1).toBe(1000);
    });

    it('leaves a single-question region untouched', () => {
      const region: Region = { x0: 40, y0: 80, x1: 1000, y1: 500 };
      const words = [
        w('103.', 40, 100),
        w('Major', 90, 100, 30, 80),
        w('(1)', 60, 200),
        w('(2)', 200, 200),
      ];
      expect(splitRegionsByInternalMarkers([region], words, 30, '.', 12)).toHaveLength(1);
    });
  });

  describe('recoverSequenceGaps (number-less / watermark-obscured next question)', () => {
    const region: Region = { x0: 40, y0: 80, x1: 1000, y1: 1000 };

    it('recovers a next question whose number lost its punctuation (bare "104")', () => {
      const words = [
        w('103.', 40, 100),
        w('Major', 90, 100, 30, 80),
        w('(1)', 60, 200),
        w('(2)', 200, 200),
        w('104', 40, 500), // bare number — no "." so the primary detector skips it
        w('Select', 90, 500, 30, 80),
      ];
      const out = recoverSequenceGaps([region], words, 30, '.', 12);
      expect(out).toHaveLength(2);
      expect(out[1].y0).toBe(488); // 500 - padTop(12) → 104's number preserved
    });

    it('does NOT promote an OPTION number into a question (low-number case)', () => {
      // Q3 with options whose parens OCR dropped to bare "4" — must NOT split:
      // expected next is 4, but a bare/option "4" is not a question number.
      const words = [
        w('3.', 40, 100),
        w('Which', 90, 100, 30, 80),
        w('(1)', 40, 300),
        w('(2)', 40, 380),
        w('(3)', 40, 460),
        w('4', 40, 540), // option 4 with parens stripped by OCR — still not a question
      ];
      expect(recoverSequenceGaps([region], words, 30, '.', 12)).toHaveLength(1);
    });

    it('does NOT split on an in-text number that is not the expected next question', () => {
      const words = [
        w('103.', 40, 100),
        w('Major', 90, 100, 30, 80),
        w('57', 40, 500), // a stray line-start integer, but 57 ≠ expected 104
        w('grams', 90, 500, 30, 70),
      ];
      expect(recoverSequenceGaps([region], words, 30, '.', 12)).toHaveLength(1);
    });

    it('ignores a candidate number sitting deep in the line (not at the left margin)', () => {
      const words = [
        w('103.', 40, 100),
        w('Major', 90, 100, 30, 80),
        w('104', 400, 500), // far from the column left edge → in-text, not a marker
      ];
      expect(recoverSequenceGaps([region], words, 30, '.', 12)).toHaveLength(1);
    });
  });

  describe('recoverTruncatedNumbers', () => {
    it('rewrites an OCR-truncated number ("1." → "111.") inside a single-number gap', () => {
      // Right column: 110 … (111 mis-read as "1.") … 112. The stray "1." hugs the
      // column's left margin between 110 and 112, and "1" is a suffix of "111".
      const words = [
        w('110.How', 622, 100, 30, 80),
        w('1.', 622, 300, 30, 12), // Q111 truncated to "1."
        w('Exponential', 660, 300, 30, 90),
        w('112.', 622, 500, 30, 30),
      ];
      recoverTruncatedNumbers(words, 1224, 30, '.');
      expect(words[1].text).toBe('111.');
      expect(findQuestionMarkers(words, 30).map((m) => m.num)).toEqual([110, 111, 112]);
    });

    it('does NOT promote a stray that is not a digit-truncation of the gap', () => {
      const words = [
        w('110.How', 622, 100, 30, 80),
        w('7.', 622, 300, 30, 12), // "7" is neither prefix nor suffix of 111
        w('112.', 622, 500, 30, 30),
      ];
      recoverTruncatedNumbers(words, 1224, 30, '.');
      expect(words[1].text).toBe('7.'); // unchanged
    });

    it('does NOT promote when the gap is more than one number wide', () => {
      const words = [
        w('110.How', 622, 100, 30, 80),
        w('1.', 622, 300, 30, 12),
        w('113.', 622, 500, 30, 30), // gap 110→113 is 2 wide, not a single miss
      ];
      recoverTruncatedNumbers(words, 1224, 30, '.');
      expect(words[1].text).toBe('1.');
    });

    it('does NOT promote a stray sitting deep in the line (not at the left margin)', () => {
      const words = [
        w('110.How', 622, 100, 30, 80),
        w('1.', 900, 300, 30, 12), // far right of the column margin → in-text
        w('112.', 622, 500, 30, 30),
      ];
      recoverTruncatedNumbers(words, 1224, 30, '.');
      expect(words[1].text).toBe('1.');
    });
  });

  describe('recoverCenturyMisreads', () => {
    it('corrects a leading-digit misread that leaps over the next question (270→170)', () => {
      // Right column: 167,168, then Q170 read as "270.insulin", then Q171. The 270
      // spike would evict 171 in sequence validation; correcting it to 170 keeps both.
      const words = [
        w('167.', 622, 100, 30, 30),
        w('168.', 622, 300, 30, 30),
        w('270.insulin', 622, 500, 30, 110),
        w('171.Match', 622, 700, 30, 90),
      ];
      recoverCenturyMisreads(words, 1224, 30, '.');
      expect(words[2].text).toBe('170.insulin');
      expect(findQuestionMarkers(words, 30).map((m) => m.num)).toEqual([167, 168, 170, 171]);
    });

    it('does NOT touch a normal increasing sequence', () => {
      const words = [
        w('167.', 622, 100),
        w('168.', 622, 300),
        w('169.', 622, 500),
        w('170.', 622, 700),
      ];
      recoverCenturyMisreads(words, 1224, 30, '.');
      expect(words.map((x) => x.text)).toEqual(['167.', '168.', '169.', '170.']);
    });

    it('does NOT correct a high number that does not leap over a later continuation', () => {
      // 270 is last in the column with nothing smaller after it → left as-is (it is
      // not evicting any real question, so there is nothing to fix).
      const words = [w('167.', 622, 100), w('168.', 622, 300), w('270.x', 622, 500, 30, 40)];
      recoverCenturyMisreads(words, 1224, 30, '.');
      expect(words[2].text).toBe('270.x');
    });

    it('does NOT corrupt a correct top number sitting above a stray smaller marker (regression: 41 must stay 41, not 41-100=-59→59)', () => {
      // Real page-7 case: a CORRECT "41." is the first marker in its column, with a
      // stray "12." (an OCR/watermark artifact) below it, then "42.". The unguarded
      // pass treated 41 as a spike over 12 and computed 41-100=-59, which re-parsed
      // as 59, evicted 42 in sequence validation, and merged 41-44 into one crop.
      const words = [w('41.', 622, 100), w('12.', 622, 300), w('42.', 622, 500)];
      recoverCenturyMisreads(words, 1224, 30, '.');
      expect(words[0].text).toBe('41.'); // unchanged — no negative "correction"
      const nums = findQuestionMarkers(words, 30).map((m) => m.num);
      expect(nums).toContain(41);
      expect(nums).not.toContain(59);
    });
  });

  describe('buildQualityReport', () => {
    it('reports coverage, missing and duplicate numbers against an expected total', () => {
      const drafts = [
        { position: 0, questionNumber: 1, text: '1. a (1) (2)' },
        { position: 1, questionNumber: 2, text: '2. b (1) (2)' },
        { position: 2, questionNumber: 2, text: '2. c (1) (2)' }, // duplicate
        { position: 3, questionNumber: null, text: 'no number here' }, // number lost
      ];
      const r = buildQualityReport(drafts, 4);
      expect(r.expected).toBe(4);
      expect(r.detected).toBe(4);
      expect(r.missingNumbers).toEqual([3, 4]);
      expect(r.duplicateNumbers).toEqual([2]);
      expect(r.missingQuestionNumberPositions).toEqual([3]);
      // Coverage is in-range PRESENT / expected: numbers 1 and 2 are present, 3
      // and 4 are missing → 50%. (A duplicate 2 and a null-number draft do NOT
      // count toward coverage — the previous min(draftCount, expected) formula
      // wrongly reported 100% by counting them.)
      expect(r.coveragePct).toBe(50);
    });

    it('infers the range from detected numbers when no target is given (no phantom 1..N)', () => {
      // Page-range extract: questions 89..92 present, 91 missing. WITHOUT an
      // expectedTotal the report must NOT invent 1..88 as missing — it reports
      // only the [89..92] span.
      const drafts = [
        { position: 0, questionNumber: 89, text: '89.' },
        { position: 1, questionNumber: 90, text: '90.' },
        { position: 2, questionNumber: 92, text: '92.' },
      ];
      const r = buildQualityReport(drafts);
      expect(r.expected).toBe(4); // 89,90,91,92 → 4 questions in range
      expect(r.missingNumbers).toEqual([91]); // NOT [1..88, 91]
      expect(r.coveragePct).toBe(75); // 3 of 4 present
    });

    it('flags a crop whose text still holds two question numbers', () => {
      const drafts = [{ position: 0, questionNumber: 103, text: '103. major ... 104. select ...' }];
      const r = buildQualityReport(drafts, 180);
      expect(r.multiQuestionCrops).toEqual([{ position: 0, numbers: [103, 104] }]);
      expect(r.coveragePct).toBe(1); // 1 of 180
    });

    it('emits a per-missing diagnostic with previous/next/page/column', () => {
      const drafts = [
        {
          position: 0,
          questionNumber: 102,
          sourcePageNumber: 13,
          sourceColumn: 0,
          sourceColumnCount: 2,
        },
        {
          position: 1,
          questionNumber: 104,
          sourcePageNumber: 13,
          sourceColumn: 1,
          sourceColumnCount: 2,
        },
      ];
      const r = buildQualityReport(drafts, 104);
      const m103 = r.missing.find((x) => x.expected === 103);
      expect(m103).toMatchObject({
        expected: 103,
        previous: 102,
        next: 104,
        page: 13,
        column: 'Left',
      });
    });

    it('traces a missing number that was MERGED into a neighbouring draft', () => {
      // Q102's crop region spans both 102 and 103's content; 103 was read by OCR
      // and kept through sequence validation but no boundary was created.
      const drafts = [
        {
          position: 0,
          questionNumber: 102,
          sourcePageNumber: 13,
          sourceColumn: 0,
          sourceColumnCount: 2,
          sourceCoordinates: { x0: 40, y0: 80, x1: 600, y1: 900 },
        },
      ];
      const traces = [
        {
          page: 13,
          columnCount: 2,
          ocrNumbers: [
            { num: 102, x: 45, y: 100 },
            { num: 103, x: 45, y: 500 }, // inside Q102's region → merged
          ],
          markerNumbers: [102, 103],
          keptNumbers: [102, 103],
        },
      ];
      const r = buildQualityReport(drafts, 103, traces);
      const m = r.missing.find((x) => x.expected === 103)!;
      expect(m.stage).toBe('NOT_SPLIT');
      expect(m.ocrDetected).toBe(true);
      expect(m.mergedIntoDraft).toBe(102);
    });

    it('traces a missing number that OCR never read', () => {
      const drafts = [
        {
          position: 0,
          questionNumber: 89,
          sourcePageNumber: 5,
          sourceColumn: 0,
          sourceColumnCount: 1,
        },
      ];
      const traces = [
        {
          page: 5,
          columnCount: 1,
          ocrNumbers: [{ num: 89, x: 45, y: 100 }],
          markerNumbers: [89],
          keptNumbers: [89],
        },
      ];
      const r = buildQualityReport(drafts, 90, traces);
      const m = r.missing.find((x) => x.expected === 90)!;
      expect(m.stage).toBe('OCR_MISS');
      expect(m.ocrDetected).toBe(false);
    });

    it('traces a marker removed during sequence validation', () => {
      const drafts = [
        {
          position: 0,
          questionNumber: 89,
          sourcePageNumber: 5,
          sourceColumn: 0,
          sourceColumnCount: 1,
        },
      ];
      const traces = [
        {
          page: 5,
          columnCount: 1,
          ocrNumbers: [{ num: 90, x: 45, y: 400 }],
          markerNumbers: [90], // marker detection found it
          keptNumbers: [], // but sequence validation dropped it
        },
      ];
      const r = buildQualityReport(drafts, 90, traces);
      const m = r.missing.find((x) => x.expected === 90)!;
      expect(m.stage).toBe('SEQUENCE_REMOVED');
      expect(m.removedInSequence).toBe(true);
    });

    it('excludes invalid crops from the detected count and reports them', () => {
      const drafts = [
        { position: 0, questionNumber: 1, text: '1. q (1) (2)' },
        { position: 1, questionNumber: 2, text: '2. q (1) (2)' },
        { position: 2, questionNumber: null, text: '(3) (4)', invalidCrop: true }, // option fragment
      ];
      const r = buildQualityReport(drafts, 2);
      expect(r.detected).toBe(2); // invalid crop not counted
      expect(r.invalidCrops).toBe(1);
      expect(r.coveragePct).toBe(100);
    });

    it('infers the expected total from the max detected number when none is given', () => {
      const drafts = [
        { position: 0, questionNumber: 1 },
        { position: 1, questionNumber: 3 },
      ];
      const r = buildQualityReport(drafts);
      expect(r.expected).toBe(3);
      expect(r.missingNumbers).toEqual([2]);
    });
  });

  describe('detectColumns', () => {
    it('returns one column for a single-column page', () => {
      const cols = detectColumns(
        [
          { x0: 50, y0: 100 },
          { x0: 52, y0: 300 },
          { x0: 48, y0: 500 },
        ],
        1000,
      );
      expect(cols).toHaveLength(1);
      expect(cols[0].markers).toHaveLength(3);
    });

    it('splits a 4-column layout into 4 columns by X-position', () => {
      const ms: Array<{ x0: number; y0: number }> = [];
      for (const x of [50, 300, 550, 800]) for (const y of [100, 300]) ms.push({ x0: x, y0: y });
      const cols = detectColumns(ms, 1000);
      expect(cols).toHaveLength(4);
      expect(cols.map((c) => c.left)).toEqual([50, 300, 550, 800]);
      expect(cols[0].right).toBe(300); // right edge = next column's left
      cols.forEach((c) => expect(c.markers).toHaveLength(2));
    });
  });

  describe('buildRegions', () => {
    it('single column: one region per question, terminating at the next marker', () => {
      const cols = detectColumns(
        [
          { x0: 50, y0: 100 },
          { x0: 50, y0: 450 },
        ],
        1000,
      );
      const regions = buildRegions(cols, 1000, 1584, 30);
      expect(regions).toHaveLength(2);
      expect(regions[0].y0).toBe(88); // 100 - pad(12)
      expect(regions[0].y1).toBe(438); // next marker 450 - 12 (stops before Q2)
      expect(regions[1].y1).toBe(1584); // last → page bottom
      expect(regions[0].x1).toBe(1000); // single column spans full width
    });

    it('multi-column: column-bounded regions — no cross-column merge', () => {
      const ms: Array<{ x0: number; y0: number }> = [];
      for (const x of [50, 520]) for (const y of [100, 450]) ms.push({ x0: x, y0: y });
      const cols = detectColumns(ms, 1000);
      const regions = buildRegions(cols, 1000, 1584, 30);
      expect(regions).toHaveLength(4); // 2 columns × 2 questions
      const col1 = regions.filter((r) => r.x0 < 500);
      const col2 = regions.filter((r) => r.x0 >= 500);
      expect(col1).toHaveLength(2);
      expect(col2).toHaveLength(2);
      // Column 1 regions stop at column 2's left edge (520), NOT the page width.
      expect(col1[0].x1).toBe(520);
    });
  });

  describe('detectQuestionPunct', () => {
    it('picks "." when "." numbers span more distinct values than ")" (NEET)', () => {
      const words = [
        w('1.', 40, 100),
        w('(1)', 120, 150),
        w('(2)', 260, 150),
        w('2.', 40, 300),
        w('3.', 40, 500),
      ];
      expect(detectQuestionPunct(words, 30)).toBe('.');
    });
    it('picks ")" when ")" numbers span more distinct values', () => {
      const words = [w('1)', 40, 100), w('1.', 120, 150), w('2)', 40, 300), w('3)', 40, 500)];
      expect(detectQuestionPunct(words, 30)).toBe(')');
    });

    it('picks ")" even when "." OPTION numbers outnumber it (repetition ratio)', () => {
      // Questions "1)" "3)" "4)" (one each) vs options "1." "2." "3." "4." repeated
      // in every block — "." has MORE tokens but repeats, so ")" must win.
      const words = [
        w('1)', 40, 100),
        w('1.', 40, 140),
        w('2.', 40, 180),
        w('3.', 40, 220),
        w('4.', 40, 260),
        w('3)', 40, 400),
        w('1.', 40, 440),
        w('2.', 40, 480),
        w('3.', 40, 520),
        w('4.', 40, 560),
        w('4)', 40, 700),
        w('1.', 40, 740),
        w('2.', 40, 780),
        w('3.', 40, 820),
        w('4.', 40, 860),
      ];
      expect(detectQuestionPunct(words, 30)).toBe(')');
    });
  });

  describe('classifyBlock', () => {
    it('classifies a 4-option block as MCQ', () => {
      const block = [
        w('What', 40, 100),
        w('(1)', 60, 200),
        w('(2)', 200, 200),
        w('(3)', 340, 200),
        w('(4)', 480, 200),
      ];
      expect(classifyBlock(block, '.')).toBe('MCQ');
    });
    it('classifies a True/False block', () => {
      expect(
        classifyBlock([w('Statement', 40, 100), w('True', 40, 200), w('False', 200, 200)], '.'),
      ).toBe('TRUE_FALSE');
    });
    it('classifies an Assertion-Reason block', () => {
      expect(
        classifyBlock([w('Assertion', 40, 100), w('and', 200, 100), w('Reason', 300, 100)], '.'),
      ).toBe('ASSERTION_REASON');
    });
    it('falls back to UNKNOWN for a bare stem with no answer structure', () => {
      expect(classifyBlock([w('Some', 40, 100), w('words', 120, 100)], '.')).toBe('UNKNOWN');
    });
  });

  describe('isCompleteBlock / mergeIncompleteRegions', () => {
    const col = { x0: 40, x1: 1000 };
    const regA: Region = { ...col, y0: 88, y1: 288 };
    const regB: Region = { ...col, y0: 288, y1: 1584 };

    it('marks an OPTIONS-ONLY block (no stem) as INCOMPLETE — guards stem-less crops', () => {
      const opts = [w('(1)', 60, 150), w('(2)', 200, 150), w('(3)', 340, 150), w('(4)', 480, 150)];
      expect(isCompleteBlock(opts, '.')).toBe(false);
    });
    it('marks a stem + ≥2 options block as complete', () => {
      const block = [
        w('What', 60, 80),
        w('happens', 130, 80),
        w('(1)', 60, 150),
        w('(2)', 200, 150),
        w('(3)', 340, 150),
        w('(4)', 480, 150),
      ];
      expect(isCompleteBlock(block, '.')).toBe(true);
    });
    it('marks a bare-stem block as incomplete', () => {
      expect(isCompleteBlock([w('stem', 60, 150)], '.')).toBe(false);
    });

    it('merges an incomplete region into the next (false-marker guard)', () => {
      // regA has only a stem (no options) → its split was a false marker → merge.
      const words = [w('stem', 60, 150), w('(1)', 60, 350), w('(2)', 200, 350), w('(3)', 340, 350)];
      const merged = mergeIncompleteRegions([regA, regB], words, '.');
      expect(merged).toHaveLength(1);
      expect(merged[0].y0).toBe(88);
      expect(merged[0].y1).toBe(1584);
    });

    it('keeps two regions when the first block is complete', () => {
      const words = [
        w('Which', 60, 100),
        w('element', 130, 100), // stem in regA
        w('(1)', 60, 150),
        w('(2)', 200, 150),
        w('(3)', 340, 150),
        w('(4)', 480, 150), // stem + options in regA → complete
        w('(1)', 60, 350),
        w('(2)', 200, 350), // options in regB
      ];
      const merged = mergeIncompleteRegions([regA, regB], words, '.');
      expect(merged).toHaveLength(2);
    });
  });

  describe('hasStem', () => {
    it('is false for an options-only block (number + options, no question text)', () => {
      const block = [
        w('151.', 40, 100), // question number — not stem
        w('(1)', 60, 200),
        w('(2)', 200, 200),
        w('(3)', 340, 200),
        w('(4)', 480, 200),
      ];
      expect(hasStem(block, '.')).toBe(false);
    });
    it('is true when question text sits above the options', () => {
      const block = [
        w('151.', 40, 100),
        w('What', 90, 100, 30, 60),
        w('is', 160, 100, 30, 30),
        w('valency', 200, 100, 30, 70),
        w('(1)', 60, 200),
        w('(2)', 200, 200),
      ];
      expect(hasStem(block, '.')).toBe(true);
    });
    it('does not count option labels below the first option as stem', () => {
      const block = [w('1.', 40, 100), w('(1)', 60, 200), w('(2)', 200, 200), w('(3)', 340, 200)];
      expect(hasStem(block, '.')).toBe(false);
    });
  });

  describe('buildRegions configurable padding', () => {
    it('honors padTop / padBottom overrides', () => {
      const cols = detectColumns(
        [
          { x0: 50, y0: 100 },
          { x0: 50, y0: 450 },
        ],
        1000,
      );
      const regions = buildRegions(cols, 1000, 1584, 30, 20, 5);
      expect(regions[0].y0).toBe(80); // 100 - padTop(20)
      expect(regions[0].y1).toBe(445); // next marker 450 - padBottom(5)
    });
  });

  describe('countOptionMarkers', () => {
    it('counts distinct (1)(2)(3)(4) markers', () => {
      expect(
        countOptionMarkers([
          w('(1)', 120, 0),
          w('(2)', 120, 40),
          w('(3)', 120, 80),
          w('(4)', 120, 120),
        ]),
      ).toBe(4);
    });
    it('counts numbered "1." "2." options (period markers)', () => {
      expect(
        countOptionMarkers([w('1.', 0, 0), w('2.', 0, 40), w('3.', 0, 80), w('4.', 0, 120)]),
      ).toBe(4);
    });
    it('counts lettered (a)-(c) markers', () => {
      expect(countOptionMarkers([w('(a)', 0, 0), w('(b)', 0, 40), w('(c)', 0, 80)])).toBe(3);
    });
    it('defaults to 4 when fewer than 2 markers are found', () => {
      expect(countOptionMarkers([w('hello', 0, 0)])).toBe(4);
    });
  });
});
