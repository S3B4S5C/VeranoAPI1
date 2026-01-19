import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards';
import { AiService } from './ai.service';

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/ai')
export class AiController {
  constructor(private readonly svc: AiService) {}

  @Get('suggestions')
  list(@Param('projectId') projectId: string) {
    return this.svc.list(projectId);
  }

  @Post('suggestions')
  request(
    @Param('projectId') projectId: string,
    @Body()
    body: {
      modelVersionId: string;
      scope?: 'ALL' | 'CLASSES' | 'RELATIONSHIPS' | 'ATTRIBUTES' | 'DATATYPES';
      promptHints?: string;
    },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId as string;
    return this.svc.request(
      projectId,
      body.modelVersionId,
      userId,
      body.scope,
      body.promptHints,
    );
  }

  @Post('suggestions/:sid/apply')
  apply(
    @Param('projectId') projectId: string,
    @Param('sid') sid: string,
    @Body() body: { includePaths?: string[] },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId as string;
    return this.svc.apply(projectId, sid, userId, body.includePaths);
  }

  @Post('suggestions/:sid/reject')
  reject(
    @Param('projectId') projectId: string,
    @Param('sid') sid: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId as string;
    return this.svc.reject(projectId, sid, userId);
  }
}
