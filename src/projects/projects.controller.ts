// src/projects/projects.controller.ts
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, Req,
} from '@nestjs/common';
import type { Request } from 'express' // si usas Fastify, puedes omitir el tipo
import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../auth/guards';
import { RequireWorkspaceRole } from '../common/decorators/workspace-role';
import { WorkspaceRoleGuard } from '../common/guards/workspace-role.guard';
import { RequireProjectRole } from '../common/decorators/roles';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@UseGuards(JwtAuthGuard) // 👈 garantiza req.user
@Controller('projects')
export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  @Get()
  list(@Query('workspaceId') workspaceId: string, @Req() req: Request) { // 👈 añade @Req()
    const userId = (req as any).user.userId;
    return this.svc.listAccessible(userId, workspaceId);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {                   // 👈 añade @Req()
    const userId = (req as any).user.userId;
    return this.svc.getByIdAuthorized(id, userId);
  }

  @UseGuards(WorkspaceRoleGuard)
  @RequireWorkspaceRole('OWNER','ADMIN')
  @Post('/workspace/:workspaceId')
  createInWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateProjectDto,
    @Req() req: Request,                                                 // 👈 añade @Req()
  ) {
    const userId = (req as any).user.userId;
    return this.svc.create(workspaceId, userId, dto);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Patch(':projectId')
  update(@Param('projectId') id: string, @Body() dto: UpdateProjectDto, @Req() req: Request) {
    const userId = (req as any).user.userId;
    return this.svc.updateMetadata(id, userId, dto);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Post(':projectId/archive')
  archive(@Param('projectId') id: string, @Req() req: Request) {
    return this.svc.archive(id, (req as any).user.userId);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Post(':projectId/restore')
  restore(@Param('projectId') id: string, @Req() req: Request) {
    return this.svc.restore(id, (req as any).user.userId);
  }

  @UseGuards(ProjectRoleGuard)
  @RequireProjectRole('OWNER')
  @Delete(':projectId')
  remove(@Param('projectId') id: string, @Req() req: Request) {
    return this.svc.softDelete(id, (req as any).user.userId);
  }
}
