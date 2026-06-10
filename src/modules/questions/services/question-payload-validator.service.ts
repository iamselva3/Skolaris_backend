import { BadRequestException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CHOICE_TYPES, QuestionType } from '../models/question-type.enum';
import {
  ChoiceOptionInput,
  expectedCorrectCount,
  payloadClassFor,
} from '../dtos/question-payloads';

/**
 * Validates that `payload` matches the shape expected for `type`.
 * Choice-type questions must additionally supply at least two options with the
 * correct number of `isCorrect: true` entries (1 for SINGLE_CHOICE, ≥1 for MULTIPLE_CHOICE).
 */
@Injectable()
export class QuestionPayloadValidator {
  validate(input: { type: QuestionType; payload: unknown; options?: ChoiceOptionInput[] }): void {
    const cls = payloadClassFor(input.type) as new () => object;
    const instance = plainToInstance(cls, input.payload ?? {});
    const errors = validateSync(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const messages = errors.flatMap((e) =>
        e.constraints ? Object.values(e.constraints) : [`Invalid ${e.property}`],
      );
      throw new BadRequestException({
        statusCode: 400,
        error: 'BadRequest',
        message: messages.map((m) => `payload: ${m}`),
      });
    }

    if (input.type === QuestionType.VISUAL) {
      // The image IS the question; option text lives in the image, so we only
      // validate the positional answer slots: 2..6 of them, exactly one correct.
      const options = input.options ?? [];
      if (options.length < 2 || options.length > 6) {
        throw new BadRequestException('VISUAL requires between 2 and 6 options');
      }
      const correct = options.filter((o) => o.isCorrect).length;
      if (correct !== 1) {
        throw new BadRequestException('VISUAL requires exactly one correct option');
      }
    } else if (CHOICE_TYPES.has(input.type)) {
      const options = input.options ?? [];
      if (options.length < 2) {
        throw new BadRequestException(`${input.type} requires at least 2 options`);
      }
      const check = expectedCorrectCount(input.type, options);
      if (!check.ok) {
        throw new BadRequestException(check.reason);
      }
    } else if (input.options && input.options.length > 0) {
      throw new BadRequestException(`Options are not allowed for question type ${input.type}`);
    }
  }
}
