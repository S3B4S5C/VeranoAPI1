import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/* =========================
 *   DSL (UML 2.5 extendido)
 * ========================= */

type EntityAttr = {
  name: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  nullable?: boolean;
};

type Entity = {
  id?: string;
  name: string;
  stereotype?: string;
  isInterface?: boolean;
  isAbstract?: boolean;
  attrs: EntityAttr[];
};

type RelationKind =
  | 'association'
  | 'aggregation'
  | 'composition'
  | 'generalization'
  | 'realization'
  | 'dependency'
  | 'inheritance';

type Relation = {
  from: string;
  to: string;
  kind: RelationKind;
  fromCard?: string;
  via?: string;
  toCard?: string;
  fk?: string;
  onDelete?: 'cascade' | 'restrict' | 'setnull';
};

type DSL = {
  entities: Entity[];
  relations: Relation[];
  constraints?: any[];
};

/* ==================================
 *   Helpers: nombres y cardinalidad
 * ================================== */

const VALID_KINDS: Set<RelationKind> = new Set([
  'association',
  'aggregation',
  'composition',
  'generalization',
  'realization',
  'dependency',
  'inheritance',
]);

const CLASS_RE = /^[A-Z][A-Za-z0-9_]*$/;
const ATTR_RE = /^[a-z][A-Za-z0-9_]*$/;

const BASIC_TYPES = [
  'string',
  'text',
  'int',
  'integer',
  'bigint',
  'float',
  'double',
  'boolean',
  'date',
  'datetime',
  'timestamp',
  'uuid',
];
const DECIMAL_RE = /^decimal\(\d+,\d+\)$/i;

// Normaliza cardinalidad a { '1' | '0..1' | 'N' } o undefined
function normCard(c?: string): '1' | '0..1' | 'N' | undefined {
  if (!c) return undefined;
  const s = String(c).trim().toLowerCase();

  // ↯ NUEVO: tolerar formatos comunes con un solo separador
  const m01 = s.match(/^([01])\s*[,.\-/:]\s*([01])$/);
  if (m01) {
    const a = Number(m01[1]);
    const b = Number(m01[2]);
    if (a === 0 && b === 1) return '0..1';
    if (a === 1 && b === 0) return '1';
  }

  // básicos
  if (s === '1' || s === '1..1') return '1';
  if (s === '0..1' || s === '01' || s === '?') return '0..1';
  if (s === 'n' || s === '*' || s === 'many') return 'N';

  // números sueltos (2,3,…) -> muchos
  if (/^\d+$/.test(s)) return Number(s) <= 1 ? '1' : 'N';

  // rangos colapsados a la tríada
  if (/^(0|1)\.\.(\*|n)$/i.test(s)) return 'N';
  if (/^(1|0)\.\.\*$/i.test(s)) return 'N';
  if (/^(1|0)\.\.n$/i.test(s)) return 'N';

  // N..0 / N..1 / *..0 / *..1 / n..0 / n..1 -> N
  if (/^(\*|n)\.\.(0|1)$/i.test(s)) return 'N';

  // a..b con dígitos
  const m = s.match(/^(\d+)\.\.(\d+)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 && b === 1) return '0..1';
    return b > 1 ? 'N' : '1';
  }

  // notaciones con dos puntos
  if (s === '1:n' || s === 'n:1' || s === 'n:n') return 'N';

  return undefined;
}
function isCardAllowed(c?: string) {
  return normCard(c) !== undefined;
}
function isMany(c?: string) {
  return normCard(c) === 'N';
}
function normalizeKind(kind: RelationKind): RelationKind {
  return kind === 'inheritance' ? 'generalization' : kind;
}
function sanitizeViaLabels(dsl: DSL): DSL {
  const copy: DSL = JSON.parse(JSON.stringify(dsl));
  const entityNames = new Set(
    (copy.entities ?? []).map((e) => e.name.trim().toLowerCase()),
  );

  for (const r of copy.relations ?? []) {
    const viaRaw = (r as any).via ? String((r as any).via).trim() : '';
    if (!viaRaw) continue;

    const viaName = viaRaw.toLowerCase();
    const assocish =
      r.kind === 'association' ||
      r.kind === 'aggregation' ||
      r.kind === 'composition';
    const fromMany = normCard(r.fromCard) === 'N';
    const toMany = normCard(r.toCard) === 'N';
    const joinExists = entityNames.has(viaName);

    // Solo tiene sentido mantener 'via' si:
    //   (a) es relación asociativa
    //   (b) es M:N
    //   (c) la entidad intermedia realmente existe
    if (!assocish || !fromMany || !toMany || !joinExists) {
      delete (r as any).via; // era una etiqueta/rol, no una clase intermedia
    }
  }
  return copy;
}

function normalizeLegacyKinds(dsl: DSL): DSL {
  const copy: DSL = JSON.parse(JSON.stringify(dsl));
  for (const r of copy.relations ?? []) {
    const k = String(r.kind || '').toLowerCase();

    if (k === 'many-to-one') {
      r.kind = 'association' as any;
      r.fromCard = r.fromCard ?? 'N';
      r.toCard = r.toCard ?? '1';
    } else if (k === 'one-to-many') {
      r.kind = 'association' as any;
      r.fromCard = r.fromCard ?? '1';
      r.toCard = r.toCard ?? 'N';
    } else if (k === 'one-to-one') {
      r.kind = 'association' as any;
      r.fromCard = r.fromCard ?? '1';
      r.toCard = r.toCard ?? '1';
    } else if (k === 'many-to-many') {
      r.kind = 'association' as any;
      r.fromCard = r.fromCard ?? 'N';
      r.toCard = r.toCard ?? 'N';
    } else if (k === 'inheritance') {
      // alias clásico → UML 2.5
      r.kind = 'generalization';
    }
  }
  return copy;
}

/* ===========================
 *   Validación UML 2.5 fuerte
 * =========================== */

type Issue = {
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  location?: string;
};
type Report = { errors: Issue[]; warnings: Issue[] };

function validateDSL(dsl: DSL): Report {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const ents = dsl.entities ?? [];
  const rels = dsl.relations ?? [];

  // A) Entidades
  const nameSet = new Set<string>();
  for (const e of ents) {
    const n = e?.name?.trim();
    if (!n) {
      errors.push({
        code: 'ENTITY_NAME_EMPTY',
        severity: 'ERROR',
        message: 'Entidad sin nombre',
      });
      continue;
    }
    if (nameSet.has(n)) {
      errors.push({
        code: 'ENTITY_NAME_DUP',
        severity: 'ERROR',
        message: `Nombre de entidad duplicado: ${n}`,
        location: `/entities[name=${n}]`,
      });
    } else {
      nameSet.add(n);
    }
    if (!CLASS_RE.test(n)) {
      warnings.push({
        code: 'ENTITY_NAME_STYLE',
        severity: 'WARNING',
        message: `Convención recomendada PascalCase: ${n}`,
        location: `/entities[name=${n}]`,
      });
    }

    // Atributos
    const attrNames = new Set<string>();
    for (const a of e.attrs ?? []) {
      const an = a?.name?.trim();
      if (!an) {
        errors.push({
          code: 'ATTR_NAME_EMPTY',
          severity: 'ERROR',
          message: `Atributo sin nombre en ${n}`,
          location: `/entities[name=${n}]`,
        });
        continue;
      }
      if (attrNames.has(an)) {
        errors.push({
          code: 'ATTR_NAME_DUP',
          severity: 'ERROR',
          message: `Atributo duplicado ${n}.${an}`,
          location: `/entities[name=${n}]/attrs[name=${an}]`,
        });
      } else {
        attrNames.add(an);
      }
      if (!ATTR_RE.test(an)) {
        warnings.push({
          code: 'ATTR_NAME_STYLE',
          severity: 'WARNING',
          message: `Convención recomendada camelCase: ${n}.${an}`,
          location: `/entities[name=${n}]/attrs[name=${an}]`,
        });
      }
      const t = String(a.type ?? '').trim();
      const typeOk =
        BASIC_TYPES.includes(t.toLowerCase()) || DECIMAL_RE.test(t);
      if (!typeOk) {
        warnings.push({
          code: 'ATTR_TYPE_UNKNOWN',
          severity: 'WARNING',
          message: `Tipo no estándar ${n}.${an}: "${a.type}"`,
          location: `/entities[name=${n}]/attrs[name=${an}]`,
        });
      }
    }

    // PK obligatoria en clases (no interfaz)
    if (!e.isInterface) {
      const hasPk =
        (e.attrs ?? []).some((a) => a.pk) ||
        (e.attrs ?? []).some((a) => a.name?.toLowerCase() === 'id');
      if (!hasPk) {
        errors.push({
          code: 'MISSING_PK',
          severity: 'ERROR',
          message: `La entidad ${n} no tiene PK`,
          location: `/entities[name=${n}]`,
        });
      }
    }
  }

  // B) Relaciones
  const byName = (nn: string) => ents.find((x) => x.name === nn);
  const seenRel = new Set<string>();
  const genEdges: Array<{ child: string; parent: string }> = [];

  for (const r of rels) {
    const kind = normalizeKind(r.kind);
    if (!VALID_KINDS.has(r.kind)) {
      errors.push({
        code: 'REL_KIND_INVALID',
        severity: 'ERROR',
        message: `Relación.kind inválido: ${r.kind}`,
        location: `/relations[from=${r.from}][to=${r.to}]`,
      });
      continue;
    }

    const A = byName(r.from);
    const B = byName(r.to);
    if (!A || !B) {
      errors.push({
        code: 'REL_ENDPOINT_MISSING',
        severity: 'ERROR',
        message: `Relación con extremos inexistentes: ${r.from}→${r.to}`,
        location: `/relations[from=${r.from}][to=${r.to}]`,
      });
      continue;
    }

    // Duplicados (mismo par y kind)
    const key = `${r.from}→${r.to}#${kind}`;
    if (seenRel.has(key)) {
      errors.push({
        code: 'REL_DUP',
        severity: 'ERROR',
        message: `Relación duplicada ${r.from}→${r.to} (${r.kind})`,
        location: `/relations[from=${r.from}][to=${r.to}]`,
      });
    } else {
      seenRel.add(key);
    }
    if (kind === 'dependency') {
      // Dependency no usa cardinalidades
      if (r.fromCard || r.toCard) {
        errors.push({
          code: 'DEP_NO_CARD',
          severity: 'ERROR',
          message: 'Dependency no usa cardinalidades',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
    }

    // association / aggregation / composition
    if (
      kind === 'association' ||
      kind === 'aggregation' ||
      kind === 'composition'
    ) {
      if (!isCardAllowed(r.fromCard) || !isCardAllowed(r.toCard)) {
        errors.push({
          code: 'CARDINALITY_INVALID',
          severity: 'ERROR',
          message: `Cardinalidad inválida en ${r.from}→${r.to} (${r.fromCard}..${r.toCard})`,
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      if (r.kind === 'composition' && r.from === r.to) {
        errors.push({
          code: 'COMPOSITION_SELF',
          severity: 'ERROR',
          message: 'Composición no puede ser reflexiva',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      if (r.kind === 'aggregation' && r.from === r.to) {
        warnings.push({
          code: 'AGGREGATION_SELF',
          severity: 'WARNING',
          message: 'Agregación reflexiva es inusual',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
    }

    // generalization (Herencia)
    if (kind === 'generalization') {
      if (r.fromCard || r.toCard) {
        errors.push({
          code: 'GEN_NO_CARD',
          severity: 'ERROR',
          message: 'Generalization no usa cardinalidades',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      if (A.isInterface && !B.isInterface) {
        errors.push({
          code: 'GEN_IFACE_TO_CLASS',
          severity: 'ERROR',
          message: 'Interface no generaliza clase; use interface→interface',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      if (!A.isInterface && B.isInterface) {
        errors.push({
          code: 'GEN_CLASS_TO_IFACE',
          severity: 'ERROR',
          message: 'Clase no generaliza interfaz; use realization',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      genEdges.push({ child: r.from, parent: r.to });
    }

    // realization (Clase implementa interfaz)
    if (kind === 'realization') {
      if (r.fromCard || r.toCard) {
        errors.push({
          code: 'REAL_NO_CARD',
          severity: 'ERROR',
          message: 'Realization no usa cardinalidades',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      if (A.isInterface) {
        errors.push({
          code: 'REAL_FROM_MUST_CLASS',
          severity: 'ERROR',
          message: 'Realization: origen debe ser Clase (no interfaz)',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
      if (!B.isInterface) {
        errors.push({
          code: 'REAL_TO_MUST_IFACE',
          severity: 'ERROR',
          message: 'Realization: destino debe ser Interfaz',
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }
    }
    if (r.via) {
      if (r.via === r.from || r.via === r.to) {
        errors.push({
          code: 'VIA_EQUALS_ENDPOINT',
          severity: 'ERROR',
          message: `'via' no puede ser igual a 'from' o 'to' en ${r.from} ↔ ${r.to} (via: ${r.via}).`,
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }

      // Debe existir la entidad intermedia
      const join = findEntity(ents, r.via);
      if (!join) {
        errors.push({
          code: 'VIA_ENTITY_NOT_FOUND',
          severity: 'ERROR',
          message: `La clase intermedia '${r.via}' no existe para la relación ${r.from} ↔ ${r.to}.`,
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      } else {
        // Heurística: la intermedia debería tener FKs hacia A y B
        const aCandidates = candidateFkNames(r.from);
        const bCandidates = candidateFkNames(r.to);

        const hasA = hasAttrByCandidates(join.attrs || [], aCandidates);
        const hasB = hasAttrByCandidates(join.attrs || [], bCandidates);

        if (!hasA && !hasB) {
          errors.push({
            code: 'VIA_MISSING_FKS',
            severity: 'ERROR',
            message:
              `La clase intermedia '${r.via}' no parece tener FKs hacia '${r.from}' ni '${r.to}'. ` +
              `Se esperaban atributos tipo: [${aCandidates.join(', ')}] y/o [${bCandidates.join(', ')}].`,
            location: `/entities[name=${r.via}]`,
          });
        } else {
          if (!hasA) {
            warnings.push({
              code: 'VIA_MISSING_FK_A',
              severity: 'WARNING',
              message:
                `La clase intermedia '${r.via}' no muestra un FK claro hacia '${r.from}'. ` +
                `Posibles nombres: [${aCandidates.join(', ')}].`,
              location: `/entities[name=${r.via}]`,
            });
          }
          if (!hasB) {
            warnings.push({
              code: 'VIA_MISSING_FK_B',
              severity: 'WARNING',
              message:
                `La clase intermedia '${r.via}' no muestra un FK claro hacia '${r.to}'. ` +
                `Posibles nombres: [${bCandidates.join(', ')}].`,
              location: `/entities[name=${r.via}]`,
            });
          }
        }

        // (Opcional) muy pocos atributos en la intermedia
        if (!join.attrs || join.attrs.length < 2) {
          warnings.push({
            code: 'VIA_TOO_FEW_ATTRS',
            severity: 'WARNING',
            message: `La clase intermedia '${r.via}' tiene muy pocos atributos para una tabla de unión.`,
            location: `/entities[name=${r.via}]`,
          });
        }
      }

      // 'via' solo tiene sentido en M:N de tipos asociativos
      const assocish = isAssocKind(kind);
      const manyMany = isMany(r.fromCard) && isMany(r.toCard);
      if (!assocish || !manyMany) {
        warnings.push({
          code: 'VIA_NON_MN',
          severity: 'WARNING',
          message:
            `'via' está definido en una relación que no es M:N (${r.from} ${r.fromCard || '1'} ↔ ` +
            `${r.to} ${r.toCard || '1'}; kind=${kind}).`,
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }

      // Avisar si quedaron relaciones residuales A↔via o B↔via (de la expansión vieja)
      const ghosts = rels.filter(
        (x) =>
          (x.from === r.from && x.to === r.via) ||
          (x.from === r.via && x.to === r.from) ||
          (x.from === r.to && x.to === r.via) ||
          (x.from === r.via && x.to === r.to),
      );
      if (ghosts.length > 0) {
        warnings.push({
          code: 'VIA_GHOST_LINKS',
          severity: 'WARNING',
          message:
            `Existen relaciones residuales con la clase intermedia '${r.via}' (p. ej. A→via o via→B). ` +
            `El modelo visual debe usar UNA sola relación A↔B + línea punteada a '${r.via}'.`,
          location: `/relations[from=${r.from}][to=${r.to}]`,
        });
      }

      // Reutilización de la misma 'via' en parejas distintas (sospechoso)
      const sameViaDifferentPair = rels.some(
        (x) =>
          x !== r &&
          x.via === r.via &&
          !(
            (x.from === r.from && x.to === r.to) ||
            (x.from === r.to && x.to === r.from)
          ),
      );
      if (sameViaDifferentPair) {
        warnings.push({
          code: 'VIA_REUSED',
          severity: 'WARNING',
          message:
            `'${r.via}' se usa como 'via' por más de una pareja de entidades distintas. ` +
            `Revisa que cada M:N tenga su propia clase intermedia (a menos que sea intencional).`,
          location: `/entities[name=${r.via}]`,
        });
      }
    }
  }

  // C) Ciclos y herencia múltiple en clases
  if (genEdges.length) {
    // ciclos
    const cycles = findGeneralizationCycles(genEdges);
    for (const cyc of cycles) {
      errors.push({
        code: 'GEN_CYCLE',
        severity: 'ERROR',
        message: `Ciclo de herencia: ${cyc.join(' -> ')}`,
      });
    }
    // herencia múltiple (solo clases)
    const parentCountByChild = new Map<string, number>();
    for (const { child } of genEdges) {
      parentCountByChild.set(child, (parentCountByChild.get(child) ?? 0) + 1);
    }
    for (const [child, count] of parentCountByChild.entries()) {
      const ent = ents.find((e) => e.name === child);
      if (ent && !ent.isInterface && count > 1) {
        errors.push({
          code: 'GEN_MULTI_CLASS',
          severity: 'ERROR',
          message: `Herencia múltiple no permitida en clase: ${child}`,
        });
      }
    }
  }

  return { errors, warnings };
}

function canonicalName(s: string): string {
  // Normaliza para comparar (ignora espacios, guiones bajos y mayúsculas)
  return (s || '')
    .normalize('NFKD')
    .replace(/[\W_]+/g, '')
    .toLowerCase();
}

function camelBase(entityName: string): string {
  // "Order Item" -> "orderItem"
  return entityName
    .split(/[\s_]+/)
    .map((p, i) =>
      i === 0
        ? p.toLowerCase()
        : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
    )
    .join('');
}

function candidateFkNames(entityName: string): string[] {
  const base = camelBase(entityName); // orderItem
  // Genera variantes habituales de FK
  return [
    base, // orderItem
    `${base}Id`, // orderItemId
    `${base}_id`, // orderItem_id
    `${base}ID`, // orderItemID
    `${base}Uuid`,
    `${base}_uuid`, // orderItemUuid (si usas uuid)
    `${base}Pk`,
    `${base}_pk`, // orderItemPk
  ];
}

function hasAttrByCandidates(
  attrs: { name: string }[] = [],
  candidates: string[],
): boolean {
  const canonCandidates = new Set(candidates.map(canonicalName));
  return attrs.some((a) => canonCandidates.has(canonicalName(a.name)));
}

function findEntity(entities: Entity[], name: string): Entity | undefined {
  return entities.find((e) => e.name === name);
}

function isAssocKind(kind: Relation['kind']): boolean {
  return (
    kind === 'association' || kind === 'aggregation' || kind === 'composition'
  );
}

function ensureValidOrThrow(dsl: DSL) {
  const { errors, warnings } = validateDSL(dsl);
  if (errors.length) {
    const summary = errors
      .slice(0, 3)
      .map((e) => e.message)
      .join(' | ');
    throw new BadRequestException({
      message: `Modelo inválido: ${summary}${errors.length > 3 ? ` (+${errors.length - 3} más)` : ''}`,
      errors,
      warnings,
    });
  }
}

/* ==========================
 *   Expansión M:N (opcional)
 * ========================== */

function camelId(name: string) {
  const base = name || 'Ref';
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}Id`;
}

function genJoinName(a: string, b: string, existing: Set<string>) {
  const [x, y] = a <= b ? [a, b] : [b, a]; // orden lexicográfico estable
  let base = `${x}${y}Join`;
  let i = 1;
  while (existing.has(base)) {
    base = `${base}${i++}`;
  }
  return base;
}
function genJoinBase(a: string, b: string) {
  const [x, y] = a <= b ? [a, b] : [b, a];
  return `${x}${y}Join`;
}
function resolveJoinName(
  r: Relation,
  ents: Entity[],
  toAddEnts: Entity[],
  allNames: Set<string>,
): string {
  // 1) Si el usuario especificó via, úsala tal cual
  if (r.via) return r.via;

  // 2) Nombre base estable y simétrico
  const base = genJoinBase(r.from, r.to);

  // 3) Si ya existe (creada manualmente o en este mismo ciclo), REUTILIZA
  const existsBase =
    ents.some((e) => e.name === base) || toAddEnts.some((e) => e.name === base);
  if (existsBase) return base;

  // 4) Si el base está libre, úsalo
  if (!allNames.has(base)) return base;

  // 5) Fallback ultra defensivo: genera un nombre único (p.ej. ...Join1)
  //    Solo si hay una colisión real con otra entidad no relacionada
  return genJoinName(r.from, r.to, allNames);
}
function expandManyToMany(dsl: DSL): DSL {
  const copy: DSL = JSON.parse(JSON.stringify(dsl));
  const ents = copy.entities ?? [];
  const rels = copy.relations ?? [];
  const toAddEnts: Entity[] = [];

  // Conjunto de nombres existentes (incluye lo que se vaya agregando)
  const allNames = new Set(ents.map((e) => e.name));

  for (const r of rels) {
    const kind = normalizeKind(r.kind);
    const isAssocish =
      kind === 'association' ||
      kind === 'aggregation' ||
      kind === 'composition';
    if (!isAssocish) continue;

    if (!(isMany(r.fromCard) && isMany(r.toCard))) continue; // solo M:N

    const A = ents.find((e) => e.name === r.from);
    const B = ents.find((e) => e.name === r.to);
    if (!A || !B) continue;

    // *** FIX: resolver nombre reusando base si existe ***
    const joinName = resolveJoinName(r, ents, toAddEnts, allNames);

    // Buscar si ya la tenemos (persistida o en cola)
    let join =
      ents.find((e) => e.name === joinName) ||
      toAddEnts.find((e) => e.name === joinName);

    // Crear solo si no existe
    if (!join) {
      join = {
        name: joinName,
        attrs: [
          { name: camelId(A.name), type: 'uuid', pk: true },
          { name: camelId(B.name), type: 'uuid', pk: true },
        ],
      };
      toAddEnts.push(join);
      allNames.add(joinName);
    }

    // Marcar la relación con su association class
    (r as any).via = joinName;
  }

  copy.entities = ents.concat(toAddEnts);
  // copy.relations ya es la misma referencia
  return copy;
}

/* ==========================
 *   Ciclos de generalización
 * ========================== */

function findGeneralizationCycles(
  edges: Array<{ child: string; parent: string }>,
): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const { child, parent } of edges) {
    if (!graph.has(child)) graph.set(child, new Set());
    graph.get(child)!.add(parent);
  }
  const cycles: string[][] = [];
  const temp = new Set<string>();
  const perm = new Set<string>();

  function dfs(node: string, stack: string[]) {
    if (perm.has(node)) return;
    if (temp.has(node)) {
      const i = stack.indexOf(node);
      cycles.push(stack.slice(i).concat(node));
      return;
    }
    temp.add(node);
    stack.push(node);
    for (const p of graph.get(node) ?? []) dfs(p, stack);
    stack.pop();
    temp.delete(node);
    perm.add(node);
  }

  for (const n of graph.keys()) dfs(n, []);
  return cycles;
}

/* ==========================
 *   Servicio principal
 * ========================== */

@Injectable()
export class ModelsService {
  constructor(private prisma: PrismaService) {}

  private async getOrCreateDefaultBranch(projectId: string, userId: string) {
    let b = await this.prisma.branch.findFirst({
      where: { projectId, isDefault: true },
    });
    if (!b) {
      b = await this.prisma.branch.create({
        data: {
          projectId,
          name: 'main',
          isDefault: true,
          createdById: userId,
          description: 'Default branch',
        },
      });
    }
    return b;
  }

  private async latestVersion(projectId: string, branchId?: string) {
    return this.prisma.modelVersion.findFirst({
      where: { projectId, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCurrent(projectId: string, userId: string, branchId?: string) {
    const branch = branchId
      ? await this.prisma.branch.findFirst({
          where: { id: branchId, projectId },
        })
      : await this.getOrCreateDefaultBranch(projectId, userId);
    if (!branch) throw new NotFoundException('Branch no encontrada');

    const ver = await this.latestVersion(projectId, branch.id);
    if (ver)
      return { branchId: branch.id, versionId: ver.id, content: ver.content };

    // No hay versión: crea una vacía
    const created = await this.prisma.modelVersion.create({
      data: {
        projectId,
        branchId: branch.id,
        authorId: userId,
        message: 'init: empty model',
        content: { entities: [], relations: [], constraints: [] } as any,
      },
    });
    return {
      branchId: branch.id,
      versionId: created.id,
      content: created.content,
    };
  }

  async saveNewVersion(
    projectId: string,
    userId: string,
    body: { branchId?: string; message?: string; content: DSL },
  ) {
    const branch = body.branchId
      ? await this.prisma.branch.findFirst({
          where: { id: body.branchId, projectId },
        })
      : await this.getOrCreateDefaultBranch(projectId, userId);
    if (!branch) throw new NotFoundException('Branch no encontrada');

    const prev = await this.latestVersion(projectId, branch.id);
    const content = body.content;

    // 0) Normalizar alias heredados (many-to-one, etc. + inheritance)
    const normalized = normalizeLegacyKinds(content);

    // NUEVO: eliminar 'via' inválidas (etiquetas verbales y no-M:N)
    const sanitized = sanitizeViaLabels(normalized);

    // Expandir M:N (usa 'via' válida o genera join name estable)
    const finalDsl = expandManyToMany(sanitized);

    // Validar (sobre el DSL saneado)
    ensureValidOrThrow(sanitized);

    const created = await this.prisma.modelVersion.create({
      data: {
        projectId,
        branchId: branch.id,
        parentVersionId: prev?.id ?? null,
        authorId: userId,
        message: body.message ?? 'edit',
        content: finalDsl as any,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        projectId,
        actorId: userId,
        action: 'MODEL_SNAPSHOT',
        targetType: 'ModelVersion',
        targetId: created.id,
        metadata: { message: created.message },
      },
    });

    return { versionId: created.id, createdAt: created.createdAt };
  }
}
