import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { OcrPreprocessService, PreprocessResult } from '../ocr-preprocess.service';

/**
 * Layout preprocess endpoint. The FE calls it AFTER the browser PUT to storage and
 * BEFORE POST /uploads/:id/complete:
 *
 *   create upload → PUT bytes → POST /ocr-preprocess/:uploadId → POST /uploads/:id/complete
 *
 * It reflows confident true multi-column PDFs in place; everything else is a no-op. It
 * never blocks the flow — on any problem it returns changed:false and the original bytes
 * are left for the unchanged OCR pipeline.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.TEACHER)
@Controller('ocr-preprocess')
export class OcrPreprocessController {
  constructor(private readonly preprocess: OcrPreprocessService) {}

  @Post(':uploadId')
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ): Promise<{ data: PreprocessResult }> {
    return { data: await this.preprocess.execute({ actor, uploadId }) };
  }
}
