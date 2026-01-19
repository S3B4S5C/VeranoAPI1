import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards';
import { RequireProjectRole } from '../common/decorators/roles';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';
import { CollaboratorsService } from './collaborators.service';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/collaborators')
export class CollaboratorsController {
  constructor(private readonly svc: CollaboratorsService) {}

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('READER')
  @Get()
  list(@Param('projectId') projectId: string) {
    return this.svc.list(projectId);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Post()
  add(@Param('projectId') projectId: string, @Body() dto: AddMemberDto, @Req() req: Request) {
    const actorId = (req as any).user.userId;
    return this.svc.add(projectId, actorId, dto);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Patch(':memberId/role')
  updateRole(
    @Param('projectId') projectId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.userId;
    return this.svc.updateRole(projectId, memberId, dto.role, actorId);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Delete(':memberId')
  remove(@Param('projectId') projectId: string, @Param('memberId') memberId: string, @Req() req: Request) {
    const actorId = (req as any).user.userId;
    return this.svc.remove(projectId, memberId, actorId);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Get('/search')
  search(@Param('projectId') projectId: string, @Query('q') q = '') {
    return this.svc.searchUsersInWorkspace(projectId, q);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Get('/audit')
  audit(@Param('projectId') projectId: string) {
    return this.svc.audit(projectId);
  }
}
