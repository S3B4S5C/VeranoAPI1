import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { WORKSPACE_ROLES_KEY } from '../decorators/workspace-role';

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const roles = this.reflector.get<Array<'OWNER'|'ADMIN'|'MEMBER'>>(WORKSPACE_ROLES_KEY, ctx.getHandler()) ?? [];
    if (roles.length === 0) return true;

    const userId = req.user?.userId;
    if (!userId) throw new ForbiddenException('No autenticado');

    // workspaceId puede venir en params o body (creación)
    const workspaceId = req.params.workspaceId || req.body.workspaceId;
    if (!workspaceId) throw new ForbiddenException('workspaceId requerido');

    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!m) throw new ForbiddenException('Sin acceso al workspace');

    const order = { OWNER: 3, ADMIN: 2, MEMBER: 1 } as const;
    const min = Math.max(...roles.map(r => order[r]));
    if (order[m.role] >= min) return true;

    throw new ForbiddenException('Rol insuficiente en workspace');
  }
}
