import { BadRequestException } from '@nestjs/common';
import { QuestionType } from '../models/question-type.enum';
import { QuestionPayloadValidator } from './question-payload-validator.service';

describe('QuestionPayloadValidator', () => {
  const v = new QuestionPayloadValidator();

  describe('SINGLE_CHOICE', () => {
    it('accepts when exactly one option is correct', () => {
      expect(() =>
        v.validate({
          type: QuestionType.SINGLE_CHOICE,
          payload: { explanation: 'because 2+2=4' },
          options: [
            { label: '3', isCorrect: false },
            { label: '4', isCorrect: true },
          ],
        }),
      ).not.toThrow();
    });

    it('rejects when no option is correct', () => {
      expect(() =>
        v.validate({
          type: QuestionType.SINGLE_CHOICE,
          payload: {},
          options: [
            { label: '3', isCorrect: false },
            { label: '4', isCorrect: false },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects when more than one option is correct', () => {
      expect(() =>
        v.validate({
          type: QuestionType.SINGLE_CHOICE,
          payload: {},
          options: [
            { label: '3', isCorrect: true },
            { label: '4', isCorrect: true },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects with too few options', () => {
      expect(() =>
        v.validate({
          type: QuestionType.SINGLE_CHOICE,
          payload: {},
          options: [{ label: '4', isCorrect: true }],
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('MULTIPLE_CHOICE', () => {
    it('accepts ≥1 correct option', () => {
      expect(() =>
        v.validate({
          type: QuestionType.MULTIPLE_CHOICE,
          payload: {},
          options: [
            { label: 'a', isCorrect: true },
            { label: 'b', isCorrect: true },
            { label: 'c', isCorrect: false },
          ],
        }),
      ).not.toThrow();
    });
  });

  describe('TRUE_FALSE', () => {
    it('accepts a valid payload', () => {
      expect(() =>
        v.validate({
          type: QuestionType.TRUE_FALSE,
          payload: { correct: true, explanation: 'sky is blue' },
        }),
      ).not.toThrow();
    });

    it('rejects missing `correct`', () => {
      expect(() => v.validate({ type: QuestionType.TRUE_FALSE, payload: {} })).toThrow(
        BadRequestException,
      );
    });

    it('rejects when options are supplied (non-choice type)', () => {
      expect(() =>
        v.validate({
          type: QuestionType.TRUE_FALSE,
          payload: { correct: true },
          options: [
            { label: 'yes', isCorrect: true },
            { label: 'no', isCorrect: false },
          ],
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('FILL_BLANK', () => {
    it('accepts valid payload', () => {
      expect(() =>
        v.validate({
          type: QuestionType.FILL_BLANK,
          payload: { accepted: ['Paris'], caseSensitive: false },
        }),
      ).not.toThrow();
    });

    it('rejects empty accepted list', () => {
      expect(() =>
        v.validate({
          type: QuestionType.FILL_BLANK,
          payload: { accepted: [], caseSensitive: false },
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('MATCH_FOLLOWING', () => {
    it('accepts ≥2 pairs', () => {
      expect(() =>
        v.validate({
          type: QuestionType.MATCH_FOLLOWING,
          payload: {
            pairs: [
              { left: 'a', right: '1' },
              { left: 'b', right: '2' },
            ],
          },
        }),
      ).not.toThrow();
    });

    it('rejects when pairs missing', () => {
      expect(() => v.validate({ type: QuestionType.MATCH_FOLLOWING, payload: {} })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('DESCRIPTIVE', () => {
    it('accepts an empty payload', () => {
      expect(() => v.validate({ type: QuestionType.DESCRIPTIVE, payload: {} })).not.toThrow();
    });

    it('accepts maxWords cap', () => {
      expect(() =>
        v.validate({
          type: QuestionType.DESCRIPTIVE,
          payload: { rubric: 'short answer', maxWords: 200 },
        }),
      ).not.toThrow();
    });
  });

  describe('VISUAL', () => {
    const img = '<p><img src="https://x/storage/v1/b/b/o/k?alt=media" /></p>';

    it('accepts an image stem with 4 options and exactly one correct', () => {
      expect(() =>
        v.validate({
          type: QuestionType.VISUAL,
          payload: { contentHtml: img, optionCount: 4 },
          options: [
            { label: '1', isCorrect: false },
            { label: '2', isCorrect: true },
            { label: '3', isCorrect: false },
            { label: '4', isCorrect: false },
          ],
        }),
      ).not.toThrow();
    });

    it('rejects a missing image (empty contentHtml)', () => {
      expect(() =>
        v.validate({
          type: QuestionType.VISUAL,
          payload: { contentHtml: '', optionCount: 4 },
          options: [
            { label: '1', isCorrect: true },
            { label: '2', isCorrect: false },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects when no option is correct', () => {
      expect(() =>
        v.validate({
          type: QuestionType.VISUAL,
          payload: { contentHtml: img, optionCount: 2 },
          options: [
            { label: '1', isCorrect: false },
            { label: '2', isCorrect: false },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects when more than one option is correct', () => {
      expect(() =>
        v.validate({
          type: QuestionType.VISUAL,
          payload: { contentHtml: img, optionCount: 2 },
          options: [
            { label: '1', isCorrect: true },
            { label: '2', isCorrect: true },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects fewer than 2 options', () => {
      expect(() =>
        v.validate({
          type: QuestionType.VISUAL,
          payload: { contentHtml: img, optionCount: 2 },
          options: [{ label: '1', isCorrect: true }],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects more than 6 options', () => {
      expect(() =>
        v.validate({
          type: QuestionType.VISUAL,
          payload: { contentHtml: img, optionCount: 6 },
          options: Array.from({ length: 7 }, (_, i) => ({
            label: String(i + 1),
            isCorrect: i === 0,
          })),
        }),
      ).toThrow(BadRequestException);
    });
  });
});
