import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { Role } from '../../../shared/common/enums/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import {
  DocumentEnhancementService,
  EnhancementResult,
  SelectableVersion,
  SelectResult,
} from '../document-enhancement.service';

export class SelectVersionDto {
  @IsIn(['original', 'enhanced'])
  version!: SelectableVersion;
}

/**
 * Document Enhancement endpoints (Phase 2). Called AFTER the browser PUT and the
 * profiler verdict, BEFORE POST /uploads/:id/complete:
 *
 *   create → PUT → /document-profile → (DIGITAL) /document-enhance → preview → /select → complete
 *
 * /document-enhance builds the enhanced DRAFT on a separate key (original always
 * preserved) and returns {removed, declined, enhancedStorageKey}. /select applies
 * the user's choice. Both never change the OCR pipeline.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.TEACHER)
@Controller('document-enhance')
export class DocumentEnhancementController {
  constructor(private readonly enhancement: DocumentEnhancementService) {}

  @Post(':uploadId')
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ): Promise<{ data: EnhancementResult }> {
    return { data: await this.enhancement.enhance({ actor, uploadId }) };
  }

  @Post(':uploadId/select')
  @HttpCode(HttpStatus.OK)
  async select(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @Body() body: SelectVersionDto,
  ): Promise<{ data: SelectResult }> {
    return { data: await this.enhancement.select({ actor, uploadId, version: body.version }) };
  }
}
