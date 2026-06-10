import { assignAnswersToDrafts, detectDraftNumber, parseAnswerKey } from './answer-key';

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
