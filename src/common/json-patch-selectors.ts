import * as rfc6902 from 'fast-json-patch';

/**
 * Aplica un JSON Patch RFC-6902 pero permitiendo selectores por nombre en paths:
 *   /entities[name=Order]
 *   /entities[name=Order]/attrs[name=total]
 *   /relations[from=Order][to=Customer]
 *
 * Convierte esos paths a índices reales del array antes de aplicar el patch.
 */
export function applyNamedJsonPatch<T = any>(model: T, patch: any[]): T {
  const clone = JSON.parse(JSON.stringify(model));
  const resolved = patch.map((op) => ({
    ...op,
    path: resolvePath(clone, op.path),
  }));
  const res = rfc6902.applyPatch(clone, resolved, false, false);
  return res.newDocument as T;
}

function resolvePath(doc: any, path: string): string {
  if (!path?.includes('[')) return path; // ruta simple

  const segments = path.split('/').filter(Boolean);
  const real: string[] = [''];
  let cursor: any = doc;

  for (const seg of segments) {
    const m = seg.match(/^([a-zA-Z0-9_-]+)(\[.+\])?$/);
    if (!m) {
      real.push(seg);
      continue;
    }
    const key = m[1];
    const filt = m[2];

    if (!filt) {
      // sin filtro → propiedad directa
      cursor = cursor?.[key];
      real.push(key);
      continue;
    }

    // filtros múltiples: [name=...][from=...][to=...]
    const filters = Array.from(
      filt.matchAll(/\[([a-zA-Z0-9_-]+)=([^\]]+)\]/g),
    ).map((g) => ({ k: g[1], v: stripQuotes(g[2]) }));

    const arr = cursor?.[key];
    if (!Array.isArray(arr))
      throw new Error(`Esperaba array en "${key}" para selector "${seg}"`);

    const idx = arr.findIndex((it: any) =>
      filters.every((f) => (it?.[f.k] ?? '') === f.v),
    );
    if (idx < 0) throw new Error(`No encontrado "${seg}" en ruta "${path}"`);

    real.push(key, String(idx));
    cursor = arr[idx];
  }

  return real.join('/');
}

function stripQuotes(s: string) {
  return s.replace(/^['"]|['"]$/g, '');
}
