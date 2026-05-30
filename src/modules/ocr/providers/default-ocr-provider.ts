import { Injectable } from '@nestjs/common';
import { IOcrProvider } from './ocr-provider.interface';

const LOW_CONFIDENCE_THRESHOLD = 0.7;

@Injectable()
export class DefaultOcrProvider implements IOcrProvider {
  isHighConfidence(overall: number | null): boolean {
    if (overall === null) return false;
    return overall >= LOW_CONFIDENCE_THRESHOLD;
  }
}
