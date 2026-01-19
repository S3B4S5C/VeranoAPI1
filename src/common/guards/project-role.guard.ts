import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { PROJECT_ROLES_KEY } from '../decorators/roles';

@Injectable()
export class ProjectRoleGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.get<Array<'OWNER'|'EDITOR'|'READER'>>(PROJECT_ROLES_KEY, ctx.getHandler()) ?? [];
    if (roles.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const userId = req.user?.userId;
    if (!userId) throw new ForbiddenException('No autenticado');

    // Obtén projectId del path, query o body (ajusta según tu ruta)
    const projectId = req.params.projectId || req.query.projectId || req.body.projectId;
    if (!projectId) throw new ForbiddenException('projectId requerido');

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });

    if (!membership) throw new ForbiddenException('Sin acceso a este proyecto');

    // Regla: OWNER >= EDITOR >= READER
    const order = { OWNER: 3, EDITOR: 2, READER: 1 } as const;
    const min = Math.max(...roles.map(r => order[r]));
    if (order[membership.role] >= min) return true;

    throw new ForbiddenException('Rol insuficiente');
  }
}
