import { Body, Controller, Get, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards';
import { CodegenService, GenerateDto } from './codegen.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/artifacts')
export class CodegenController {
  constructor(private svc: CodegenService, private prisma: PrismaService) { }

  @Post('generate')
  async generate(
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    console.log(body)
    return this.svc.generateArtifacts(projectId, body);
  }

  @Get()
  async list(@Param('projectId') projectId: string) {
    const rows = await this.prisma.artifact.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, type: true, createdAt: true,
        storageBucket: true, storageKey: true,
        sizeBytes: true, checksumSha256: true,
        codegenConfigId: true, modelVersionId: true,
      },
    });

    // 👇 convierte BigInt a string (o a Number si prefieres)
    return rows.map((r) => ({
      ...r,
      sizeBytes: r.sizeBytes == null ? null : r.sizeBytes.toString(),
    }));
  }

  @Get(':artifactId/download')
  async download(
    @Param('projectId') projectId: string,
    @Param('artifactId') artifactId: string,
    @Res() res: Response,
  ) {
    const a = await this.prisma.artifact.findFirst({ where: { id: artifactId, projectId } });
    if (!a) throw new NotFoundException('Artifact not found');
    if (a.storageBucket !== 'local') throw new NotFoundException('Unsupported storage');

    res.download(`storage/${a.storageKey}`);
  }
}
