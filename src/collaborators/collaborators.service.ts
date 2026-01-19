import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CollaboratorsService {
  constructor(private prisma: PrismaService) {}

  async list(projectId: string) {
    const rows = await this.prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { addedAt: 'asc' },
      select: {
        id: true, role: true, addedAt: true,
        user: { select: { id: true, email: true, name: true, status: true, avatarUrl: true } },
      },
    });
    return rows;
  }

  private async ensureNotLastOwner(projectId: string, memberIdOrUserId: { memberId?: string; userId?: string }) {
    const owners = await this.prisma.projectMember.findMany({
      where: { projectId, role: 'OWNER' },
      select: { id: true, userId: true },
    });
    if (owners.length <= 1) {
      // ¿estoy tocando al único owner?
      const only = owners[0];
      if (only && (only.id === memberIdOrUserId.memberId || only.userId === memberIdOrUserId.userId)) {
        throw new BadRequestException('Debe existir al menos un propietario en el proyecto');
      }
    }
  }

  async add(projectId: string, actorId: string, dto: { role: 'OWNER'|'EDITOR'|'READER'; userId?: string; email?: string }) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt) throw new NotFoundException('Proyecto no encontrado');

    let userId = dto.userId;

    // resolver por email si no hay userId
    if (!userId && dto.email) {
      const email = dto.email.toLowerCase();
      let u = await this.prisma.user.findUnique({ where: { email } });
      if (!u) {
        // crear usuario INVITED
        u = await this.prisma.user.create({ data: { email, status: 'INVITED' } });
      }
      userId = u.id;
    }
    if (!userId) throw new BadRequestException('Debe enviar userId o email');

    // ¿ya es miembro?
    const dup = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (dup) throw new ConflictException('El usuario ya es colaborador del proyecto');

    // (opcional): asegurar que está en el workspace como MEMBER
    const wsMember = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    });
    if (!wsMember) {
      await this.prisma.workspaceMember.create({
        data: { workspaceId: project.workspaceId, userId, role: 'MEMBER' },
      });
    }

    const mem = await this.prisma.projectMember.create({
      data: { projectId, userId, role: dto.role },
    });

    await this.prisma.auditLog.create({
      data: { projectId, actorId, action: 'MEMBER_ADD', targetType: 'ProjectMember', targetId: mem.id, metadata: { role: dto.role, userId } },
    });

    return this.list(projectId);
  }

  async updateRole(projectId: string, memberId: string, newRole: 'OWNER'|'EDITOR'|'READER', actorId: string) {
    const m = await this.prisma.projectMember.findUnique({ where: { id: memberId } });
    if (!m || m.projectId !== projectId) throw new NotFoundException('Miembro no encontrado');

    // si degradamos a un OWNER, chequear que no sea el único
    if (m.role === 'OWNER' && newRole !== 'OWNER') {
      await this.ensureNotLastOwner(projectId, { memberId });
    }

    const updated = await this.prisma.projectMember.update({
      where: { id: memberId },
      data: { role: newRole },
    });

    await this.prisma.auditLog.create({
      data: { projectId, actorId, action: 'MEMBER_UPDATE', targetType: 'ProjectMember', targetId: memberId, metadata: { from: m.role, to: newRole } },
    });

    return updated;
  }

  async remove(projectId: string, memberId: string, actorId: string) {
    const m = await this.prisma.projectMember.findUnique({ where: { id: memberId } });
    if (!m || m.projectId !== projectId) throw new NotFoundException('Miembro no encontrado');

    if (m.role === 'OWNER') {
      await this.ensureNotLastOwner(projectId, { memberId });
    }

    await this.prisma.projectMember.delete({ where: { id: memberId } });

    await this.prisma.auditLog.create({
      data: { projectId, actorId, action: 'MEMBER_REMOVE', targetType: 'ProjectMember', targetId: memberId },
    });

    return { ok: true };
  }

  async audit(projectId: string) {
    return this.prisma.auditLog.findMany({
      where: { projectId, action: { in: ['MEMBER_ADD','MEMBER_UPDATE','MEMBER_REMOVE'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // buscar usuarios del mismo workspace (por nombre/email)
  async searchUsersInWorkspace(projectId: string, q: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Proyecto no encontrado');
    const wsm = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: project.workspaceId, user: { OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { name:  { contains: q, mode: 'insensitive' } },
      ]}},
      select: { user: { select: { id: true, email: true, name: true, status: true } } },
      take: 20,
    });
    // excluir ya miembros del proyecto
    const existingIds = new Set((await this.prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } })).map(x => x.userId));
    return wsm.map(x => x.user).filter(u => !existingIds.has(u.id));
  }
}
