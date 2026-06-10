export enum QuestionType {
  SINGLE_CHOICE = 'SINGLE_CHOICE',
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
  FILL_BLANK = 'FILL_BLANK',
  TRUE_FALSE = 'TRUE_FALSE',
  MATCH_FOLLOWING = 'MATCH_FOLLOWING',
  MATRIX_MATCH = 'MATRIX_MATCH',
  DESCRIPTIVE = 'DESCRIPTIVE',
  // The entire question (stem + options + figures) is a single image; the
  // teacher only marks which positional option (1..N) is correct. Graded like
  // SINGLE_CHOICE on positional options. See VisualPayloadDto.
  VISUAL = 'VISUAL',
}

export enum Difficulty {
  EASY = 'EASY',
  MEDIUM = 'MEDIUM',
  HARD = 'HARD',
}

export const CHOICE_TYPES: ReadonlySet<QuestionType> = new Set([
  QuestionType.SINGLE_CHOICE,
  QuestionType.MULTIPLE_CHOICE,
]);
