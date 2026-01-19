import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';
import { WorkspaceRoleGuard } from '../common/guards/workspace-role.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectRoleGuard, WorkspaceRoleGuard],
})
export class ProjectsModule {}
