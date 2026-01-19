import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards';
import { RequireProjectRole } from '../common/decorators/roles';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';
import { ModelsService } from './models.service';
import { SaveModelDto } from './dto/save-model.dto';

@UseGuards(JwtAuthGuard)
@Controller('models')
export class ModelsController {
  constructor(private readonly svc: ModelsService) {}

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('READER') // READER+ puede visualizar
  @Get(':projectId')
  async getCurrent(
    @Param('projectId') projectId: string,
    @Query('branchId') branchId: string | undefined,
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId;
    return this.svc.getCurrent(projectId, userId, branchId);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('EDITOR') // EDITOR/OWNER guarda
  @Post(':projectId/versions')
  async saveNewVersion(
    @Param('projectId') projectId: string,
    @Body() dto: SaveModelDto & { content: any },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId;
    return this.svc.saveNewVersion(projectId, userId, dto);
  }
}
