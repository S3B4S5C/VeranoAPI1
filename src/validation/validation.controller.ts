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
import { JwtAuthGuard } from 'src/auth/guards';

import { ValidationService } from './validation.service';

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/validation')
export class ValidationController {
  constructor(private readonly svc: ValidationService) {}

  @Get('runs')
  list(@Param('projectId') projectId: string) {
    return this.svc.listRuns(projectId);
  }

  @Get('runs/:runId')
  get(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.svc.getRun(projectId, runId);
  }

  @Post('runs')
  run(
    @Param('projectId') projectId: string,
    @Body() body: { modelVersionId: string; timeoutMs?: number },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId as string;
    return this.svc.run(projectId, body.modelVersionId, userId, body.timeoutMs);
  }

  @Post('runs/:runId/cancel')
  cancel(
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).user.userId as string;
    return this.svc.cancel(projectId, runId, userId);
  }
}
