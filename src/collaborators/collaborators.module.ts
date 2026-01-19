import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CollaboratorsService } from './collaborators.service';
import { CollaboratorsController } from './collaborators.controller';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';

@Module({
  imports: [PrismaModule],
  providers: [CollaboratorsService, ProjectRoleGuard],
  controllers: [CollaboratorsController],
})
export class CollaboratorsModule {}
