import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PrismaService } from '../prisma/prisma.service';
import { MockLlmProvider } from './providers/mock.provider';
import { JwtAuthGuard } from 'src/auth/guards';
@Module({
  controllers: [AiController],
  providers: [
    AiService,
    PrismaService,
    { provide: 'LlmProvider', useClass: MockLlmProvider },
    JwtAuthGuard,
  ],
})
export class AiModule {}
