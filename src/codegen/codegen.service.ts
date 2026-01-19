import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as Handlebars from 'handlebars';
import * as archiver from 'archiver';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Artifact, $Enums } from '@prisma/client';

type ArtifactType =
  | 'SPRING_BOOT_PROJECT'
  | 'SQL_DDL'
  | 'MIGRATIONS_FLYWAY'
  | 'OPENAPI_SPEC'
  | 'FLUTTER_APP'
  | 'POSTMAN_COLLECTION';
type DbEngine = 'POSTGRESQL' | 'MYSQL' | 'MARIADB' | 'SQLSERVER';
type ArtifactSummary = Pick<
  Artifact,
  'id' | 'type' | 'storageKey' | 'createdAt'
>;
const SUPPORTED: ArtifactType[] = [
  'SPRING_BOOT_PROJECT',
  'SQL_DDL',
  'MIGRATIONS_FLYWAY',
  'OPENAPI_SPEC',
  'POSTMAN_COLLECTION',
  'FLUTTER_APP',
];

export class GenerateDto {
  types: $Enums.ArtifactType[]; // p.ej. ["SPRING_BOOT_PROJECT","POSTMAN_COLLECTION"]
  packageBase: string;
  dbEngine?: 'POSTGRESQL' | 'MYSQL' | 'MARIADB' | 'SQLSERVER';
  migrationTool?: 'FLYWAY' | 'LIQUIBASE';
  branchId?: string;
  modelVersionId?: string;
  includeAuth?: boolean;
  flutterBaseUrl?: string;
}

@Injectable()
export class CodegenService {
  constructor(private prisma: PrismaService) { }

  // ===== Utilidades =====
  private ensureDir(p: string) {
    fs.mkdirSync(p, { recursive: true });
  }
  private sha256(filePath: string) {
    const h = createHash('sha256');
    h.update(fs.readFileSync(filePath));
    return h.digest('hex');
  }
  private isMany(card?: string) {
    const s = (card || '').trim();
    return s === '*' || /(\.\.\*|N|M)/i.test(s) || s.includes('*');
  }
  private isOne(card?: string) {
    const s = (card || '').trim();
    return s === '1' || s === '0..1';
  }
  private lc(s: string) {
    return s ? s[0].toLowerCase() + s.slice(1) : s;
  }
  private pluralize(s: string) {
    if (!s) return s;
    return s.endsWith('s') ? s : s + 's';
  }

  // TIPOS del editor → Java/SQL (puedes extenderlo)
  private mapTypeToJava(t: string) {
    const k = t.toLowerCase();
    if (k.includes('uuid')) return 'java.util.UUID';
    if (k.includes('int')) return 'java.lang.Integer';
    if (k.includes('bigint') || k === 'long') return 'java.lang.Long';
    if (k.includes('bool')) return 'java.lang.Boolean';
    if (k.includes('date')) return 'java.time.LocalDate';
    if (k.includes('time')) return 'java.time.Instant';
    return 'java.lang.String';
  }
  private mapTypeToDart(t: string) {
    const k = (t || '').toLowerCase();
    if (k.includes('uuid')) return 'String';
    if (k.includes('bigint') || k === 'long') return 'int';
    if (k.includes('int')) return 'int';
    if (k.includes('double') || k.includes('float') || k.includes('decimal'))
      return 'double';
    if (k.includes('bool')) return 'bool';
    if (k.includes('date') || k.includes('time')) return 'String'; // simple: ISO string
    return 'String';
  }
  private mapTypeToSql(t: string, db: DbEngine) {
    const k = t.toLowerCase();
    if (k.includes('uuid')) return db === 'POSTGRESQL' ? 'uuid' : 'char(36)';
    if (k.includes('int')) return 'integer';
    if (k.includes('bigint') || k === 'long') return 'bigint';
    if (k.includes('bool')) return 'boolean';
    if (k.includes('date')) return 'date';
    if (k.includes('time')) return 'timestamp';
    return 'varchar(255)';
  }

  private sanitizeId(s: string) {
    return s.replace(/[^\w]/g, '');
  }

  // ===== Modelo intermedio desde tu DSL (GoJS model) =====
  private async loadIR(
    projectId: string,
    branchId?: string,
    modelVersionId?: string,
  ) {
    // 1) rama por defecto
    let bid = branchId;
    if (!bid) {
      const def = await this.prisma.branch.findFirst({
        where: { projectId, isDefault: true },
      });
      if (!def) throw new BadRequestException('No default branch');
      bid = def.id;
    }

    // 2) versión (última si no se pasa)
    const mv = modelVersionId
      ? await this.prisma.modelVersion.findUnique({
        where: { id: modelVersionId },
      })
      : await this.prisma.modelVersion.findFirst({
        where: { projectId, branchId: bid },
        orderBy: { createdAt: 'desc' },
      });

    if (!mv) throw new BadRequestException('No model version to generate from');

    // 3) parseo flexible
    const raw = mv.content as any;
    const model = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // ====== CASO A: DSL { entities, relations } ======
    if (Array.isArray(model?.entities)) {
      const entities = (model.entities as any[]).map((e) => {
        const className = this.sanitizeId(
          (e.name ?? 'Entity').toString().trim().replace(/\s+/g, ''),
        );
        const route = className.charAt(0).toLowerCase() + className.slice(1);
        const table = className.toLowerCase();

        const fields = (Array.isArray(e.attrs) ? e.attrs : []).map(
          (a: any) => ({
            name: this.sanitizeId(a.name || 'field'),
            pk: !!a.pk,
            nullable: !!a.nullable,
            unique: !!a.unique,
            javaType: this.mapTypeToJava(a.type || 'string'),
            sqlType: this.mapTypeToSql(a.type || 'string', 'POSTGRESQL'),
          }),
        );

        let idField =
          fields.find((f) => f.pk) ?? fields.find((f) => f.name === 'id');
        if (!idField) {
          idField = {
            name: 'id',
            pk: true,
            nullable: false,
            unique: true,
            javaType: 'java.util.UUID',
            sqlType: this.mapTypeToSql('uuid', 'POSTGRESQL'),
          };
          fields.unshift(idField);
        }

        return {
          name: className,
          table,
          fields,
          idField,
          route,
          // NUEVO: banderas y estereotipo si vienen en DSL
          isInterface: !!e.isInterface,
          isAbstract: !!e.isAbstract,
          stereotype: e.stereotype || undefined,
        };
      });

      const relsRaw = (
        Array.isArray(model.relations) ? model.relations : []
      ).map((r: any) => ({
        from: this.sanitizeId((r.from || '').toString().replace(/\s+/g, '')),
        to: this.sanitizeId((r.to || '').toString().replace(/\s+/g, '')),
        kind: (r.kind || 'association').toString().toLowerCase(),
        fromCard: r.fromCard || 'N',
        toCard: r.toCard || '1',
      }));

      // NUEVO: calcular extends/implements a partir de las relaciones
      const extendsMap: Record<string, string[]> = {};
      const implementsMap: Record<string, string[]> = {};
      for (const r of relsRaw) {
        if (r.kind === 'generalization') {
          // from -> to (from es subclase, to es base)
          (extendsMap[r.from] ||= []).push(r.to);
        }
        if (r.kind === 'realization') {
          (implementsMap[r.from] ||= []).push(r.to);
        }
      }
      for (const e of entities) {
        (e as any).extends = (extendsMap[e.name] || [])[0]; // 1 base
        (e as any).implements = implementsMap[e.name] || [];
      }

      return { entities, rels: relsRaw, modelVersionId: mv.id };
    }

    // ====== CASO B: GoJS { nodeDataArray, linkDataArray } (o anidados) ======
    const candidates = [
      model,
      model?.model,
      model?.diagram,
      model?.patch,
      model?.content,
    ].filter(Boolean);

    const payload =
      candidates.find(
        (c: any) =>
          Array.isArray(c?.nodeDataArray) && Array.isArray(c?.linkDataArray),
      ) ??
      candidates.find((c: any) => Array.isArray(c?.nodeDataArray)) ??
      {};

    const nodes = Array.isArray((payload as any).nodeDataArray)
      ? (payload as any).nodeDataArray
      : [];
    const links = Array.isArray((payload as any).linkDataArray)
      ? (payload as any).linkDataArray
      : [];

    if (!nodes.length) {
      throw new BadRequestException(
        'El modelo está vacío. Guarda el diagrama y vuelve a generar.',
      );
    }

    const entities = nodes.map((n: any) => {
      const name = (n.name ?? n.key ?? 'Entity').toString().trim();
      const className = this.sanitizeId(name.replace(/\s+/g, ''));
      const route = className.charAt(0).toLowerCase() + className.slice(1);
      const table = className.toLowerCase();
      const attrs = Array.isArray(n.attrs) ? n.attrs : [];
      const fields = attrs.map((a: any) => ({
        name: this.sanitizeId(a.name || 'field'),
        pk: !!a.pk,
        nullable: !!a.nullable,
        unique: !!a.unique,
        javaType: this.mapTypeToJava(a.type || 'string'),
        sqlType: this.mapTypeToSql(a.type || 'string', 'POSTGRESQL'),
      }));
      let idField =
        fields.find((f) => f.pk) ?? fields.find((f) => f.name === 'id');
      if (!idField) {
        idField = {
          name: 'id',
          pk: true,
          nullable: false,
          unique: true,
          javaType: 'java.util.UUID',
          sqlType: this.mapTypeToSql('uuid', 'POSTGRESQL'),
        };
        fields.unshift(idField);
      }
      return {
        name: className,
        table,
        fields,
        idField,
        route,
        // NUEVO: banderas/estereotipo desde el nodo GoJS
        isInterface: !!n.isInterface,
        isAbstract: !!n.isAbstract,
        stereotype: n.stereotype || undefined,
      };
    });

    const relsRaw = links.map((l: any) => ({
      from: this.sanitizeId((l.from || '').toString().replace(/\s+/g, '')),
      to: this.sanitizeId((l.to || '').toString().replace(/\s+/g, '')),
      kind: (l.kind || 'association').toString().toLowerCase(),
      fromCard: l.fromCard || 'N',
      toCard: l.toCard || '1',
    }));

    // NUEVO: calcular extends/implements a partir de las relaciones
    const extendsMap: Record<string, string[]> = {};
    const implementsMap: Record<string, string[]> = {};
    for (const r of relsRaw) {
      if (r.kind === 'generalization') {
        (extendsMap[r.from] ||= []).push(r.to);
      }
      if (r.kind === 'realization') {
        (implementsMap[r.from] ||= []).push(r.to);
      }
    }
    for (const e of entities) {
      (e as any).extends = (extendsMap[e.name] || [])[0];
      (e as any).implements = implementsMap[e.name] || [];
    }

    return { entities, rels: relsRaw, modelVersionId: mv.id };
  }

  // ====== GENERACIÓN ======
  async generateArtifacts(projectId: string, dto: GenerateDto) {
    const requested: ArtifactType[] = (dto.types ?? [])
      .map((t: any) => String(t).trim().toUpperCase())
      .filter((t: any) =>
        SUPPORTED.includes(t as ArtifactType),
      ) as ArtifactType[];

    if (requested.length === 0) {
      requested.push('SPRING_BOOT_PROJECT', 'POSTMAN_COLLECTION', 'FLUTTER_APP');
    }

    // (opcional) log de depuración:
    console.log('[codegen] requested:', requested);
    const types = dto.types?.length
      ? dto.types
      : ['SPRING_BOOT_PROJECT', 'POSTMAN_COLLECTION'];
    const pkg = dto.packageBase || 'com.acme.demo';
    const db: DbEngine = dto.dbEngine || 'POSTGRESQL';
    const mig = dto.migrationTool || 'FLYWAY';
    const includeAuth = dto.includeAuth !== false; // por defecto true
    const flutterBaseUrl = dto.flutterBaseUrl || process.env.FLUTTER_BASE_URL || 'http://localhost:8080';

    const { entities, rels, modelVersionId } = await this.loadIR(
      projectId,
      dto.branchId,
      dto.modelVersionId,
    );

    // carpeta temporal
    const outDir = path.join(
      process.cwd(),
      'storage',
      'work',
      `${projectId}-${Date.now()}`,
    );
    this.ensureDir(outDir);

    const artifacts: {
      type: ArtifactType;
      file: string;
      storageKey: string;
    }[] = [];
    // 1) SPRING BOOT PROJECT (ZIP)
    if (requested.includes('SPRING_BOOT_PROJECT')) {
      const zipPath = path.join(outDir, `springboot-${projectId}.zip`);
      await this.buildSpringBootZip(zipPath, { pkg, db, mig, entities, rels, includeAuth });
      artifacts.push({
        type: 'SPRING_BOOT_PROJECT',
        file: zipPath,
        storageKey: `work/${path.basename(outDir)}/${path.basename(zipPath)}`,
      });
    }

    // 2) SQL DDL (archivo suelto)
    if (
      requested.includes('SQL_DDL') ||
      requested.includes('MIGRATIONS_FLYWAY')
    ) {
      const ddl = this.renderDDL({ db, entities, rels });
      const ddlPath = path.join(outDir, `schema-${projectId}.sql`);
      fs.writeFileSync(ddlPath, ddl, 'utf-8');
      artifacts.push({
        type: 'SQL_DDL',
        file: ddlPath,
        storageKey: `work/${path.basename(outDir)}/${path.basename(ddlPath)}`,
      });

      if (requested.includes('MIGRATIONS_FLYWAY')) {
        const v1 = path.join(outDir, `V1__init.sql`);
        fs.writeFileSync(v1, ddl, 'utf-8');
        artifacts.push({
          type: 'MIGRATIONS_FLYWAY',
          file: v1,
          storageKey: `work/${path.basename(outDir)}/${path.basename(v1)}`,
        });
      }
    }

    // 3) POSTMAN (colección)
    if (requested.includes('POSTMAN_COLLECTION')) {
      const pm = this.renderPostman({ pkg, entities, includeAuth });
      const pmPath = path.join(outDir, `postman-${projectId}.json`);
      fs.writeFileSync(pmPath, JSON.stringify(pm, null, 2), 'utf-8');
      artifacts.push({
        type: 'POSTMAN_COLLECTION',
        file: pmPath,
        storageKey: `work/${path.basename(outDir)}/${path.basename(pmPath)}`,
      });
    }



    // 4) OPENAPI (lo damos vía springdoc al ejecutar el app generado)
    if (requested.includes('OPENAPI_SPEC')) {
      const oaPath = path.join(outDir, `openapi-note.txt`);
      fs.writeFileSync(
        oaPath,
        `El proyecto Spring Boot generado incluye springdoc-openapi. Levanta la app y visita /v3/api-docs`,
        'utf-8',
      );
      artifacts.push({
        type: 'OPENAPI_SPEC',
        file: oaPath,
        storageKey: `work/${path.basename(outDir)}/${path.basename(oaPath)}`,
      });
    }
    if (requested.includes('FLUTTER_APP')) {
      console.log('[codegen] Generando FLUTTER_APP…');
      const zipPath = path.join(outDir, `flutter_${projectId}.zip`);
      try {
        await this.buildFlutterZip(zipPath, {
          project: {
            id: projectId,
            name:
              (
                await this.prisma.project.findFirst({
                  where: { id: projectId },
                  select: { name: true },
                })
              )?.name || 'App',
          },
          baseUrl: flutterBaseUrl,
          entities,
          rels,
          includeAuth,
        });


        artifacts.push({
          type: 'FLUTTER_APP',
          file: zipPath,
          storageKey: `work/${path.basename(outDir)}/${path.basename(zipPath)}`,
        });

        console.log('[codegen] FLUTTER_APP generado:', zipPath);
      } catch (e) {
        console.error('[codegen] FLUTTER_APP failed:', e);
        // Hazlo visible: o lanzas error para que el cliente lo vea...
        throw new BadRequestException(
          'No se pudo generar el ZIP de Flutter: ' + (e as Error).message,
        );
      }
    }

    // Mover a storage/ y persistir Artifact
    const saved: ArtifactSummary[] = [];
    for (const a of artifacts) {
      const dest = path.join(process.cwd(), 'storage', a.storageKey);
      this.ensureDir(path.dirname(dest));
      fs.copyFileSync(a.file, dest);
      const size = fs.statSync(dest).size;
      const sum = this.sha256(dest);
      const rec: ArtifactSummary = await this.prisma.artifact.create({
        data: {
          projectId,
          modelVersionId,
          type: a.type as any, // o mapea tu string a $Enums.ArtifactType
          visibility: 'PRIVATE',
          storageBucket: 'local',
          storageKey: a.storageKey,
          sizeBytes: BigInt(size),
          checksumSha256: sum,
          metadata: { packageBase: pkg, dbEngine: db, migrationTool: mig },
        },
        select: { id: true, type: true, storageKey: true, createdAt: true },
      });
      saved.push(rec);
    }
    return { ok: true, artifacts: saved };
  }

  // ====== Renderizadores ======
  private async buildSpringBootZip(zipPath: string, ctx: any) {
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Tipos locales para ayudar a TS
    type EntityIR = {
      name: string;
      table: string;
      idField: { name: string; sqlType?: string };
      fields: any[];
      route: string;
      isInterface?: boolean;
      isAbstract?: boolean;
      stereotype?: string;
      extends?: string;
      implements?: string[];
      // marcadores que agregamos al enriquecer
      relationFields?: string[];
      requiresSet?: boolean;
      inheritanceBase?: boolean;
    };

    type RelIR = {
      from: string;
      to: string;
      kind: string; // 'association' | 'aggregation' | 'composition' | 'generalization' | 'realization' | ...
      fromCard?: string; // '1' | '0..1' | '*' | '0..*' | '1..*' | ...
      toCard?: string;
    };

    // asegurar carpeta destino
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });

    const output = fs.createWriteStream(zipPath);
    const archive = archiver.create('zip', { zlib: { level: 9 } });

    // manejo de eventos
    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', (err) => reject(err));
    });

    archive.pipe(output);

    const groupPath = ctx.pkg.replace(/\./g, '/');

    // archivos base
    archive.append(this.tpl('springboot/pom.hbs', ctx), { name: 'pom.xml' });
    archive.append(this.tpl('springboot/gitignore.hbs', ctx), {
      name: '.gitignore',
    });
    archive.append(this.tpl('springboot/Application.hbs', ctx), {
      name: `src/main/java/${groupPath}/Application.java`,
    });
    archive.append(this.tpl('springboot/application.properties.hbs', ctx), {
      name: `src/main/resources/application.properties`,
    });

    // ===== Enriquecer entidades con campos JPA de relaciones =====
    const entities: EntityIR[] = Array.isArray(ctx.entities)
      ? (ctx.entities as EntityIR[])
      : [];
    const rels: RelIR[] = Array.isArray(ctx.rels) ? (ctx.rels as RelIR[]) : [];

    const byName = new Map<string, EntityIR>(entities.map((e) => [e.name, e]));

    const jpaCascade = (kind: string) => {
      const k = (kind || '').toLowerCase();
      if (k === 'composition')
        return 'cascade = CascadeType.ALL, orphanRemoval = true';
      if (k === 'aggregation') return 'cascade = CascadeType.MERGE';
      return '';
    };

    const enrichedEntities: EntityIR[] = entities.map((e) => {
      const relationFields: string[] = [];
      let requiresSet = false;
      let inheritanceBase = false;

      // base de herencia si alguien "generaliza" hacia e
      if (
        rels.some(
          (r) =>
            (r.kind || '').toLowerCase() === 'generalization' &&
            r.to === e.name,
        )
      ) {
        inheritanceBase = true;
      }

      for (const r of rels) {
        const from = byName.get(r.from);
        const to = byName.get(r.to);
        if (!from || !to) continue;

        const isManyFrom = this.isMany?.(r.fromCard) ?? false;
        const isManyTo = this.isMany?.(r.toCard) ?? false;
        const cascade = jpaCascade(r.kind);
        const cascadeFrag = cascade ? `(${cascade})` : '';

        const toOneName = this.lc
          ? this.lc(to.name)
          : to.name.charAt(0).toLowerCase() + to.name.slice(1);
        const fromOneName = this.lc
          ? this.lc(from.name)
          : from.name.charAt(0).toLowerCase() + from.name.slice(1);
        const toManyName = this.pluralize
          ? this.pluralize(this.lc ? this.lc(to.name) : toOneName)
          : `${toOneName}s`;
        const fromManyName = this.pluralize
          ? this.pluralize(this.lc ? this.lc(from.name) : fromOneName)
          : `${fromOneName}s`;

        // --- ONE-TO-ONE ---
        if (
          (this.isOne?.(r.fromCard) ?? false) &&
          (this.isOne?.(r.toCard) ?? false)
        ) {
          if (e.name === from.name) {
            relationFields.push(
              `  @OneToOne${cascadeFrag}
  @JoinColumn(name = "${to.table}_id", referencedColumnName = "${to.idField.name}")
  private ${to.name} ${toOneName};`,
            );
          }
          if (e.name === to.name) {
            relationFields.push(
              `  @OneToOne(mappedBy = "${toOneName}"${cascade ? `, ${cascade}` : ''})
  private ${from.name} ${fromOneName};`,
            );
          }
        }

        // --- MANY(FROM) - ONE(TO) ---
        if (isManyFrom && (this.isOne?.(r.toCard) ?? false)) {
          if (e.name === from.name) {
            relationFields.push(
              `  @ManyToOne${cascadeFrag}
  @JoinColumn(name = "${to.table}_id", referencedColumnName = "${to.idField.name}")
  private ${to.name} ${toOneName};`,
            );
          }
          if (e.name === to.name) {
            requiresSet = true;
            relationFields.push(
              `  @OneToMany(mappedBy = "${toOneName}"${cascade ? `, ${cascade}` : ''})
  private Set<${from.name}> ${fromManyName};`,
            );
          }
        }

        // --- ONE(FROM) - MANY(TO) ---
        if ((this.isOne?.(r.fromCard) ?? false) && isManyTo) {
          if (e.name === from.name) {
            requiresSet = true;
            relationFields.push(
              `  @OneToMany(mappedBy = "${fromOneName}"${cascade ? `, ${cascade}` : ''})
  private Set<${to.name}> ${toManyName};`,
            );
          }
          if (e.name === to.name) {
            relationFields.push(
              `  @ManyToOne${cascadeFrag}
  @JoinColumn(name = "${from.table}_id", referencedColumnName = "${from.idField.name}")
  private ${from.name} ${fromOneName};`,
            );
          }
        }

        // --- MANY-TO-MANY (incluye self) ---
        if (isManyFrom && isManyTo) {
          const jt =
            from.name <= to.name
              ? `${from.table}_${to.table}`
              : `${to.table}_${from.table}`;
          const left = `${from.table}_id`;
          const right = `${to.table}_id`;

          if (e.name === from.name) {
            requiresSet = true;
            relationFields.push(
              `  @ManyToMany${cascadeFrag}
  @JoinTable(
    name = "${jt}",
    joinColumns = @JoinColumn(name = "${left}"),
    inverseJoinColumns = @JoinColumn(name = "${right}")
  )
  private Set<${to.name}> ${toManyName};`,
            );
          }
          if (e.name === to.name) {
            requiresSet = true;
            relationFields.push(
              `  @ManyToMany(mappedBy = "${toManyName}"${cascade ? `, ${cascade}` : ''})
  private Set<${from.name}> ${fromManyName};`,
            );
          }
        }
      }

      return {
        ...e,
        relationFields,
        requiresSet,
        inheritanceBase,
      };
    });
    if (ctx.includeAuth) {
      archive.append(this.tpl('springboot/security/SecurityConfig.hbs', ctx), {
        name: `src/main/java/${groupPath}/config/SecurityConfig.java`,
      });
      archive.append(this.tpl('springboot/security/JwtTokenProvider.hbs', ctx), {
        name: `src/main/java/${groupPath}/security/JwtTokenProvider.java`,
      });
      archive.append(this.tpl('springboot/security/JwtAuthFilter.hbs', ctx), {
        name: `src/main/java/${groupPath}/security/JwtAuthFilter.java`,
      });
      archive.append(this.tpl('springboot/auth/User.hbs', ctx), {
        name: `src/main/java/${groupPath}/domain/User.java`,
      });
      archive.append(this.tpl('springboot/auth/Role.hbs', ctx), {
        name: `src/main/java/${groupPath}/domain/Role.java`,
      });
      archive.append(this.tpl('springboot/auth/UserRepository.hbs', ctx), {
        name: `src/main/java/${groupPath}/repository/UserRepository.java`,
      });
      archive.append(this.tpl('springboot/auth/UserService.hbs', ctx), {
        name: `src/main/java/${groupPath}/service/UserService.java`,
      });
      archive.append(this.tpl('springboot/auth/AuthController.hbs', ctx), {
        name: `src/main/java/${groupPath}/web/AuthController.java`,
      });
      archive.append(this.tpl('springboot/auth/dto/AuthDtos.hbs', ctx), {
        name: `src/main/java/${groupPath}/web/dto/AuthDtos.java`,
      });
    }

    // escribir fuentes Java
    for (const e of enrichedEntities) {
      archive.append(this.tpl('springboot/Entity.hbs', { ...ctx, e }), {
        name: `src/main/java/${groupPath}/domain/${e.name}.java`,
      });
      archive.append(this.tpl('springboot/Repository.hbs', { ...ctx, e }), {
        name: `src/main/java/${groupPath}/repository/${e.name}Repository.java`,
      });
      archive.append(this.tpl('springboot/Service.hbs', { ...ctx, e }), {
        name: `src/main/java/${groupPath}/service/${e.name}Service.java`,
      });
      archive.append(this.tpl('springboot/Controller.hbs', { ...ctx, e }), {
        name: `src/main/java/${groupPath}/web/${e.name}Controller.java`,
      });
    }

    // Flyway: migración inicial con DDL generado
    const ddl = this.renderDDL(ctx);
    archive.append(ddl ? `${ddl}\n` : '', {
      name: `src/main/resources/db/migration/V1__init.sql`,
    });

    await archive.finalize();
    await done;

  }
  private async buildFlutterZip(zipPath: string, ctx: any) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const arch =
      (await import('archiver')).default || (await import('archiver'));

    const output = fs.createWriteStream(zipPath);
    const archive = arch('zip', { zlib: { level: 9 } });

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', (err: any) => reject(err));
    });

    archive.pipe(output);

    const baseUrl = ctx.baseUrl || 'http://localhost:8080';
    const appName =
      (ctx.project?.name || 'GeneratedApp').replace(/[^A-Za-z0-9]/g, '') ||
      'GeneratedApp';
    const appNameKebab = appName
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();

    const entities = ctx.entities.map((e: any) => {
      const dartFields = e.fields.map((f: any) => {
        const dt = this.mapTypeToDart(f.javaType || '');
        const fromJson =
          dt === 'int'
            ? `j['${f.name}'] as int?`
            : dt === 'double'
              ? `j['${f.name}'] as num? != null ? (j['${f.name}'] as num).toDouble() : null`
              : dt === 'bool'
                ? `j['${f.name}'] as bool?`
                : `j['${f.name}'] as String?`;
        return {
          name: f.name,
          type: dt,
          nullable: '?',
          fromJson,
          toJson: `${f.name}`,
          emptyExpr: 'null',
        };
      });

      const scalarFields = e.fields
        .filter((f: any) => !f.pk)
        .map((f: any) => {
          const dt = this.mapTypeToDart(f.javaType || '');
          const castFromString =
            dt === 'int'
              ? `int.tryParse(v ?? "")`
              : dt === 'double'
                ? `double.tryParse(v ?? "")`
                : dt === 'bool'
                  ? `(v ?? "").toLowerCase() == "true"`
                  : `v ?? ""`;
          return { name: f.name, required: false, castFromString };
        });

      const strField = e.fields.find((f: any) =>
        (f.javaType || '').toLowerCase().includes('string'),
      )?.name;

      const titleExpr = strField
        ? `${strField} ?? ""`
        : `${e.idField?.name}?.toString() ?? ""`;

      return {
        ...e,
        dartFields,
        scalarFields,
        idName: e.idField?.name || 'id',
        titleExpr,
        subtitleExpr: '""',
      };
    });

    // pubspec, main, api_client
    archive.append(
      this.tpl('flutter/pubspec.yaml.hbs', { appName, appNameKebab }),
      { name: 'pubspec.yaml' },
    );
    archive.append(this.tpl('flutter/analysis_options.yaml.hbs', {}), {
      name: 'analysis_options.yaml',
    });
    archive.append(this.tpl('flutter/lib/main.dart.hbs', { appName }), {
      name: 'lib/main.dart',
    });
    archive.append(
      this.tpl('flutter/lib/core/api_client.dart.hbs', { baseUrl }),
      { name: 'lib/core/api_client.dart' },
    );

    // Router
    archive.append(
      this.tpl('flutter/lib/app_router.dart.hbs', {
        entities,
        includeAuth: ctx.includeAuth !== false,
      }),
      { name: 'lib/app_router.dart' },
    );

    // --- NUEVO: archivo de menú compartido (Drawer) ---
    archive.append(
      this.tpl('flutter/lib/features/_shared/app_menu.dart.hbs', {
        appName,
        entities,
      }),
      { name: 'lib/features/_shared/app_menu.dart' },
    );

    // Auth opcional
    if (ctx.includeAuth !== false) {
      archive.append(
        this.tpl('flutter/lib/features/auth/data/auth_api.dart.hbs', {}),
        { name: 'lib/features/auth/data/auth_api.dart' },
      );
      archive.append(
        this.tpl('flutter/lib/features/auth/data/auth_repository.dart.hbs', {}),
        { name: 'lib/features/auth/data/auth_repository.dart' },
      );
      archive.append(
        this.tpl(
          'flutter/lib/features/auth/presentation/login_page.dart.hbs',
          {},
        ),
        { name: 'lib/features/auth/presentation/login_page.dart' },
      );
      archive.append(
        this.tpl(
          'flutter/lib/features/auth/presentation/register_page.dart.hbs',
          {},
        ),
        { name: 'lib/features/auth/presentation/register_page.dart' },
      );
    }

    // Features por entidad
    for (const e of entities) {
      archive.append(
        this.tpl(
          'flutter/lib/features/{{e.route}}/model/{{e.route}}.dart.hbs',
          { e },
        ),
        { name: `lib/features/${e.route}/model/${e.route}.dart` },
      );
      archive.append(
        this.tpl(
          'flutter/lib/features/{{e.route}}/presentation/{{e.route}}_list_page.dart.hbs',
          { e },
        ),
        {
          name: `lib/features/${e.route}/presentation/${e.route}_list_page.dart`,
        },
      );
      archive.append(
        this.tpl(
          'flutter/lib/features/{{e.route}}/presentation/{{e.route}}_form_page.dart.hbs',
          { e },
        ),
        {
          name: `lib/features/${e.route}/presentation/${e.route}_form_page.dart`,
        },
      );
    }

    await archive.finalize();
    await done;
  }



  private renderDDL(ctx: any): string {
    // Tipos locales para evitar inferencia a {}
    type EntityIR = {
      name: string;
      table: string;
      idField: { name: string; sqlType: string };
      fields: Array<{
        name: string;
        sqlType: string;
        nullable?: boolean;
        unique?: boolean;
        pk?: boolean;
      }>;
    };

    type RelIR = {
      from: string;
      to: string;
      kind: string; // association | aggregation | composition | generalization | realization
      fromCard?: string; // '1' | '0..1' | '*' | '0..*' | '1..*' | 'N' | 'M'
      toCard?: string;
    };

    const entities: EntityIR[] = Array.isArray(ctx.entities)
      ? (ctx.entities as EntityIR[])
      : [];
    const rels: RelIR[] = Array.isArray(ctx.rels) ? (ctx.rels as RelIR[]) : [];

    const byName = new Map<string, EntityIR>(entities.map((e) => [e.name, e]));

    const isMany = (card?: string) => {
      const s = (card || '').trim();
      return (
        s === '*' || /\.\.\*/.test(s) || /^(?:N|M)$/i.test(s) || s.includes('*')
      );
    };
    const isOne = (card?: string) => {
      const s = (card || '').trim();
      return s === '1' || s === '0..1';
    };

    const lines: string[] = [];

    // 1) Tablas base
    for (const e of entities) {
      lines.push(`CREATE TABLE IF NOT EXISTS "${e.table}" (`);
      const cols: string[] = e.fields.map((f) => {
        const notnull = f.nullable ? '' : ' NOT NULL';
        const unique = f.unique ? ' UNIQUE' : '';
        return `  "${f.name}" ${f.sqlType}${notnull}${unique}`;
      });
      cols.push(`  PRIMARY KEY ("${e.idField.name}")`);
      lines.push(cols.join(',\n'));
      lines.push(');');
      lines.push('');
    }

    // 2) FKs y Join Tables
    const fkLines: string[] = [];
    const jtLines: string[] = [];

    for (const r of rels) {
      const from = byName.get(r.from);
      const to = byName.get(r.to);
      if (!from || !to) continue;

      const manyFrom = isMany(r.fromCard);
      const manyTo = isMany(r.toCard);
      const oneFrom = isOne(r.fromCard);
      const oneTo = isOne(r.toCard);

      // ONE-TO-ONE → FK en FROM (dueño)
      if (oneFrom && oneTo) {
        fkLines.push(
          `ALTER TABLE "${from.table}" ADD COLUMN IF NOT EXISTS "${to.table}_id" ${to.idField.sqlType};
ALTER TABLE "${from.table}" ADD CONSTRAINT "fk_${from.table}_${to.table}"
  FOREIGN KEY ("${to.table}_id") REFERENCES "${to.table}"("${to.idField.name}");`,
        );
      }

      // MANY(FROM)-TO-ONE(TO) → FK en FROM
      if (manyFrom && oneTo) {
        fkLines.push(
          `ALTER TABLE "${from.table}" ADD COLUMN IF NOT EXISTS "${to.table}_id" ${to.idField.sqlType};
ALTER TABLE "${from.table}" ADD CONSTRAINT "fk_${from.table}_${to.table}"
  FOREIGN KEY ("${to.table}_id") REFERENCES "${to.table}"("${to.idField.name}");`,
        );
      }

      // ONE(FROM)-TO-MANY(TO) → FK en TO
      if (oneFrom && manyTo) {
        fkLines.push(
          `ALTER TABLE "${to.table}" ADD COLUMN IF NOT EXISTS "${from.table}_id" ${from.idField.sqlType};
ALTER TABLE "${to.table}" ADD CONSTRAINT "fk_${to.table}_${from.table}"
  FOREIGN KEY ("${from.table}_id") REFERENCES "${from.table}"("${from.idField.name}");`,
        );
      }

      // MANY-TO-MANY → join table (incluye self)
      if (manyFrom && manyTo) {
        const jt =
          from.name <= to.name
            ? `${from.table}_${to.table}`
            : `${to.table}_${from.table}`;
        const left = `${from.table}_id`;
        const right = `${to.table}_id`;

        jtLines.push(
          `CREATE TABLE IF NOT EXISTS "${jt}" (
  "${left}" ${from.idField.sqlType} NOT NULL,
  "${right}" ${to.idField.sqlType} NOT NULL,
  PRIMARY KEY ("${left}", "${right}"),
  CONSTRAINT "fk_${jt}_${from.table}" FOREIGN KEY ("${left}") REFERENCES "${from.table}"("${from.idField.name}"),
  CONSTRAINT "fk_${jt}_${to.table}" FOREIGN KEY ("${right}") REFERENCES "${to.table}"("${to.idField.name}")
);`,
        );
      }
    }

    if (fkLines.length) lines.push(fkLines.join('\n'));
    if (jtLines.length) {
      lines.push('');
      lines.push(jtLines.join('\n\n'));
    }

    return lines.join('\n');
  }

  private renderPostman({ entities, includeAuth }: any) {
    const variable = [
      { key: 'baseUrl', value: 'http://localhost:8080', type: 'string' },
      { key: 'accessToken', value: '', type: 'string' } // NUEVO
    ];

    const authFolder = includeAuth ? [{
      name: 'Auth',
      item: [
        {
          name: 'Register',
          request: {
            method: 'POST',
            url: `{{baseUrl}}/api/auth/register`,
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"email":"","password":"","fullName":""}' }
          }
        },
        {
          name: 'Login',
          event: [{
            listen: 'test',
            script: {
              exec: [
                'let data = pm.response.json();',
                'pm.collectionVariables.set("accessToken", data.accessToken || "");',
              ]
            }
          }],
          request: {
            method: 'POST',
            url: `{{baseUrl}}/api/auth/login`,
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"email":"","password":""}' }
          }
        },
        {
          name: 'Me',
          request: {
            method: 'GET',
            url: `{{baseUrl}}/api/auth/me`,
            header: [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }]
          }
        }
      ]
    }] : [];

    const item = [
      ...authFolder,
      ...entities.map((e: any) => {
        const base = `{{baseUrl}}/api/${e.route}`;
        const authHeader = includeAuth ? [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }] : [];
        return {
          name: e.name,
          item: [
            { name: `List ${e.name}`, request: { method: 'GET', url: `${base}`, header: authHeader } },
            { name: `Get ${e.name}`, request: { method: 'GET', url: `${base}/:id`, header: authHeader } },
            { name: `Create ${e.name}`, request: { method: 'POST', url: `${base}`, header: [...authHeader, { key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{}' } } },
            { name: `Update ${e.name}`, request: { method: 'PUT', url: `${base}/:id`, header: [...authHeader, { key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{}' } } },
            { name: `Delete ${e.name}`, request: { method: 'DELETE', url: `${base}/:id`, header: authHeader } },
          ]
        };
      })
    ];

    return {
      info: {
        name: 'ModelEditor – API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable,
      item,
    };
  }


  private tpl(relPath: string, ctx: any) {
    const fs = require('node:fs');
    const path = require('node:path');
    const Handlebars = require('handlebars');

    // === Helpers (solo si no existen) ===
    if (!Handlebars.helpers.eq) {
      Handlebars.registerHelper('eq', (a: any, b: any) => a === b);
    }

    if (!Handlebars.helpers.lower) {
      Handlebars.registerHelper('lower', (s: any) =>
        (s ?? '').toString().toLowerCase(),
      );
    }

    if (!Handlebars.helpers.lc) {
      Handlebars.registerHelper('lc', (s: any) => {
        const str = (s ?? '').toString();
        return str ? str.charAt(0).toLowerCase() + str.slice(1) : '';
      });
    }

    if (!Handlebars.helpers.some) {
      Handlebars.registerHelper(
        'some',
        (arr: any[], val: any) =>
          Array.isArray(arr) &&
          arr.some(
            (it: any) => (typeof it === 'string' ? it : it.javaType) === val,
          ),
      );
    }

    if (!Handlebars.helpers.json) {
      Handlebars.registerHelper('json', (obj: any) => JSON.stringify(obj));
    }

    // Helper `required` para templates Flutter:
    // Uso típico esperado:
    //   {{required flag}}           -> "required " si flag truthy, sino ""
    //   {{#required flag}}...{{/required}} -> renderiza bloque solo si flag truthy
    if (!Handlebars.helpers.required) {
      Handlebars.registerHelper('required', function (this: any, v: any, opts?: any) {
        // Block form: {{#required flag}}...{{/required}}
        if (opts && typeof opts.fn === 'function') {
          return v ? opts.fn(this) : (opts.inverse ? opts.inverse(this) : '');
        }
        // Inline form: {{required flag}}
        return v ? 'required ' : '';
      });
    }

    // Rutas dev/dist robustas
    const fromDist = path.join(__dirname, 'templates', relPath);
    const fromSrc = path.join(
      process.cwd(),
      'src',
      'codegen',
      'templates',
      relPath,
    );

    const altRel = relPath.startsWith('flutter/')
      ? relPath.replace(/^flutter\//, 'flutter_templates/')
      : relPath;

    const altFromDist = path.join(__dirname, 'templates', altRel);
    const altFromSrc = path.join(
      process.cwd(),
      'src',
      'codegen',
      'templates',
      altRel,
    );

    const candidates = [fromDist, fromSrc, altFromDist, altFromSrc];
    const full = candidates.find((p) => fs.existsSync(p));

    if (!full) {
      throw new Error(`Template not found: ${relPath}
  Checked:
  - ${fromDist}
  - ${fromSrc}
  - ${altFromDist}
  - ${altFromSrc}`);
    }

    const src = fs.readFileSync(full, 'utf-8');
    const compiled = Handlebars.compile(src, { noEscape: true });
    return compiled(ctx);
  }


}
