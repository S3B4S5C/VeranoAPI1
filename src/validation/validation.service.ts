import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

type Issue = {
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  location?: string;
};
type Report = { errors: Issue[]; warnings: Issue[] };

@Injectable()
export class ValidationService {
  constructor(private prisma: PrismaService) {}

  listRuns(projectId: string) {
    return this.prisma.validationRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRun(projectId: string, runId: string) {
    const run = await this.prisma.validationRun.findFirst({
      where: { id: runId, projectId },
    });
    if (!run) throw new NotFoundException('ValidationRun no existe');
    return run;
  }

  async run(
    projectId: string,
    modelVersionId: string,
    userId: string,
    timeoutMs = 15000,
  ) {
    const version = await this.prisma.modelVersion.findFirst({
      where: { id: modelVersionId, projectId },
    });
    if (!version) throw new NotFoundException('ModelVersion no existe');

    // Crear en QUEUED
    const run = await this.prisma.validationRun.create({
      data: {
        projectId,
        modelVersionId,
        createdById: userId,
        status: 'QUEUED',
      },
    });

    // Pasar a RUNNING
    await this.prisma.validationRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING' },
    });

    try {
      // ⬇️ NO usamos async aquí; withTimeout acepta sync o async.
      const report = await withTimeout(
        () => this.validate(version.content as any),
        timeoutMs,
      );

      await this.prisma.validationRun.update({
        where: { id: run.id },
        data: { status: 'SUCCEEDED', report, finishedAt: new Date() },
      });

      await this.prisma.auditLog.create({
        data: {
          projectId,
          actorId: userId,
          action: 'VALIDATION_RUN',
          targetType: 'ValidationRun',
          targetId: run.id,
          metadata: {
            errors: report.errors.length,
            warnings: report.warnings.length,
            modelVersionId,
          },
        },
      });

      return { id: run.id, status: 'SUCCEEDED', report };
    } catch (e: any) {
      const isTimeout = e?.code === 'ETIMEDOUT';
      await this.prisma.validationRun.update({
        where: { id: run.id },
        data: {
          status: isTimeout ? 'TIMED_OUT' : 'FAILED',
          report: isTimeout
            ? { error: 'Timeout' }
            : { error: String(e?.message || e) },
          finishedAt: new Date(),
        },
      });
      throw e;
    }
  }

  async cancel(projectId: string, runId: string, userId: string) {
    const run = await this.prisma.validationRun.findFirst({
      where: { id: runId, projectId },
    });
    if (!run) throw new NotFoundException('ValidationRun no existe');
    if (!['QUEUED', 'RUNNING'].includes(run.status as any)) {
      return { ok: false, reason: 'No cancelable' };
    }
    await this.prisma.validationRun.update({
      where: { id: runId },
      data: {
        status: 'CANCELED',
        finishedAt: new Date(),
        report: { canceledBy: userId },
      },
    });
    return { ok: true, status: 'CANCELED' };
  }

  /** Reglas determinísticas mínimas (extensibles a 2NF/3NF/BCNF) */
  private validate(dsl: any): Report {
    const errors: Issue[] = [];
    const warnings: Issue[] = [];

    // 1) PK en cada entidad
    for (const e of dsl.entities ?? []) {
      const hasPk = (e.attrs ?? []).some(
        (a: any) => a.pk || a.name?.toLowerCase() === 'id',
      );
      if (!hasPk) {
        errors.push({
          code: 'MISSING_PK',
          severity: 'ERROR',
          message: `La entidad ${e.name} no tiene PK`,
          location: `/entities[name=${e.name}]`,
        });
      }
    }

    // 2) Cardinalidades válidas
    for (const r of dsl.relations ?? []) {
      const joined = `${r.fromCard}:${r.toCard}`;
      const ok = [
        '1:1',
        '1:N',
        'N:1',
        'N:N',
        'undefined:undefined',
        'undefined:1',
        '1:undefined',
      ].includes(joined);
      if (!ok) {
        errors.push({
          code: 'CARDINALITY_INVALID',
          severity: 'ERROR',
          message: `Cardinalidad inválida en ${r.from}→${r.to}`,
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
    }

    // 3) 1NF: atributos atómicos
    for (const e of dsl.entities ?? []) {
      for (const a of e.attrs ?? []) {
        const t = a.type;
        if (Array.isArray(t) || (typeof t === 'object' && t?.compound)) {
          warnings.push({
            code: 'NF1_VIOLATION',
            severity: 'WARNING',
            message: `Atributo no atómico ${e.name}.${a.name}`,
            location: `/entities[name=${e.name}]/attrs[name=${a.name}]`,
          });
        }
      }
    }

    return { errors, warnings };
  }
}

/**
 * Envuelve una función (sincrónica o asíncrona) con timeout.
 * - Rechaza SIEMPRE con un Error (regla prefer-promise-reject-errors)
 * - Marca error con code = 'ETIMEDOUT'
 */
function withTimeout<T>(
  fn: () => Promise<T> | T,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('Timeout');
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    Promise.resolve()
      .then(fn)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        // garantizar que sea un Error
        reject(
          err instanceof Error
            ? err
            : new Error(typeof err === 'string' ? err : JSON.stringify(err)),
        );
      });
  });
}
