import { Module } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ValidationController } from './validation.controller';
import { ValidationService } from './validation.service';
import { JwtAuthGuard } from 'src/auth/guards';

@Module({
  controllers: [ValidationController],
  providers: [ValidationService, PrismaService, JwtAuthGuard],
})
export class ValidationModule {}
