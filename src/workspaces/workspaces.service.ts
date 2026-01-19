import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(private prisma: PrismaService) {}

  async listForUser(userId: string) {
    const rows = await this.prisma.workspace.findMany({
      where: { members: { some: { userId } } },
      select: {
        id: true, name: true, slug: true, description: true, createdAt: true,
        members: { where: { userId }, select: { role: true } },
        _count: { select: { projects: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      role: r.members[0]?.role ?? 'MEMBER',
      projectCount: r._count.projects,
    }));
  }
}
