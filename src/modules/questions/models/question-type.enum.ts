export enum QuestionType {
  SINGLE_CHOICE = 'SINGLE_CHOICE',
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
  FILL_BLANK = 'FILL_BLANK',
  TRUE_FALSE = 'TRUE_FALSE',
  MATCH_FOLLOWING = 'MATCH_FOLLOWING',
  MATRIX_MATCH = 'MATRIX_MATCH',
  DESCRIPTIVE = 'DESCRIPTIVE',
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
