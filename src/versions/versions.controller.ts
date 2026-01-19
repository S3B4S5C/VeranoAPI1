import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards';
import { RequireProjectRole } from '../common/decorators/roles';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';
import { VersionsService } from './versions.service';

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId')
export class VersionsController {
  constructor(private readonly svc: VersionsService) {}

  // Branches
  @UseGuards(ProjectRoleGuard) @RequireProjectRole('READER')
  @Get('branches')
  listBranches(@Param('projectId') projectId: string) {
    return this.svc.listBranches(projectId);
  }

  @UseGuards(ProjectRoleGuard) @RequireProjectRole('EDITOR')
  @Post('branches')
  createBranch(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; fromVersionId?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId;
    return this.svc.createBranch(projectId, userId, body.name, body.fromVersionId);
  }

  @UseGuards(ProjectRoleGuard) @RequireProjectRole('READER')
  @Get('branches/:branchId/versions')
  listVersions(
    @Param('projectId') projectId: string,
    @Param('branchId') branchId: string,
    @Query('take') take = '50',
  ) {
    return this.svc.listVersions(projectId, branchId, Number(take) || 50);
  }

  // Diff
  @UseGuards(ProjectRoleGuard) @RequireProjectRole('READER')
  @Get('diff')
  diff(@Param('projectId') projectId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.svc.diff(projectId, from, to);
  }

  // Restore
  @UseGuards(ProjectRoleGuard) @RequireProjectRole('EDITOR')
  @Post('restore')
  restore(@Param('projectId') projectId: string, @Body() body: { versionId: string; message?: string }, @Req() req: Request) {
    const userId = (req as any).user.userId;
    return this.svc.restore(projectId, userId, body.versionId, body.message);
  }

  // Merge
  @UseGuards(ProjectRoleGuard) @RequireProjectRole('EDITOR')
  @Post('merge')
  merge(
    @Param('projectId') projectId: string,
    @Body() body: { sourceBranchId: string; targetBranchId: string; sourceVersionId: string; targetVersionId: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId;
    return this.svc.merge(projectId, userId, body);
  }
}
