import { Module } from '@nestjs/common';
import { CodegenService } from './codegen.service';
import { CodegenController } from './codegen.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [PrismaModule, JwtModule.register({})],
  providers: [CodegenService],
  controllers: [CodegenController],
  exports: [CodegenService],
})
export class CodegenModule {}
