import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  // ----- Utilitarios -----
  private async ensureTags(workspaceId: string, names: string[]) {
    if (!names?.length) return [];
    // Upsert por tag (unique: [workspaceId, name])
    const upserts = names.map(name =>
      this.prisma.tag.upsert({
        where: { workspaceId_name: { workspaceId, name } },
        update: {},
        create: { workspaceId, name },
        select: { id: true, name: true },
      })
    );
    return Promise.all(upserts);
  }

  private async syncProjectTags(projectId: string, workspaceId: string, names: string[] = []) {
    // Trae actuales
    const current = await this.prisma.projectTag.findMany({
      where: { projectId },
      select: { tagId: true, tag: { select: { name: true } } },
    });
    const currentNames = new Set(current.map(c => c.tag.name));
    const targetNames = Array.from(new Set(names.map(n => n.trim()).filter(Boolean)));
    // Crea/asegura tags
    const ensured = await this.ensureTags(workspaceId, targetNames);
    const targetIds = new Set(ensured.map(e => e.id));

    // Elimina relaciones sobrantes
    await this.prisma.projectTag.deleteMany({
      where: { projectId, tagId: { notIn: Array.from(targetIds) } },
    });

    // Crea relaciones faltantes
    const toCreate = ensured
      .filter(e => !current.find(c => c.tagId === e.id))
      .map(e => ({ projectId, tagId: e.id }));

    if (toCreate.length) {
      await this.prisma.projectTag.createMany({ data: toCreate, skipDuplicates: true });
    }
  }

  private async checkWorkspaceQuota(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const maxProjects = (ws?.settings as any)?.maxProjects as number | undefined;
    if (!maxProjects) return; // sin límite
    const count = await this.prisma.project.count({ where: { workspaceId, deletedAt: null } });
    if (count >= maxProjects) throw new ForbiddenException('Cuota de proyectos excedida en el workspace');
  }

  private async audit(projectId: string | null, workspaceId: string | null, actorId: string | null, action: string, targetType: string, targetId: string | null, metadata?: any) {
    await this.prisma.auditLog.create({
      data: { projectId, workspaceId, actorId, action: action as any, targetType, targetId, metadata },
    });
  }

  // ----- Casos de uso -----
  async listAccessible(userId: string, workspaceId?: string) {
    // Miembro de proyecto o (si workspaceId) OWNER/ADMIN del workspace ve todo en ese workspace
    if (workspaceId) {
      const wsMember = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true },
      });
      if (wsMember && (wsMember.role === 'OWNER' || wsMember.role === 'ADMIN')) {
        return this.prisma.project.findMany({
          where: { workspaceId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          include: { tags: { include: { tag: true } } },
        });
      }
      // Si no es OWNER/ADMIN, filtra por membresía del proyecto
      return this.prisma.project.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          members: { some: { userId } },
        },
        orderBy: { createdAt: 'desc' },
        include: { tags: { include: { tag: true } } },
      });
    }

    // Sin workspaceId: todos los proyectos donde soy miembro
    return this.prisma.project.findMany({
      where: { deletedAt: null, members: { some: { userId } } },
      orderBy: { createdAt: 'desc' },
      include: { tags: { include: { tag: true } } },
    });
  }

  async getByIdAuthorized(projectId: string, userId: string) {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { where: { userId }, select: { role: true } },
        tags: { include: { tag: true } },
      },
    });
    if (!p || p.deletedAt) throw new NotFoundException('Proyecto no encontrado');
    if (p.members.length === 0) throw new ForbiddenException('Sin acceso a este proyecto');
    return p;
  }

  async create(workspaceId: string, userId: string, dto: { name: string; description?: string; tags?: string[] }) {
    await this.checkWorkspaceQuota(workspaceId);
    // Debe venir del guard de workspace (OWNER/ADMIN). Aquí sólo hacemos la operación.
    try {
      const project = await this.prisma.project.create({
        data: {
          workspaceId,
          name: dto.name.trim(),
          description: dto.description ?? null,
          createdById: userId,
          members: { create: { userId, role: 'OWNER' } }, // el creador es OWNER
        },
      });
      await this.syncProjectTags(project.id, workspaceId, dto.tags ?? []);
      await this.audit(project.id, workspaceId, userId, 'PROJECT_CREATE', 'Project', project.id, { name: project.name });
      return this.prisma.project.findUnique({
        where: { id: project.id },
        include: { tags: { include: { tag: true } } },
      });
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('Ya existe un proyecto con ese nombre en el workspace');
      throw e;
    }
  }

  async updateMetadata(projectId: string, userId: string, dto: { name?: string; description?: string; tags?: string[] }) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt) throw new NotFoundException('Proyecto no encontrado');

    // El permiso OWNER ya se valida en el guard de proyecto.
    try {
      const updated = await this.prisma.project.update({
        where: { id: projectId },
        data: {
          name: dto.name?.trim(),
          description: dto.description ?? undefined,
        },
      });
      if (dto.tags) {
        await this.syncProjectTags(projectId, updated.workspaceId, dto.tags);
      }
      await this.audit(projectId, updated.workspaceId, userId, 'PROJECT_UPDATE', 'Project', projectId, dto);
      return this.prisma.project.findUnique({
        where: { id: projectId },
        include: { tags: { include: { tag: true } } },
      });
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('Nombre duplicado en el workspace');
      throw e;
    }
  }

  async archive(projectId: string, userId: string) {
    const p = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await this.audit(projectId, p.workspaceId, userId, 'PROJECT_ARCHIVE', 'Project', projectId);
    return p;
  }

  async restore(projectId: string, userId: string) {
    const p = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'ACTIVE', archivedAt: null },
    });
    await this.audit(projectId, p.workspaceId, userId, 'PROJECT_RESTORE', 'Project', projectId);
    return p;
  }

  async softDelete(projectId: string, userId: string) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p || p.deletedAt) throw new NotFoundException('Proyecto no encontrado');
    if (p.legalHold) throw new BadRequestException('El proyecto está bajo retención legal');

    const del = await this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
    await this.audit(projectId, del.workspaceId, userId, 'PROJECT_DELETE', 'Project', projectId);
    return del;
  }
}
