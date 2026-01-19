import { Injectable, Logger } from '@nestjs/common';
import * as Tesseract from 'tesseract.js';
import sharp from 'sharp';

type EntityAttr = {
  name: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  nullable?: boolean;
};
type ParsedAttr = {
  name: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  nullable?: boolean;
  visibility?: '+' | '-' | '#' | '~';
};
type Entity = {
  name: string;
  stereotype?: string;
  isInterface?: boolean;
  isAbstract?: boolean;
  attrs: EntityAttr[];
};
type Relation = {
  from: string;
  to: string;
  kind:
    | 'association'
    | 'aggregation'
    | 'composition'
    | 'generalization'
    | 'realization'
    | 'dependency';
  fromCard?: string;
  toCard?: string;
  via?: string;
};
export type DSL = {
  entities: Entity[];
  relations: Relation[];
  constraints?: any[];
};

// ------------ util de normalización/dedupe ------------
function stripDiacritics(s: string) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
function keyEq(a: string, b: string) {
  return stripDiacritics(a) === stripDiacritics(b);
}
function looksLikeMethod(line: string): boolean {
  const L = line.trim();
  return /[A-Za-z_]\w*\s*\(.*\)/.test(L);
}

// ------------ Parser de atributos (más flexible) ------------
function parseAttributeLine(line: string): ParsedAttr | null {
  const L = line
    .replace(/[–—]/g, '-') // dash raros
    .replace(/[•·]/g, '-') // bullets
    .replace(/\s+/g, ' ')
    .trim();
  if (!L) return null;
  if (looksLikeMethod(L)) return null;

  // 1) patrón completo con visibilidad/flags (Unicode)
  let m =
    L.match(
      /^([+\-#~])?\s*([\p{L}_][\p{L}\p{N}_$]*\*?)\s*(?::\s*([^=<{]+(?:<[^>]+>)?(?:\[\])?|\S+))?\s*(?:=\s*[^{}]+)?\s*(?:\{([^}]*)\})?$/u,
    ) || null;

  // 2) más relajado: [-•]? name [: type] (sin flags)
  if (!m) {
    m = L.match(
      /^(?:[+\-#~•·])?\s*([\p{L}_][\p{L}\p{N}_$]*\*?)\s*(?::\s*([^=<{]+(?:<[^>]+>)?(?:\[\])?|\S+))?\s*$/u,
    ) as RegExpMatchArray | null;
    if (m) {
      m = [, undefined, m[1], m[2], undefined] as any;
    }
  }

  // 3) ultra-simple: name type   (sin ':')
  if (!m) {
    const ms = L.match(
      /^([\p{L}_][\p{L}\p{N}_$]*\*?)\s+([A-Za-z][\w<>,().\[\]]*)$/u,
    );
    if (ms) m = [, undefined, ms[1], ms[2], undefined] as any;
  }

  if (!m) return null;

  const [, vis, rawName, rawType, flagsRaw] = m;

  const name = (rawName ?? '').replace(/\*+$/, '');
  let type = ((rawType ?? '').trim() || 'any').trim();

  // nullability con sufijo ?
  let nullable = /\?$/.test(type);
  type = type.replace(/\?$/, '');

  const flags = (flagsRaw || '').toLowerCase();

  const attr: ParsedAttr = {
    name,
    type: type.replace(/\s+/g, ' ').trim(),
    visibility: (vis as ParsedAttr['visibility']) || undefined,
    pk: /\bpk\b/.test(flags) || /\*$/.test(rawName || ''),
    unique: /\bunique\b/.test(flags),
    nullable: nullable || /\bnull(?:able)?\b/.test(flags),
  };

  return attr.name ? attr : null;
}

function parseAttributesFromBlock(block: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  const lines = block
    .split(/\r?\n/)
    .map((s) => s.replace(/[│┃|]+/g, ' ').trim())
    .filter((s) => !!s && !/^(-{2,}|={2,}|_+)$/.test(s))
    .filter(
      (s) => !/^(atributos|attributes|propiedades|properties)\b/i.test(s),
    );

  for (const line of lines) {
    const parsed = parseAttributeLine(line);
    if (parsed) attrs.push(parsed);
  }

  const dedup = new Map<string, ParsedAttr>();
  for (const a of attrs) {
    const key = stripDiacritics(a.name);
    if (!dedup.has(key)) dedup.set(key, a);
  }
  return [...dedup.values()];
}

function extractStereotype(line: string): string | '' {
  const trimmed = line.trim();
  const m1 = trimmed.match(/^<<\s*([^>]+)\s*>>$/i);
  if (m1) return m1[1].trim();
  const m2 = trimmed.match(/^«\s*([^»]+)\s*»$/i);
  if (m2) return m2[1].trim();
  return '';
}

@Injectable()
export class UmlVisionService {
  private readonly logger = new Logger(UmlVisionService.name);

  // ---------- Normalización & Relaciones ----------
  private normalizeOcr(raw: string): string {
    return (raw || '')
      .replace(/[–—−]/g, '-') // guiones
      .replace(/[•·]/g, '.') // bullets
      .replace(/[→➔➤➝➛➜]/g, '>') // flechas a '>'
      .replace(/[“”]/g, '"')
      .replace(/\u00A0/g, ' ')
      .replace(/[丨┃┆┊│]/g, '|') // variantes de barras verticales
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  private parseCardinality(raw?: string): string | undefined {
    if (raw == null) return undefined;

    let t = String(raw).trim().toLowerCase();
    if (!t || t === 'undefined' || t === 'null') return undefined;

    // quitar espacios y unificar símbolos
    t = t.replace(/\s+/g, '');
    t = t.replace(/\*/g, 'n'); // * -> n para normalizar primero

    // valores simples
    if (t === 'n') return 'N';
    if (/^\d+$/.test(t)) return t;

    // rangos válidos
    if (/^\d+\.\.\d+$/.test(t)) return t;
    if (/^\d+\.\.n$/.test(t)) return t.replace(/n$/, 'N');
    if (/^n\.\.\d+$/.test(t)) return 'N..' + t.split('..')[1];

    // alias comunes
    if (t === '0..*' || t === '0..n') return '0..N';
    if (t === '1..*' || t === '1..n') return '1..N';

    return undefined;
  }

  private sanitizeCardinality(raw?: string): string | undefined {
    if (raw == null) return undefined;

    let t = String(raw).trim().toLowerCase();
    if (!t || t === 'undefined' || t === 'null') return undefined;

    // normalizaciones básicas
    t = t.replace(/\s+/g, '');
    t = t.replace(/\*/g, 'N').replace(/n/g, 'N');

    // "1..1..N" → "1..N" ; "undefined..1..N" → "1..N"
    if (t.includes('..')) {
      const parts = t
        .split('..')
        .map((p) => p.replace(/[^0-9N]/g, ''))
        .filter(Boolean);
      if (parts.length >= 2) {
        t = `${parts[0]}..${parts[parts.length - 1]}`;
      }
    }

    // alias comunes
    if (t === 'N') return 'N';
    if (/^\d+$/.test(t)) return t;
    if (/^\d+\.\.\d+$/.test(t)) return t;
    if (/^\d+\.\.N$/.test(t)) return t;
    if (/^N\.\.\d+$/.test(t)) return t;
    if (/^0\.\.\*$/.test(t)) return '0..N';
    if (/^1\.\.\*$/.test(t)) return '1..N';
    if (/^0\.\.n$/i.test(t)) return '0..N';
    if (/^1\.\.n$/i.test(t)) return '1..N';

    // fallback a tu parser existente
    return this.parseCardinality(t);
  }

  private splitHeaderCollapsed(
    line: string,
  ): { name: string; firstAttr?: string } | null {
    const cleaned = line
      .replace(/[“”"']/g, '')
      .replace(/[|]+$/g, '')
      .trim();

    const m = cleaned.match(
      /^([\p{L}_][\p{L}\p{N}_\s]{0,80}?)(?:\s*[|:])?\s*(?:[-–—]\s*(.+))?$/u,
    );
    if (!m) return null;

    const name = (m[1] || '').trim();
    const rest = (m[2] || '').trim();
    if (!name) return null;

    if (rest && !/^[+\-#~]/.test(rest)) return { name, firstAttr: `-${rest}` };
    if (rest) return { name, firstAttr: rest };
    return { name };
  }

  private extractRelationsFromOcr(
    ocrText: string,
    entityNames: string[],
  ): Relation[] {
    const txt = this.normalizeOcr(ocrText);
    const names = new Set(entityNames.map(stripDiacritics));
    const relations: Relation[] = [];

    const NAME = '([\\p{L}_][\\p{L}\\p{N}_]*)';
    const CARD_OPT =
      '(?:\\s*(?:\\[\\s*([0-9\\*nN.\\s]+)\\s*\\]|([0-9\\*nN.\\s]{1,6})))?';

    const patterns: Array<{ re: RegExp; kind: Relation['kind'] }> = [
      {
        re: new RegExp(
          `${NAME}${CARD_OPT}\\s*(?:\\.{2}|-){2}\\|>\\s*${NAME}${CARD_OPT}`,
          'gu',
        ),
        kind: 'generalization',
      },
      {
        re: new RegExp(
          `${NAME}${CARD_OPT}\\s*\\.{2}\\|>\\s*${NAME}${CARD_OPT}`,
          'gu',
        ),
        kind: 'realization',
      },
      {
        re: new RegExp(`${NAME}${CARD_OPT}\\s*o--\\s*${NAME}${CARD_OPT}`, 'gu'),
        kind: 'aggregation',
      },
      {
        re: new RegExp(
          `${NAME}${CARD_OPT}\\s*\\*--\\s*${NAME}${CARD_OPT}`,
          'gu',
        ),
        kind: 'composition',
      },
      {
        re: new RegExp(
          `${NAME}${CARD_OPT}\\s*\\.{2}>\\s*${NAME}${CARD_OPT}`,
          'gu',
        ),
        kind: 'dependency',
      },
      {
        re: new RegExp(`${NAME}${CARD_OPT}\\s*--\\s*${NAME}${CARD_OPT}`, 'gu'),
        kind: 'association',
      },
    ];

    const pushUnique = (r: Relation) => {
      const exists = relations.some(
        (x) =>
          keyEq(x.from, r.from) &&
          keyEq(x.to, r.to) &&
          x.kind === r.kind &&
          (x.fromCard ?? '') === (r.fromCard ?? '') &&
          (x.toCard ?? '') === (r.toCard ?? '') &&
          (x.via ?? '') === (r.via ?? ''),
      );
      if (!exists) relations.push(r);
    };

    for (const { re, kind } of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        const from = m[1],
          to = m[4];
        if (
          !names.has(stripDiacritics(from)) ||
          !names.has(stripDiacritics(to))
        )
          continue;
        const fromCard = this.sanitizeCardinality(m[2] || m[3]);
        const toCard = this.sanitizeCardinality(m[5] || m[6]);
        pushUnique({ from, to, kind, fromCard, toCard });
      }
    }

    // A -- X -- B  → via
    const tri = new RegExp(`${NAME}\\s*--\\s*${NAME}\\s*--\\s*${NAME}`, 'gu');
    let t: RegExpExecArray | null;
    while ((t = tri.exec(txt)) !== null) {
      const a = t[1],
        mid = t[2],
        b = t[3];
      if (![a, mid, b].every((n) => names.has(stripDiacritics(n)))) continue;
      pushUnique({ from: a, to: b, kind: 'association', via: mid });
    }

    return relations;
  }

  // ---------- Gemini (visión semántica en imagen) ----------
  private normalizeRelKind(k: string): Relation['kind'] | null {
    const m = (k || '').toLowerCase().trim();
    if (['association', 'assoc', 'link', 'relation'].includes(m))
      return 'association';
    if (
      ['aggregation', 'aggregate', 'agregacion', 'agregación', 'o--'].includes(
        m,
      )
    )
      return 'aggregation';
    if (['composition', 'composicion', 'composición', '*--'].includes(m))
      return 'composition';
    if (
      [
        'generalization',
        'generalizacion',
        'generalización',
        'herencia',
        'inheritance',
        '<|--',
      ].includes(m)
    )
      return 'generalization';
    if (
      [
        'realization',
        'realizacion',
        'realización',
        'implements',
        '<|..',
      ].includes(m)
    )
      return 'realization';
    if (['dependency', 'dependencia', '..>'].includes(m)) return 'dependency';
    return null;
  }

  private async tryGeminiExtract(
    buffer: Buffer,
    mime: string = 'image/png',
  ): Promise<DSL | null> {
    const apiKey =
      process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) return null;

    let GoogleGenerativeAI: any;
    try {
      ({ GoogleGenerativeAI } = await import('@google/generative-ai'));
    } catch {
      this.logger.warn('[Gemini] @google/generative-ai no instalado');
      return null;
    }

    const client = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const model = client.getGenerativeModel({ model: modelName });

    // Prompt “duro” sin responseSchema (compatible v1/v1beta)
    const prompt = `Eres experto en UML 2.x. Analiza la IMAGEN (diagrama de clases) y devuelve SOLO JSON válido:
{
  "entities":[
    {"name":"", "stereotype":null, "isInterface":false, "isAbstract":false,
     "attrs":[{"name":"","type":"any","pk":false,"unique":false,"nullable":false}]}
  ],
  "relations":[
    {"from":"","to":"","kind":"association|aggregation|composition|generalization|realization|dependency",
     "fromCard":null,"toCard":null,"via":null}
  ]
}
Reglas:
- "entities": todas las clases. "attrs": atributos visibles. Si no ves tipo, usa "any".
- Marca "isInterface"/"isAbstract" si aplica; "stereotype" si aparece (o null).
- "relations": todas las relaciones con "kind" correcto (herencia=generalization, rombo blanco=aggregation, rombo negro=composition, punteada=dependency, triángulo punteado=realization, línea simple=association).
- "fromCard"/"toCard": cardinalidades ("1","0..1","1..*","*","0..N","1..N") si se ven; si no, null.
- No agregues texto fuera del JSON.`;

    // Imagen -> base64
    const base64 = buffer.toString('base64');

    // Utilidad para parsear JSON tolerante
    const parseJsonSafe = (s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start >= 0 && end > start) {
          return JSON.parse(s.slice(start, end + 1));
        }
        throw new Error('Invalid JSON from model');
      }
    };

    try {
      const result = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { data: base64, mimeType: mime } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json', // sin responseSchema
          temperature: 0.2,
          // maxOutputTokens: 8192, // opcional
        },
      });

      const text = result?.response?.text?.() ?? '';
      const json = parseJsonSafe(text);

      // Sanitizar a tu DSL
      const entities: Entity[] = Array.isArray(json.entities)
        ? json.entities
            .map((e: any) => ({
              name: String(e?.name || '').trim(),
              stereotype: e?.stereotype ?? undefined,
              isInterface: !!e?.isInterface,
              isAbstract: !!e?.isAbstract,
              attrs: Array.isArray(e?.attrs)
                ? e.attrs.map((a: any) => ({
                    name: String(a?.name || '').trim(),
                    type: String(a?.type || 'any').trim(),
                    pk: !!a?.pk,
                    unique: !!a?.unique,
                    nullable: !!a?.nullable,
                  }))
                : [],
            }))
            .filter((e: Entity) => !!e.name)
        : [];

      const normCard = (v: any): string | undefined => {
        const s = (v ?? '').toString().trim();
        if (!s) return undefined;

        // ↯ NUEVO: normalizar "0.1", "1.0", "0-1", "1-0", "0/1", "1/0", "0,1", "1,0"
        const m01 = s.toLowerCase().match(/^([01])\s*[,.\-/:]\s*([01])$/);
        if (m01) {
          const a = Number(m01[1]);
          const b = Number(m01[2]);
          if (a === 0 && b === 1) return '0..1';
          if (a === 1 && b === 0) return '1';
        }

        if (s === '*' || s.toLowerCase() === 'n') return 'N';
        if (/^\d+$/.test(s)) return s;
        if (/^\d+\.\.\d+$/.test(s)) return s;
        if (/^\d+\.\.[*nN]$/.test(s)) return s.replace(/[*nN]$/, 'N');
        return undefined;
      };

      const kindMap = (k: string): Relation['kind'] | null => {
        const m = (k || '').toLowerCase().trim();
        if (['association', 'assoc', 'link', 'relation', '--'].includes(m))
          return 'association';
        if (
          [
            'aggregation',
            'agregacion',
            'agregación',
            'o--',
            'diamond',
          ].includes(m)
        )
          return 'aggregation';
        if (
          [
            'composition',
            'composicion',
            'composición',
            '*--',
            'filled-diamond',
          ].includes(m)
        )
          return 'composition';
        if (
          [
            'generalization',
            'generalizacion',
            'generalización',
            'herencia',
            'inheritance',
            '<|--',
          ].includes(m)
        )
          return 'generalization';
        if (
          [
            'realization',
            'realizacion',
            'realización',
            'implements',
            '<|..',
          ].includes(m)
        )
          return 'realization';
        if (['dependency', 'dependencia', '..>', 'dashed'].includes(m))
          return 'dependency';
        return null;
      };

      const relations: Relation[] = Array.isArray(json.relations)
        ? (json.relations
            .map((r: any) => {
              const kind = kindMap(String(r?.kind || ''));
              if (!kind) return null;
              return {
                from: String(r?.from || '').trim(),
                to: String(r?.to || '').trim(),
                kind,
                fromCard: normCard(r?.fromCard),
                toCard: normCard(r?.toCard),
                via: r?.via ? String(r.via).trim() : undefined,
              } as Relation;
            })
            .filter(Boolean) as Relation[])
        : [];

      return { entities, relations, constraints: [] };
    } catch (err) {
      this.logger.warn(
        `[Gemini] fallo al generar/parsear JSON: ${String(err)}`,
      );
      return null;
    }
  }

  // ---------- OCR multipass (varias imágenes y PSM) ----------
  /** CLAHE si está disponible en la versión de sharp; si no, usa un pseudo-contraste local */
  private async tryClahe(base: Buffer): Promise<Buffer> {
    try {
      const anySharp: any = sharp(base) as any;
      if (typeof anySharp.clahe === 'function') {
        return await anySharp
          .clahe({ width: 32, height: 32, maxSlope: 10 })
          .toBuffer();
      }
    } catch {}
    return await sharp(base).gamma(0.9).linear(1.1).toBuffer();
  }

  private async buildCandidates(
    buf: Buffer,
  ): Promise<Array<{ tag: string; img: Buffer }>> {
    const candidates: Array<{ tag: string; img: Buffer }> = [];

    const meta = await sharp(buf).metadata();
    const w = meta.width || 0,
      h = meta.height || 0;

    const base = await sharp(buf)
      .grayscale()
      .normalize()
      .sharpen()
      .toFormat('png')
      .toBuffer();

    candidates.push({
      tag: 'th150',
      img: await sharp(base).threshold(150).toBuffer(),
    });
    candidates.push({
      tag: 'th175',
      img: await sharp(base).threshold(175).toBuffer(),
    });
    candidates.push({
      tag: 'th190',
      img: await sharp(base).threshold(190).toBuffer(),
    });

    const clahe = await this.tryClahe(base);
    candidates.push({ tag: 'clahe', img: clahe });
    candidates.push({
      tag: 'clahe-th180',
      img: await sharp(clahe).threshold(180).toBuffer(),
    });
    candidates.push({
      tag: 'neg',
      img: await sharp(clahe).negate().toBuffer(),
    });

    if (w && h) {
      const up2 = await sharp(clahe)
        .resize(Math.round(w * 2), Math.round(h * 2), {
          withoutEnlargement: false,
        })
        .threshold(175)
        .toBuffer();
      candidates.push({ tag: 'clahe-up2x', img: up2 });

      const up3 = await sharp(clahe)
        .resize(Math.round(w * 3), Math.round(h * 3), {
          withoutEnlargement: false,
        })
        .threshold(175)
        .toBuffer();
      candidates.push({ tag: 'clahe-up3x', img: up3 });
    }

    return candidates;
  }

  private async recognizeWith(image: Buffer, psm: number) {
    const { data } = await Tesseract.recognize(image, 'eng+spa', {
      logger: (m: any) => {
        const p =
          typeof m?.progress === 'number' ? Math.round(m.progress * 100) : 0;
        this.logger.debug(`${m?.status ?? 'ocr'}: ${p}%`);
      },
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      tessjs_create_tsv: '1',
      tessedit_char_blacklist: '{}[]',
    } as any);
    return data;
  }

  private scoreDsl(dsl: DSL) {
    return (
      (dsl.entities?.length ?? 0) * 100 + (dsl.relations?.length ?? 0) * 10
    );
  }

  /** Parsea el TSV de Tesseract (level=5 → word) a cajas de palabra */
  private wordsFromTsv(tsv?: string): Array<{
    text: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    line: number;
  }> {
    if (!tsv) return [];
    const out: any[] = [];
    const rows = tsv.split('\n');
    for (const row of rows) {
      if (!row || row.startsWith('level')) continue;
      const cols = row.split('\t');
      if (cols.length < 12) continue;
      const level = Number(cols[0]);
      if (level !== 5) continue;
      const left = Number(cols[6]) || 0;
      const top = Number(cols[7]) || 0;
      const width = Number(cols[8]) || 0;
      const height = Number(cols[9]) || 0;
      const lineNum = Number(cols[4]) || 0;
      const text = cols[11] || '';
      if (!text.trim()) continue;
      out.push({
        text,
        x0: left,
        y0: top,
        x1: left + width,
        y1: top + height,
        line: lineNum,
      });
    }
    return out;
  }

  /** Normaliza items de 'words' si existen en algunos builds */
  private normalizeWordItems(words: any[]): Array<{
    text: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    line: number;
  }> {
    const out: any[] = [];
    for (const w of words || []) {
      const text = (w.text ?? '').toString();
      const bb = (w.bbox || (w as any).boundingBox || {}) as any;
      const x0 = Number(bb.x0 ?? bb.left ?? (w as any).x0 ?? 0);
      const y0 = Number(bb.y0 ?? bb.top ?? (w as any).y0 ?? 0);
      const x1 = Number(bb.x1 ?? x0 + (bb.width ?? (w as any).w ?? 0));
      const y1 = Number(bb.y1 ?? y0 + (bb.height ?? (w as any).h ?? 0));
      const line = Number((w as any).line ?? (w as any).line_num ?? 0);
      if (text.trim()) out.push({ text, x0, y0, x1, y1, line });
    }
    return out;
  }

  /** Reconstruye texto por BLOQUES a partir de cajas de palabras */
  private buildBlocksFromWords(
    words: Array<{
      text: string;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      line: number;
    }>,
  ): string {
    const groups = new Map<
      number,
      { x0: number; y0: number; x1: number; y1: number; text: string }
    >();
    for (const w of words) {
      const key =
        Number.isFinite(w.line) && w.line > 0 ? w.line : Math.round(w.y0 / 12);
      const g = groups.get(key);
      if (!g)
        groups.set(key, {
          x0: w.x0,
          y0: w.y0,
          x1: w.x1,
          y1: w.y1,
          text: w.text,
        });
      else {
        g.x0 = Math.min(g.x0, w.x0);
        g.y0 = Math.min(g.y0, w.y0);
        g.x1 = Math.max(g.x1, w.x1);
        g.y1 = Math.max(g.y1, w.y1);
        g.text += ' ' + w.text;
      }
    }
    const lines = Array.from(groups.values())
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
      .map((l) => ({
        ...l,
        text: (l.text || '').replace(/[|:]+$/g, '').trim(),
      }))
      .filter((l) => l.text);

    const out: string[] = [];
    const Y_GAP = 26,
      X_SHIFT = 100;
    for (let i = 0; i < lines.length; i++) {
      const curr = lines[i];
      out.push(curr.text);
      const next = lines[i + 1];
      if (!next) break;
      const gapY = next.y0 - curr.y1;
      const shiftX = Math.abs(next.x0 - curr.x0);
      if (gapY > Y_GAP || shiftX > X_SHIFT) out.push('');
    }
    return out.join('\n');
  }

  // ---------- Texto → DSL ----------
  private textToDsl(text: string): DSL {
    const normalized = this.normalizeOcr(text)
      .replace(/[“”]/g, '')
      .replace(/\|+/g, (m) => (m.length <= 2 ? '' : m));

    const blocks = normalized
      .split(/\n{2,}|(?:\-{3,}|\={3,})\n/)
      .map((b) => b.trim())
      .filter(Boolean);

    const entities: Entity[] = [];

    for (const b of blocks) {
      const lines = b
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) continue;

      const stereotype = extractStereotype(lines[0]);
      const nameLineIdx = stereotype ? 1 : 0;

      const cleanLine = (s: string) =>
        s
          .replace(/[|:]+$/g, '')
          .replace(/\s+/g, ' ')
          .trim();

      let raw = cleanLine(lines[nameLineIdx] || '');
      let header = this.splitHeaderCollapsed(raw);
      if (!header) {
        for (let i = 0; i < Math.min(3, lines.length) && !header; i++) {
          const cand = cleanLine(lines[i] || '');
          header = this.splitHeaderCollapsed(cand);
        }
      }
      if (!header || header.name.length > 100) continue;
      if (!/^[\p{L}_][\p{L}\p{N}_\s]*$/u.test(header.name)) continue;

      const className = header.name;

      const lowerAll = [stereotype, ...lines.slice(0, nameLineIdx + 1)]
        .join(' ')
        .toLowerCase();
      const isInterface =
        /(^|[\s«<])interface([»>]|$)/i.test(stereotype || '') ||
        /\binterface\b/.test(lowerAll);
      const isAbstract =
        /(^|[\s«<])abstract([»>]|$)/i.test(stereotype || '') ||
        /\babstract\b/.test(lowerAll);

      const tail = lines.slice(nameLineIdx + 1);
      const attrsLines = [
        ...(header.firstAttr ? [header.firstAttr] : []),
        ...tail,
      ];

      const parsedAttrs = parseAttributesFromBlock(attrsLines.join('\n'));
      const mappedAttrs: EntityAttr[] = parsedAttrs.map((a) => ({
        name: a.name,
        type: a.type,
        pk: !!a.pk,
        unique: !!a.unique,
        nullable: !!a.nullable,
      }));

      const existing = entities.find((e) => keyEq(e.name, className));
      if (existing) {
        existing.stereotype ||= stereotype || undefined;
        (existing as any).isInterface ||= isInterface || undefined;
        (existing as any).isAbstract ||= isAbstract || undefined;
        existing.attrs ||= [];
        for (const a of mappedAttrs) {
          if (!existing.attrs.some((x) => keyEq(x.name, a.name)))
            existing.attrs.push(a);
        }
      } else {
        entities.push({
          name: className,
          stereotype: stereotype || undefined,
          isInterface: isInterface || undefined,
          isAbstract: isAbstract || undefined,
          attrs: mappedAttrs,
        });
      }
    }

    // Fallback secuencial si no hubo bloques
    if (entities.length === 0) {
      const lines = normalized
        .split('\n')
        .map((s) =>
          s
            .replace(/[“”"']/g, '')
            .replace(/[|:]+$/g, '')
            .trim(),
        )
        .filter(Boolean);

      let curName: string | null = null;
      let curAttrs: string[] = [];

      const flush = () => {
        if (!curName) return;
        const parsedAttrs = parseAttributesFromBlock(curAttrs.join('\n'));
        const mappedAttrs: EntityAttr[] = parsedAttrs.map((a) => ({
          name: a.name,
          type: a.type,
          pk: !!a.pk,
          unique: !!a.unique,
          nullable: !!a.nullable,
        }));

        const existing = entities.find((e) => keyEq(e.name, curName!));
        if (existing) {
          for (const a of mappedAttrs) {
            if (!existing.attrs.some((x) => keyEq(x.name, a.name)))
              existing.attrs.push(a);
          }
        } else {
          entities.push({ name: curName!, attrs: mappedAttrs } as any);
        }
        curName = null;
        curAttrs = [];
      };

      for (const line of lines) {
        const header = this.splitHeaderCollapsed(line);
        if (header && /^[\p{L}_][\p{L}\p{N}_\s]*$/u.test(header.name)) {
          flush();
          curName = header.name;
          if (header.firstAttr) curAttrs.push(header.firstAttr);
          continue;
        }
        if (!curName) continue;
        curAttrs.push(line);
      }
      flush();
    }

    const entityNames = entities.map((e) => e.name);
    const relations = this.extractRelationsFromOcr(normalized, entityNames);

    return this.finalizeDsl({ entities, relations, constraints: [] });
  }

  // ---------- Autofix: PKs, ruido, dedupe, relaciones válidas ----------
  private finalizeDsl(dsl: DSL): DSL {
    // --- limpiar/merge entidades ---
    const cleaned: Entity[] = [];
    const seen = new Map<string, Entity>();

    for (const rawE of dsl.entities || []) {
      const e: Entity = {
        ...rawE,
        name: (rawE.name || '').replace(/[|]+/g, '').trim(),
        attrs: [...(rawE.attrs || [])],
      };

      // descartar ruido
      if (!e.name || (e.name.length <= 2 && (e.attrs?.length || 0) === 0)) {
        this.logger.debug(`Descarto ruido de entidad "${rawE.name}"`);
        continue;
      }

      // dedupe attrs
      const amap = new Map<string, EntityAttr>();
      for (const a of e.attrs || []) {
        const k = stripDiacritics(a.name);
        if (!amap.has(k)) amap.set(k, a);
      }
      e.attrs = Array.from(amap.values());

      // asegurar PK
      if (!(e.attrs || []).some((a) => a.pk)) {
        const cls = stripDiacritics(e.name).replace(/\s+/g, '');
        const candidate =
          e.attrs.find((a) => {
            const an = stripDiacritics(a.name);
            return (
              an === 'id' ||
              an === '_id' ||
              an === `${cls}id` ||
              an.endsWith('id')
            );
          }) || null;

        if (candidate) candidate.pk = true;
        else
          e.attrs.unshift({
            name: 'id',
            type: 'UUID',
            pk: true,
            unique: true,
            nullable: false,
          });
      }

      const key = stripDiacritics(e.name);
      const ex = seen.get(key);
      if (!ex) {
        seen.set(key, e);
        cleaned.push(e);
      } else {
        for (const a of e.attrs) {
          if (!ex.attrs.some((x) => keyEq(x.name, a.name))) ex.attrs.push(a);
        }
      }
    }

    // --- normalizar relaciones y nombres según entidades realmente existentes ---
    const nameMap = new Map<string, string>();
    for (const e of cleaned) nameMap.set(stripDiacritics(e.name), e.name);

    const rels = (dsl.relations || [])
      .map((r) => {
        const from = nameMap.get(stripDiacritics(r.from));
        const to = nameMap.get(stripDiacritics(r.to));
        if (!from || !to) return null;

        // Sanear cardinalidades (arregla "1..1..N", "undefined..1..N", etc.)
        let fromCard = this.sanitizeCardinality(r.fromCard);
        let toCard = this.sanitizeCardinality(r.toCard);

        // Defaults para N-N con join ("via")
        if (r.via) {
          if (!fromCard) fromCard = '1..N';
          if (!toCard) toCard = '1..N';
        }

        return { ...r, from, to, fromCard, toCard };
      })
      .filter(Boolean) as Relation[];

    const byName = new Map(cleaned.map((e) => [stripDiacritics(e.name), e]));
    const fkName = (n: string) => `${stripDiacritics(n).replace(/\s+/g, '')}Id`;

    for (const r of rels) {
      if (!r.via) continue;

      const viaE = byName.get(stripDiacritics(r.via));
      const A = byName.get(stripDiacritics(r.from));
      const B = byName.get(stripDiacritics(r.to));
      if (!viaE || !A || !B) continue;

      viaE.attrs ||= [];

      const aFK = fkName(A.name);
      const bFK = fkName(B.name);

      const hasA = viaE.attrs.some(
        (a) =>
          keyEq(a.name, aFK) ||
          keyEq(a.name, `${A.name}Id`) ||
          keyEq(a.name, `${stripDiacritics(A.name)}_id`) ||
          keyEq(a.name, `${stripDiacritics(A.name)}Id`),
      );
      const hasB = viaE.attrs.some(
        (a) =>
          keyEq(a.name, bFK) ||
          keyEq(a.name, `${B.name}Id`) ||
          keyEq(a.name, `${stripDiacritics(B.name)}_id`) ||
          keyEq(a.name, `${stripDiacritics(B.name)}Id`),
      );

      if (!hasA) viaE.attrs.push({ name: aFK, type: 'any' });
      if (!hasB) viaE.attrs.push({ name: bFK, type: 'any' });
    }

    return {
      entities: cleaned,
      relations: rels,
      constraints: dsl.constraints || [],
    };
  }

  // ---------- Orquestador ----------
  async parseImage(
    buffer: Buffer,
  ): Promise<{ dsl: DSL; ocrText: string; stats: any }> {
    let bestDsl: DSL | null = null;
    let used = 'gemini:none';
    let bestText = '';

    // 1) Primero intenta con Gemini si hay API Key
    const gem = await this.tryGeminiExtract(buffer, 'image/png');
    if (gem && (gem.entities?.length || 0) > 0) {
      bestDsl = gem;
      used = 'gemini';
    }

    // 2) Si no hubo Gemini o salió flojo (pocas entidades o cero relaciones), intenta OCR+heurística
    if (!bestDsl || bestDsl.entities.length < 2) {
      const cands = await this.buildCandidates(buffer);
      const psms = [3, 12, 6, 4, 11];

      let bestScore = -1;
      let bestTag = '';
      let bestPsm = -1;
      let bestData: any = null;

      for (const c of cands) {
        for (const psm of psms) {
          const data = await this.recognizeWith(c.img, psm);
          const text = (data?.text || '').replace(/\r/g, '').trim();
          const dsl = this.textToDsl(text);
          const score = this.scoreDsl(dsl);
          this.logger.debug(
            `[OCR] cand=${c.tag} psm=${psm} -> entities=${dsl.entities.length} relations=${dsl.relations.length} score=${score}`,
          );
          if (score > bestScore) {
            bestScore = score;
            bestText = text;
            bestDsl = dsl;
            bestTag = c.tag;
            bestPsm = psm;
            bestData = data;
          }
        }
      }

      // Reconstrucción por bloques cuando el texto OCR es pobre
      if (bestData) {
        const wordBoxes = Array.isArray(bestData?.words)
          ? this.normalizeWordItems(bestData.words)
          : this.wordsFromTsv(bestData?.tsv);

        if (wordBoxes.length) {
          const blockText = this.buildBlocksFromWords(wordBoxes);
          const dslFromBlocks = this.textToDsl(blockText);
          const scoreBlocks = this.scoreDsl(dslFromBlocks);
          if (bestDsl && scoreBlocks > this.scoreDsl(bestDsl)) {
            bestText = blockText;
            bestDsl = dslFromBlocks;
          }
        }
      }
      used = `tesseract:${bestTag}:${bestPsm}`;
    }

    // 3) Normaliza/asegura coherencia
    const finalized = this.finalizeDsl(
      bestDsl || { entities: [], relations: [], constraints: [] },
    );

    return {
      dsl: finalized,
      ocrText: bestText,
      stats: {
        engine: used,
        symbols: bestText.length,
        lines: bestText ? bestText.split('\n').length : 0,
        entities: finalized.entities.length,
        relations: finalized.relations.length,
      },
    };
  }
}
