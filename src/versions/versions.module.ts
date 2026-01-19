import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VersionsService } from './versions.service';
import { VersionsController } from './versions.controller';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';

@Module({
  imports: [PrismaModule],
  providers: [VersionsService, ProjectRoleGuard],
  controllers: [VersionsController],
})
export class VersionsModule {}
