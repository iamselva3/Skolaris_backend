import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { DocumentProfileResult, DocumentProfilerService } from '../document-profiler.service';

/**
 * Document Profiler endpoint (Phase 1). The FE calls it AFTER the browser PUT to
 * storage and BEFORE POST /uploads/:id/complete:
 *
 *   create upload → PUT bytes → POST /document-profile/:uploadId → (preview) → complete
 *
 * It is READ-ONLY: it classifies the document (digital vs scanned) from the
 * document's own structure and returns the profile. It writes nothing and never
 * changes OCR behaviour. `recommendedPath` ('ENHANCE' | 'BYPASS') tells the FE
 * whether to offer the enhancement preview or go straight to Extract.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.TEACHER)
@Controller('document-profile')
export class DocumentProfilerController {
  constructor(private readonly profiler: DocumentProfilerService) {}

  @Post(':uploadId')
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ): Promise<{ data: DocumentProfileResult }> {
    return { data: await this.profiler.execute({ actor, uploadId }) };
  }
}
