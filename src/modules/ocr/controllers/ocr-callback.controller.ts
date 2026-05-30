import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { OcrCallbackDto } from '../dtos/ocr-callback.dto';
import { HmacAuthGuard } from '../guards/hmac-auth.guard';
import { HandleOcrCallbackUseCase } from '../use-cases/handle-ocr-callback.use-case';

/**
 * Internal endpoint called by the OCR microservice when extraction finishes.
 * Bypasses JwtAuthGuard via @Public(); validated by HmacAuthGuard against
 * the X-OCR-Signature header.
 */
@Controller('internal/ocr')
export class OcrCallbackController {
  constructor(private readonly handleCallback: HandleOcrCallbackUseCase) {}

  @Public()
  @UseGuards(HmacAuthGuard)
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  async callback(@Body() dto: OcrCallbackDto) {
    const r = await this.handleCallback.execute(dto);
    return {
      data: {
        ocrJobId: r.ocrJob.id,
        draftsWritten: r.draftsWritten,
        alreadyProcessed: r.alreadyProcessed,
      },
    };
  }
}
