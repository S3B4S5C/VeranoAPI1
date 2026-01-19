import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type Attr = { name: string; type: string; pk?: boolean; unique?: boolean; nullable?: boolean };
type Entity = { name: string; stereotype?: string; attrs: Attr[] };
type Relation = { from: string; to: string; kind: 'association'|'aggregation'|'composition'; fromCard?: string; toCard?: string };
type DSL = { entities: Entity[]; relations: Relation[]; constraints?: any[] };

@Injectable()
export class VersionsService {
  constructor(private prisma: PrismaService) {}

  // ---------- BRANCHES ----------
  async listBranches(projectId: string) {
    const branches = await this.prisma.branch.findMany({
      where: { projectId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true, name: true, isDefault: true, createdAt: true,
        versions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, createdAt: true, message: true } },
      },
    });
    return branches.map(b => ({ ...b, latestVersion: b.versions[0] ?? null, versions: undefined }));
  }

  async createBranch(projectId: string, userId: string, name: string, fromVersionId?: string) {
    if (!name?.trim()) throw new BadRequestException('Nombre de rama requerido');
    const created = await this.prisma.branch.create({
      data: { projectId, name: name.trim(), isDefault: false, createdById: userId },
    });
    // Si se indicó una versión, crea un snapshot inicial en la nueva rama con ese contenido
    if (fromVersionId) {
      const base = await this.prisma.modelVersion.findFirst({ where: { id: fromVersionId, projectId } });
      if (!base) throw new NotFoundException('Versión base no encontrada');
      await this.prisma.modelVersion.create({
        data: {
          projectId, branchId: created.id, authorId: userId,
          parentVersionId: base.id, message: `branch: ${name} from ${base.id.slice(0,7)}`,
          content: base.content as any,
        },
      });
    }
    await this.prisma.auditLog.create({
      data: { projectId, actorId: userId, action: 'BRANCH_CREATE', targetType: 'Branch', targetId: created.id, metadata: { name } },
    });
    return created;
  }

  async listVersions(projectId: string, branchId: string, take = 50) {
    return this.prisma.modelVersion.findMany({
      where: { projectId, branchId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, createdAt: true, message: true, author: { select: { id: true, email: true, name: true } } },
    });
  }

  // ---------- DIFF ----------
  private indexByName<T extends { name: string }>(arr: T[]) {
    const m = new Map<string, T>();
    for (const it of arr) m.set(it.name, it);
    return m;
  }
  private sameAttr(a: Attr, b: Attr) {
    return a.name === b.name && a.type === b.type && !!a.pk === !!b.pk && !!a.unique === !!b.unique && !!a.nullable === !!b.nullable;
  }
  private diffEntities(a: Entity[], b: Entity[]) {
    const A = this.indexByName(a), B = this.indexByName(b);
    const added: Entity[] = [], removed: Entity[] = [], changed: any[] = [];
    for (const [name, eA] of A) {
      if (!B.has(name)) removed.push(eA);
      else {
        const eB = B.get(name)!;
        const attrsA = this.indexByName(eA.attrs ?? []), attrsB = this.indexByName(eB.attrs ?? []);
        const attrAdded: Attr[] = [], attrRemoved: Attr[] = [], attrChanged: any[] = [];
        for (const [an, atA] of attrsA) {
          if (!attrsB.has(an)) attrRemoved.push(atA);
          else {
            const atB = attrsB.get(an)!;
            if (!this.sameAttr(atA, atB)) attrChanged.push({ name: an, from: atA, to: atB });
          }
        }
        for (const [an, atB] of attrsB) if (!attrsA.has(an)) attrAdded.push(atB);
        if (eA.stereotype !== eB.stereotype || attrAdded.length || attrRemoved.length || attrChanged.length) {
          changed.push({ name, stereotype: { from: eA.stereotype, to: eB.stereotype }, attrAdded, attrRemoved, attrChanged });
        }
      }
    }
    for (const [name, eB] of B) if (!A.has(name)) added.push(eB);
    return { added, removed, changed };
  }
  private keyRel(r: Relation) { return `${r.from}::${r.to}`; }
  private diffRelations(a: Relation[], b: Relation[]) {
    const A = new Map(a.map(r => [this.keyRel(r), r]));
    const B = new Map(b.map(r => [this.keyRel(r), r]));
    const added: Relation[] = [], removed: Relation[] = [], changed: any[] = [];
    for (const [k, rA] of A) {
      if (!B.has(k)) removed.push(rA);
      else {
        const rB = B.get(k)!;
        if (rA.kind !== rB.kind || (rA.fromCard ?? '') !== (rB.fromCard ?? '') || (rA.toCard ?? '') !== (rB.toCard ?? '')) {
          changed.push({ key: k, from: rA, to: rB });
        }
      }
    }
    for (const [k, rB] of B) if (!A.has(k)) added.push(rB);
    return { added, removed, changed };
  }

  private async getVersion(projectId: string, versionId: string) {
    const v = await this.prisma.modelVersion.findFirst({ where: { id: versionId, projectId } });
    if (!v) throw new NotFoundException('Versión no encontrada');
    return v;
  }

  async diff(projectId: string, fromVersionId: string, toVersionId: string) {
    if (fromVersionId === toVersionId) throw new BadRequestException('Seleccione dos versiones distintas');
    const [A, B] = await Promise.all([
      this.getVersion(projectId, fromVersionId),
      this.getVersion(projectId, toVersionId),
    ]);
    const a = A.content as DSL, b = B.content as DSL;
    const entities = this.diffEntities(a.entities ?? [], b.entities ?? []);
    const relations = this.diffRelations(a.relations ?? [], b.relations ?? []);
    const summary = {
      entities: { added: entities.added.length, removed: entities.removed.length, changed: entities.changed.length },
      relations: { added: relations.added.length, removed: relations.removed.length, changed: relations.changed.length },
    };

    // persiste (si no existe)
    await this.prisma.modelDiff.upsert({
      where: { fromVersionId_toVersionId: { fromVersionId, toVersionId } },
      create: { id: undefined, projectId, fromVersionId, toVersionId, diff: { entities, relations, summary } as any },
      update: { diff: { entities, relations, summary } as any },
    });

    return { summary, entities, relations };
  }

  // ---------- RESTORE ----------
  async restore(projectId: string, userId: string, versionId: string, message?: string) {
    const v = await this.getVersion(projectId, versionId);
    // Restaurar en la MISMA rama de la versión seleccionada (crea un snapshot nuevo)
    const latest = await this.prisma.modelVersion.findFirst({
      where: { projectId, branchId: v.branchId }, orderBy: { createdAt: 'desc' }
    });
    const created = await this.prisma.modelVersion.create({
      data: {
        projectId, branchId: v.branchId, authorId: userId,
        parentVersionId: latest?.id ?? null,
        message: message ?? `restore: ${v.id.slice(0,7)}`,
        content: v.content as any,
      },
    });
    await this.prisma.auditLog.create({
      data: { projectId, actorId: userId, action: 'MODEL_SNAPSHOT', targetType: 'ModelVersion', targetId: created.id, metadata: { restoreFrom: v.id } },
    });
    return created;
  }

  // ---------- MERGE (3-way simple) ----------
  private async traceParents(projectId: string, startId: string, limit = 200) {
    const visited = new Set<string>();
    let cur = await this.getVersion(projectId, startId);
    while (cur && limit-- > 0) {
      visited.add(cur.id);
      if (!cur.parentVersionId) break;
      cur = await this.getVersion(projectId, cur.parentVersionId);
    }
    return visited;
  }

  private async findCommonAncestor(projectId: string, aId: string, bId: string) {
    const aAnc = await this.traceParents(projectId, aId);
    let cur = await this.getVersion(projectId, bId);
    let limit = 200;
    while (cur && limit-- > 0) {
      if (aAnc.has(cur.id)) return cur;
      if (!cur.parentVersionId) break;
      cur = await this.getVersion(projectId, cur.parentVersionId);
    }
    return null;
  }

  private indexEntities(d: DSL) {
    const map = new Map<string, Entity>();
    for (const e of d.entities ?? []) map.set(e.name, e);
    return map;
  }
  private indexRelations(d: DSL) {
    const map = new Map<string, Relation>();
    for (const r of d.relations ?? []) map.set(this.keyRel(r), r);
    return map;
  }

  private threeWayMerge(base: DSL, ours: DSL, theirs: DSL) {
    const conflicts: any[] = [];
    // Entities
    const resEntities = new Map<string, Entity>();
    const bE = this.indexEntities(base), oE = this.indexEntities(ours), tE = this.indexEntities(theirs);

    const allNames = new Set<string>([...bE.keys(), ...oE.keys(), ...tE.keys()]);
    for (const name of allNames) {
      const b = bE.get(name), o = oE.get(name), t = tE.get(name);
      if (!b && o && !t) { resEntities.set(name, o); continue; }           // added only in ours
      if (!b && !o && t) { resEntities.set(name, t); continue; }           // added only in theirs
      if (b && !o && !t) { /* deleted both → stays deleted */ continue; }
      if (b && o && !t) { resEntities.set(name, o); continue; }            // deleted on theirs → keep ours
      if (b && !o && t) { resEntities.set(name, t); continue; }            // deleted on ours  → keep theirs
      if (!o || !t) continue;                                              // already handled

      // both present → compare attributes/stereotype
      const pick = (x?: string) => (x ?? '');
      if (pick(o.stereotype) !== pick(t.stereotype) && pick(o.stereotype) !== pick(b?.stereotype) && pick(t.stereotype) !== pick(b?.stereotype)) {
        conflicts.push({ type:'entity.stereotype', name, ours:o.stereotype, theirs:t.stereotype }); // conflict
      }
      // merge attrs by name
      const mAttrs = new Map<string, Attr>();
      const names = new Set<string>([...(o.attrs??[]).map(a=>a.name), ...(t.attrs??[]).map(a=>a.name), ...(b?.attrs??[]).map(a=>a.name)]);
      for (const an of names) {
        const bo = (b?.attrs??[]).find(a=>a.name===an);
        const ao = (o.attrs??[]).find(a=>a.name===an);
        const at = (t.attrs??[]).find(a=>a.name===an);
        if (!bo && ao && !at) { mAttrs.set(an, ao); continue; }
        if (!bo && !ao && at) { mAttrs.set(an, at); continue; }
        if (bo && !ao && !at) { /* deleted both */ continue; }
        if (bo && ao && !at) { mAttrs.set(an, ao); continue; }
        if (bo && !ao && at) { mAttrs.set(an, at); continue; }
        if (ao && at) {
          const same = (x: Attr, y: Attr) => x.type===y.type && !!x.pk===!!y.pk && !!x.unique===!!y.unique && !!x.nullable===!!y.nullable;
          if (!same(ao, at) && (!bo || (!same(ao, bo) && !same(at, bo)))) {
            conflicts.push({ type:'attr', entity:name, attr:an, ours:ao, theirs:at });
            // prefer ours by default
            mAttrs.set(an, ao);
          } else {
            mAttrs.set(an, ao); // equal or one equals base
          }
        }
      }
      resEntities.set(name, { name, stereotype: o.stereotype ?? t.stereotype ?? b?.stereotype, attrs: Array.from(mAttrs.values()) });
    }

    // Relations
    const resRelations = new Map<string, Relation>();
    const bR = this.indexRelations(base), oR = this.indexRelations(ours), tR = this.indexRelations(theirs);
    const allR = new Set<string>([...bR.keys(), ...oR.keys(), ...tR.keys()]);
    for (const k of allR) {
      const b = bR.get(k), o = oR.get(k), t = tR.get(k);
      if (!b && o && !t) { resRelations.set(k, o); continue; }
      if (!b && !o && t) { resRelations.set(k, t); continue; }
      if (b && !o && !t) { continue; }
      if (b && o && !t) { resRelations.set(k, o); continue; }
      if (b && !o && t) { resRelations.set(k, t); continue; }
      if (!o || !t) continue;

      const eq = (x: Relation, y: Relation) => x.kind===y.kind && (x.fromCard??'')===(y.fromCard??'') && (x.toCard??'')===(y.toCard??'');
      if (!eq(o, t) && (!b || (!eq(o, b) && !eq(t, b)))) {
        conflicts.push({ type:'relation', key:k, ours:o, theirs:t });
        resRelations.set(k, o); // prefer ours
      } else {
        resRelations.set(k, o);
      }
    }

    const result: DSL = { entities: Array.from(resEntities.values()), relations: Array.from(resRelations.values()), constraints: base.constraints ?? [] };
    return { result, conflicts };
  }

  async merge(projectId: string, userId: string, params: {
    sourceBranchId: string; targetBranchId: string;
    sourceVersionId: string; targetVersionId: string;
  }) {
    const { sourceBranchId, targetBranchId, sourceVersionId, targetVersionId } = params;
    const [src, dst] = await Promise.all([
      this.getVersion(projectId, sourceVersionId),
      this.getVersion(projectId, targetVersionId),
    ]);
    if (src.branchId !== sourceBranchId || dst.branchId !== targetBranchId) {
      throw new BadRequestException('Las versiones no corresponden a las ramas indicadas');
    }

    // base = ancestor común; si no hay, usar la primera del destino (o la última del ancestro directo)
    const ancestor = await this.findCommonAncestor(projectId, sourceVersionId, targetVersionId);
    const base = ancestor?.content as DSL ?? { entities: [], relations: [], constraints: [] };

    const ours = dst.content as DSL;
    const theirs = src.content as DSL;

    const { result, conflicts } = this.threeWayMerge(base, ours, theirs);

    // crear registro de Merge
    const mergeRec = await this.prisma.merge.create({
      data: {
        projectId,
        sourceBranchId, targetBranchId,
        sourceVersionId, targetVersionId,
        status: conflicts.length ? 'CONFLICTS' : 'COMPLETED',
        conflicts: conflicts.length ? (conflicts as any) : null,
        createdById: userId,
      },
    });

    // siempre creamos snapshot resultado en rama destino (aun con conflictos → "prefer ours" ya aplicado)
    const created = await this.prisma.modelVersion.create({
      data: {
        projectId, branchId: targetBranchId, authorId: userId,
        parentVersionId: targetVersionId,
        message: conflicts.length ? 'merge (with conflicts)' : 'merge',
        content: result as any,
      },
    });

    await this.prisma.merge.update({
      where: { id: mergeRec.id },
      data: { resultVersionId: created.id },
    });

    await this.prisma.auditLog.create({
      data: { projectId, actorId: userId, action: 'MERGE', targetType: 'Merge', targetId: mergeRec.id,
              metadata: { conflicts: conflicts.length, resultVersionId: created.id } },
    });

    return { mergeId: mergeRec.id, status: conflicts.length ? 'CONFLICTS' : 'COMPLETED', conflicts, resultVersionId: created.id };
  }
}
