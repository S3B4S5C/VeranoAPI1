import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ModelsService } from './models.service';
import { ModelsController } from './models.controller';
import { ProjectRoleGuard } from '../common/guards/project-role.guard';

@Module({
  imports: [PrismaModule],
  providers: [ModelsService, ProjectRoleGuard],
  controllers: [ModelsController],
  exports: [ModelsService],
})
export class ModelsModule {}
