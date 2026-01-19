import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards';
import { UmlVisionService } from './uml-vision.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModelsService } from '../models/models.service';
import type { DSL } from './uml-vision.service';

@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/uml')
export class UmlVisionController {
  constructor(
    private readonly svc: UmlVisionService,
    private readonly prisma: PrismaService,
    private readonly models: ModelsService,
  ) {}

  // ---------- PREVISUALIZACIÓN (no guarda versión, sí guarda la imagen como Artifact) ----------
  @Post('parse-image')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!/^image\/(png|jpe?g|bmp|gif|webp)$/i.test(file.mimetype)) {
          return cb(
            new BadRequestException('Formato de imagen no soportado'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async parseImage(
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Falta archivo');

    const res = await this.svc.parseImage(file.buffer); // { dsl, ocrText, stats }

    const storageKey = await this.saveLocal(
      `imports/${projectId}/${Date.now()}_${file.originalname}`,
      file.buffer,
    );

    const artifact = await this.prisma.artifact.create({
      data: {
        projectId,
        type: 'OTHER', // si amplías el enum: UML_IMAGE
        storageBucket: 'local',
        storageKey,
        metadata: {
          kind: 'UML_IMAGE_IMPORT',
          filename: file.originalname,
          stats: res.stats, // JSON (no string)
          ocrText: res.ocrText?.slice(0, 8000), // auditoría
        },
      },
      select: { id: true, storageKey: true },
    });

    return { artifactId: artifact.id, ...res };
  }

  // ---------- IMPORTACIÓN (fusiona/reemplaza DSL y crea nueva versión; guarda imagen como Artifact asociado) ----------
  @Post('import-image')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!/^image\/(png|jpe?g|bmp|gif|webp)$/i.test(file.mimetype)) {
          return cb(
            new BadRequestException('Formato de imagen no soportado'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async importImage(
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: { branchId?: string; merge?: 'merge' | 'replace'; message?: string },
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException('Falta archivo');

    const userId =
      ((req as any).user?.userId as string) ||
      ((req as any).user?.sub as string);

    // 1) OCR -> DSL
    const { dsl, ocrText, stats } = await this.svc.parseImage(file.buffer);

    // 2) Resolver rama actual
    const current = await this.models.getCurrent(
      projectId,
      userId,
      body.branchId,
    );
    const branchId =
      (current as any)?.branchId ??
      (current as any)?.branch?.id ??
      body.branchId;

    if (!branchId) {
      throw new BadRequestException('No se pudo resolver la rama (branchId).');
    }

    // 3) Merge/Reemplazo del DSL
    let merged: DSL = dsl;
    if (body.merge !== 'replace' && (current as any)?.content) {
      merged = this.mergeDsl((current as any).content as DSL, dsl);
    }

    // 4) Guardar versión
    const saved = await this.models.saveNewVersion(projectId, userId, {
      branchId,
      message: body.message || 'import: imagen UML',
      content: merged,
    } as any);

    const versionId = (saved as any).versionId ?? (saved as any).id;

    // 5) Guardar imagen como Artifact asociado a la versión
    const storageKey = await this.saveLocal(
      `imports/${projectId}/${versionId}_${file.originalname}`,
      file.buffer,
    );

    await this.prisma.artifact.create({
      data: {
        projectId,
        modelVersionId: versionId,
        type: 'OTHER',
        storageBucket: 'local',
        storageKey,
        metadata: {
          kind: 'UML_IMAGE_IMPORT',
          filename: file.originalname,
          stats, // JSON (no string)
          ocrText: ocrText?.slice(0, 8000),
        },
      },
    });

    return {
      versionId,
      branchId,
      stats,
      insertedEntities: dsl.entities.length,
      mergedEntities: merged.entities.length,
      mergedRelations: merged.relations.length,
    };
  }

  // ---------- util: persistir archivo localmente ----------
  private async saveLocal(rel: string, buf: Buffer): Promise<string> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const full = path.join(process.cwd(), 'storage', rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
    return rel;
  }

  // ---------- merge ingenuo por nombre + dedup de relaciones considerando cardinalidades y via ----------
  private mergeDsl(base: DSL, inc: DSL): DSL {
    const entities = [...(base.entities || [])];

    for (const e of inc.entities || []) {
      const target = entities.find(
        (x) => x.name.toLowerCase() === e.name.toLowerCase(),
      );
      if (!target) {
        entities.push(e);
      } else {
        target.stereotype ||= e.stereotype;
        (target as any).isInterface ||= (e as any).isInterface;
        (target as any).isAbstract ||= (e as any).isAbstract;

        target.attrs ||= [];
        for (const a of e.attrs || []) {
          if (
            !target.attrs.some(
              (x) => x.name.toLowerCase() === a.name.toLowerCase(),
            )
          ) {
            target.attrs.push(a);
          }
        }
      }
    }

    const rels = [...(base.relations || [])];
    for (const r of inc.relations || []) {
      const exists = rels.some(
        (x) =>
          x.from === r.from &&
          x.to === r.to &&
          x.kind === r.kind &&
          (x.fromCard ?? '') === (r.fromCard ?? '') &&
          (x.toCard ?? '') === (r.toCard ?? '') &&
          (x.via ?? '') === (r.via ?? ''),
      );
      if (!exists) rels.push(r);
    }

    return { entities, relations: rels, constraints: base.constraints || [] };
  }
}
