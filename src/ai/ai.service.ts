import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { LlmProvider } from './llm.provider';
import { applyNamedJsonPatch } from '../common/json-patch-selectors';

@Injectable()
export class AiService {
  constructor(
    private prisma: PrismaService,
    @Inject('LlmProvider') private llm: LlmProvider,
  ) {}

  list(projectId: string) {
    return this.prisma.aiSuggestion.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async request(
    projectId: string,
    modelVersionId: string,
    userId: string,
    scope?: any,
    promptHints?: string,
  ) {
    const base = await this.prisma.modelVersion.findFirst({
      where: { id: modelVersionId, projectId },
    });
    if (!base) throw new NotFoundException('ModelVersion no existe');

    const { rationale, patch } = await this.llm.suggest({
      model: base.content,
      scope,
      promptHints,
    });

    const sug = await this.prisma.aiSuggestion.create({
      data: {
        projectId,
        modelVersionId,
        requestedById: userId,
        status: 'PENDING',
        rationale,
        proposedPatch: patch,
      },
    });

    const preview = applyNamedJsonPatch(
      base.content as any,
      Array.isArray(patch) ? patch : [],
    );
    return {
      suggestion: sug,
      previewDiff: { from: base.content, to: preview },
    };
  }

  async apply(
    projectId: string,
    sid: string,
    userId: string,
    includePaths?: string[],
  ) {
    const sug = await this.prisma.aiSuggestion.findFirst({
      where: { id: sid, projectId },
    });
    if (!sug) throw new NotFoundException('Sugerencia no existe');

    const base = await this.prisma.modelVersion.findFirst({
      where: { id: sug.modelVersionId },
    });
    if (!base) throw new NotFoundException('ModelVersion base no existe');

    let patch: any[] = Array.isArray(sug.proposedPatch)
      ? (sug.proposedPatch as any[])
      : legacyToPatch(sug.proposedPatch);

    if (includePaths?.length) {
      const set = new Set(includePaths);
      patch = patch.filter(
        (op) =>
          set.has(op.path) || [...set].some((p) => op.path.startsWith(p + '/')),
      );
    }

    const appliedModel = applyNamedJsonPatch(base.content as any, patch);

    const newVersion = await this.prisma.modelVersion.create({
      data: {
        projectId,
        branchId: base.branchId,
        parentVersionId: base.id,
        authorId: userId,
        message: `Apply AI suggestion ${sid}${includePaths?.length ? ' (partial)' : ''}`,
        content: appliedModel as any,
      },
    });

    await this.prisma.aiSuggestion.update({
      where: { id: sid },
      data: {
        status: 'APPLIED',
        appliedById: userId,
        appliedVersionId: newVersion.id,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        projectId,
        actorId: userId,
        action: 'AI_SUGGESTION_APPLY',
        targetType: 'ModelVersion',
        targetId: newVersion.id,
        metadata: {
          suggestionId: sid,
          baseVersionId: base.id,
          includePaths: includePaths ?? 'ALL',
        },
      },
    });

    return { appliedVersionId: newVersion.id };
  }

  async reject(projectId: string, sid: string, userId: string) {
    await this.prisma.aiSuggestion.update({
      where: { id: sid },
      data: { status: 'REJECTED' },
    });
    await this.prisma.auditLog.create({
      data: {
        projectId,
        actorId: userId,
        action: 'AI_SUGGESTION_REJECT',
        targetType: 'AiSuggestion',
        targetId: sid,
      },
    });
    return { status: 'REJECTED' };
  }
}

function legacyToPatch(proposed: any): any[] {
  const ops: any[] = [];
  if (proposed?.addEntity) {
    ops.push({
      op: 'add',
      path: '/entities/-',
      value: {
        name: proposed.addEntity,
        attrs: [{ name: 'id', type: 'uuid', pk: true }],
      },
    });
  }
  if (proposed?.addRelation) {
    const [from, to] = String(proposed.addRelation).split('→');
    ops.push({
      op: 'add',
      path: '/relations/-',
      value: { from, to, kind: 'association', fromCard: 'N', toCard: '1' },
    });
  }
  if (proposed?.addAttr) {
    const [cls, attr] = String(proposed.addAttr).split('.');
    ops.push({
      op: 'add',
      path: `/entities[name=${cls}]/attrs/-`,
      value: { name: attr, type: 'string' },
    });
  }
  return ops;
}
