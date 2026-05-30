import { Injectable } from '@nestjs/common';
import { QuestionType } from '../../questions/models/question-type.enum';
import {
  DescriptiveStrategy,
  FillBlankStrategy,
  MatchFollowingStrategy,
  MatrixMatchStrategy,
  MultipleChoiceStrategy,
  SingleChoiceStrategy,
  TrueFalseStrategy,
} from './grading-strategies';
import { GradingAnswer, GradingQuestion, GradingResult, IGradingStrategy } from './grading.types';

@Injectable()
export class GradingService {
  private readonly strategies: Record<QuestionType, IGradingStrategy> = {
    [QuestionType.SINGLE_CHOICE]: new SingleChoiceStrategy(),
    [QuestionType.MULTIPLE_CHOICE]: new MultipleChoiceStrategy(),
    [QuestionType.TRUE_FALSE]: new TrueFalseStrategy(),
    [QuestionType.FILL_BLANK]: new FillBlankStrategy(),
    [QuestionType.MATCH_FOLLOWING]: new MatchFollowingStrategy(),
    [QuestionType.MATRIX_MATCH]: new MatrixMatchStrategy(),
    [QuestionType.DESCRIPTIVE]: new DescriptiveStrategy(),
  };

  grade(question: GradingQuestion, answer: GradingAnswer): GradingResult {
    const strategy = this.strategies[question.type];
    if (!strategy) {
      throw new Error(`No grading strategy for type ${question.type}`);
    }
    return strategy.grade(question, answer);
  }
}
