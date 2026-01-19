import { Module } from '@nestjs/common';
import { UmlVisionService } from './uml-vision.service';
import { UmlVisionController } from './uml-vision.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ModelsModule } from '../models/models.module';

@Module({
  imports: [PrismaModule, ModelsModule],
  controllers: [UmlVisionController],
  providers: [UmlVisionService],
})
export class UmlVisionModule {}
