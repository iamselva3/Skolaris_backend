import {
  assignAnswersToDrafts,
  buildParseReport,
  detectDraftNumber,
  parseAnswerKey,
} from './answer-key';

describe('answer-key parser', () => {
  it('parses hyphen format "1-A 2-C 3-B 4-D"', () => {
    const { entries } = parseAnswerKey('1-A 2-C 3-B 4-D');
    expect(entries.get(1)).toMatchObject({ correctIndex: 1 });
    expect(entries.get(2)).toMatchObject({ correctIndex: 3 });
    expect(entries.get(3)).toMatchObject({ correctIndex: 2 });
    expect(entries.get(4)).toMatchObject({ correctIndex: 4 });
  });

  it('parses space-separated format "1 A\\n2 C"', () => {
    const { entries } = parseAnswerKey('1 A\n2 C');
    expect(entries.get(1)?.correctIndex).toBe(1);
    expect(entries.get(2)?.correctIndex).toBe(3);
  });

  it('parses dotted / paren / colon / arrow separators', () => {
    const { entries } = parseAnswerKey('1. A   2) B   3: C   7 → D');
    expect(entries.get(1)?.correctIndex).toBe(1);
    expect(entries.get(2)?.correctIndex).toBe(2);
    expect(entries.get(3)?.correctIndex).toBe(3);
    expect(entries.get(7)?.correctIndex).toBe(4);
  });

  it('parses numeric answers "12-3"', () => {
    const { entries } = parseAnswerKey('12-3');
    expect(entries.get(12)?.correctIndex).toBe(3);
  });

  it('parses TRUE/FALSE answers as booleans', () => {
    const { entries } = parseAnswerKey('1 TRUE\n2 false');
    expect(entries.get(1)).toMatchObject({ correct: true });
    expect(entries.get(2)).toMatchObject({ correct: false });
    expect(entries.get(1)?.correctIndex).toBeUndefined();
  });

  it('handles many entries on one line (multi-column key)', () => {
    const { entries } = parseAnswerKey('1-A 2-B 3-C 4-D 5-A 6-B');
    expect(entries.size).toBe(6);
    expect(entries.get(6)?.correctIndex).toBe(2);
  });

  it('drops a number with conflicting duplicate answers and reports it', () => {
    const { entries, conflicts } = parseAnswerKey('1-A 1-C 2-B');
    expect(entries.has(1)).toBe(false);
    expect(conflicts).toEqual([1]);
    expect(entries.get(2)?.correctIndex).toBe(2);
  });

  it('keeps a number repeated with the SAME answer', () => {
    const { entries, conflicts } = parseAnswerKey('1-A 1-A');
    expect(entries.get(1)?.correctIndex).toBe(1);
    expect(conflicts).toEqual([]);
  });

  it('ignores noise lines without a number→answer pair', () => {
    const { entries } = parseAnswerKey('ANSWER KEY — Physics\nPage 1\n1-A');
    expect(entries.size).toBe(1);
    expect(entries.get(1)?.correctIndex).toBe(1);
  });

  it('returns empty for empty input', () => {
    expect(parseAnswerKey('').entries.size).toBe(0);
  });
});

describe('detectDraftNumber', () => {
  it.each([
    ['151. What is valency', 151],
    ['1) Choose the correct', 1],
    ['Q.42 Which element', 42],
    ['Question 7 describes', 7],
    ['12 A sodium atom', 12],
  ])('reads the leading number from "%s"', (text, expected) => {
    expect(detectDraftNumber(text)).toBe(expected);
  });

  it('returns null when there is no leading number', () => {
    expect(detectDraftNumber('A diagram of a circuit')).toBeNull();
  });
});

describe('assignAnswersToDrafts', () => {
  const drafts = [
    { id: 'd1', text: '1. First question', optionCount: 4 },
    { id: 'd2', text: '2) Second question', optionCount: 4 },
    { id: 'd3', text: 'No number here', optionCount: 4 },
  ];

  it('assigns answers to drafts matched by question number', () => {
    const key = parseAnswerKey('1-A 2-D');
    const r = assignAnswersToDrafts(drafts, key);
    expect(r.assignments).toEqual([
      {
        draftId: 'd1',
        questionNumber: 1,
        suggestedAnswer: { source: 'answer-key', raw: 'A', correctIndex: 1 },
      },
      {
        draftId: 'd2',
        questionNumber: 2,
        suggestedAnswer: { source: 'answer-key', raw: 'D', correctIndex: 4 },
      },
    ]);
    expect(r.unmatchedDraftIds).toEqual(['d3']); // no leading number
  });

  it('uses the AUTHORITATIVE questionNumber over the OCR text (reorder safety)', () => {
    // A reordered draft: questionNumber is 5 but its OCR text still starts "2.".
    // The answer for Q5 must map to it — never the text's "2".
    const reordered = [{ id: 'd1', text: '2. old text', questionNumber: 5, optionCount: 4 }];
    const key = parseAnswerKey('5-A 2-C');
    const r = assignAnswersToDrafts(reordered, key);
    expect(r.assignments).toEqual([
      {
        draftId: 'd1',
        questionNumber: 5,
        suggestedAnswer: { source: 'answer-key', raw: 'A', correctIndex: 1 },
      },
    ]);
    expect(r.unmatchedKeyNumbers).toEqual([2]); // the "2" key entry matched nothing
  });

  it('falls back to the OCR text number when questionNumber is null', () => {
    const legacy = [{ id: 'd1', text: '7. q', questionNumber: null, optionCount: 4 }];
    const r = assignAnswersToDrafts(legacy, parseAnswerKey('7-B'));
    expect(r.assignments[0]).toMatchObject({
      questionNumber: 7,
      suggestedAnswer: { correctIndex: 2 },
    });
  });

  it('reports key numbers that match no draft', () => {
    const key = parseAnswerKey('1-A 2-D 9-C');
    const r = assignAnswersToDrafts(drafts, key);
    expect(r.unmatchedKeyNumbers).toEqual([9]);
  });

  it('rejects an index answer that exceeds the draft optionCount', () => {
    const twoOpt = [{ id: 'd1', text: '1. q', optionCount: 2 }];
    const key = parseAnswerKey('1-D'); // D = position 4 > 2 options
    const r = assignAnswersToDrafts(twoOpt, key);
    expect(r.assignments).toHaveLength(0);
    expect(r.outOfRangeNumbers).toEqual([1]);
    expect(r.unmatchedDraftIds).toEqual(['d1']);
  });

  it('trusts actual options over an under-counted optionCount (maps, not out-of-range)', () => {
    // Real bug: question-OCR detected 2 slots but the draft has 4 labelled
    // options (A,B,C,D). The answer-key answer "D" (4) must map, not be rejected.
    const draft = [{ id: 'd1', text: '6. q', optionCount: 2, optionsLength: 4 }];
    const r = assignAnswersToDrafts(draft, parseAnswerKey('6-D'));
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].suggestedAnswer.correctIndex).toBe(4);
    expect(r.outOfRangeNumbers).toEqual([]);
  });

  it('still rejects a genuinely out-of-range answer (option 5 on a 4-option draft)', () => {
    const draft = [{ id: 'd1', text: '1. q', optionCount: 4, optionsLength: 4 }];
    const r = assignAnswersToDrafts(draft, parseAnswerKey('1-5')); // index 5 > 4
    expect(r.assignments).toHaveLength(0);
    expect(r.outOfRangeNumbers).toEqual([1]);
  });

  it('allows TRUE/FALSE answers regardless of optionCount', () => {
    const tf = [{ id: 'd1', text: '1. statement', optionCount: 2 }];
    const r = assignAnswersToDrafts(tf, parseAnswerKey('1 TRUE'));
    expect(r.assignments[0].suggestedAnswer).toMatchObject({ correct: true });
  });

  it('does not bound the index when optionCount is unknown', () => {
    const unknown = [{ id: 'd1', text: '1. q', optionCount: null }];
    const r = assignAnswersToDrafts(unknown, parseAnswerKey('1-D'));
    expect(r.assignments[0].suggestedAnswer.correctIndex).toBe(4);
  });
});

describe('canonical grammar — required patterns', () => {
  it.each([
    ['1-A', 1, 1],
    ['1. A', 1, 1],
    ['1) A', 1, 1],
    ['1. (2)', 1, 2],
    ['1 (A)', 1, 1],
    ['Q1 -> B', 1, 2],
    ['Question 1 : C', 1, 3],
    ['1 => D', 1, 4],
    ['2) (2)', 2, 2],
  ])('parses "%s" → Q%d index %d', (input, num, index) => {
    const { entries } = parseAnswerKey(input);
    expect(entries.get(num)?.correctIndex).toBe(index);
  });

  it('parses a multi-column line "1 (A) 2 (B) 46 (C) 69 (B)"', () => {
    const { entries } = parseAnswerKey('1 (A) 2 (B) 46 (C) 69 (B)');
    expect(entries.get(1)?.correctIndex).toBe(1);
    expect(entries.get(2)?.correctIndex).toBe(2);
    expect(entries.get(46)?.correctIndex).toBe(3);
    expect(entries.get(69)?.correctIndex).toBe(2);
  });

  it('does NOT split a multi-digit number ("123" is not 12→3)', () => {
    expect(parseAnswerKey('123').entries.size).toBe(0);
  });

  it('does NOT read an answer out of prose ("1 because" is not 1→B)', () => {
    expect(parseAnswerKey('1 because the answer follows').entries.size).toBe(0);
  });

  // Regression: real 3-column OCR with a "Total Questions: 22" header. Previously
  // the header "22" bound to the next line's "1" (losing Q1, conflicting Q22) and
  // the digit inside "(1)" was read as a question number (invalid 1→11/15/18/22).
  it('parses a 3-column key with a numeric header without bleed or false invalids', () => {
    const ocr =
      'ANSWER KEY\n\nTotal Questions: 22\n' +
      '1. (2) 9. (2) 16. (3)\n2. (4) 10. (4) 17. (2)\n3. (1) 11. (1) 18. (4)\n' +
      '4. (3) 12. (3) 19. (1)\n5. (2) 13. (2) 20. (3)\n6. (4) 14. (4) 21. (2)\n' +
      '7. (1) 15. (1) 22. (4)\n8. (3)\n';
    const { entries, conflicts, invalid } = parseAnswerKey(ocr);
    expect(entries.size).toBe(22);
    expect(entries.get(1)?.correctIndex).toBe(2);
    expect(entries.get(22)?.correctIndex).toBe(4);
    expect(conflicts).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

describe('question-number >= 1 enforcement', () => {
  it('rejects question number 0 and reports it', () => {
    const { entries, rejected } = parseAnswerKey('0-A 1-B 2-C');
    expect(entries.has(0)).toBe(false);
    expect(rejected).toEqual([0]);
    expect(entries.get(1)?.correctIndex).toBe(2);
  });

  it('detectDraftNumber rejects a leading 0', () => {
    expect(detectDraftNumber('0. not a real question')).toBeNull();
  });
});

describe('buildParseReport — full validation', () => {
  it('reports totals, missing, duplicates, conflicts, invalid, zero', () => {
    const report = buildParseReport('0-A 1-A 1-A 2-B 2-C 4-Z 5-D');
    // entries: 1 (A, identical dup kept), 5 (D); 2 conflicts; 4 invalid; 0 rejected.
    expect(report.entries.map((e) => e.questionNumber)).toEqual([1, 5]);
    expect(report.totalDetected).toBe(2);
    expect(report.zeroOrNegative).toEqual([0]);
    expect(report.duplicates).toEqual([1, 2]); // both seen twice (1 identical, 2 conflicting)
    expect(report.conflicts).toEqual([2]); // different answers
    expect(report.invalid).toEqual([{ questionNumber: 4, raw: 'Z', reason: 'Invalid answer value' }]);
    expect(report.missingNumbers).toEqual([2, 3, 4]); // gaps within 1..5
    expect(report.startsAtOne).toBe(true);
  });

  it('canonical entry shape is { questionNumber, answer }', () => {
    const report = buildParseReport('1-A 2 TRUE');
    expect(report.entries[0]).toMatchObject({
      questionNumber: 1,
      answer: { kind: 'option', index: 1, label: 'A' },
    });
    expect(report.entries[1]).toMatchObject({
      questionNumber: 2,
      answer: { kind: 'boolean', value: true },
    });
  });
});
