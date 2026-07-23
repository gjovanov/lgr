/**
 * Normalize legacy Bulgarian unit-of-measure labels (PlusMinus exports: "БР", "КГ",
 * "ЧИФТ", junk like "0" or "/БР") to the canonical UOM codes used across the app
 * (ui-shared useProductUnits UOM_CODES). Unknown/empty → 'pcs'.
 */
const BG_UOM: Record<string, string> = {
  // pieces + variants/typos
  'БР': 'pcs', 'БР.': 'pcs', 'БРЛ': 'pcs', 'ББР': 'pcs', '/БР': 'pcs',
  'Х.БР.': 'pcs', 'ХЛБР': 'pcs',
  'ЧИФТ': 'pair', 'ЧИФ': 'pair',
  'К-Т': 'set', 'КОМ.': 'set', 'КОМ': 'set',
  'КУТ': 'box', 'КУТ.': 'box',
  'ПАК': 'pack', 'ПАК.': 'pack', 'БЛ': 'pack', 'РОЛ.': 'pack', 'РОЛ': 'pack',
  'КГ': 'kg',
  'Г': 'g',
  'Т': 'ton',
  'Л': 'L',
  'МЛ': 'ml',
  'М': 'm', 'М.': 'm',
  'ММ': 'mm',
  'СМ': 'cm',
  'М2': 'm2', 'КВ': 'm2', 'КВ.М': 'm2',
  'М3': 'm3',
}

// Canonical codes (mirrors ui-shared UOM_CODES) — pass through unchanged.
const CANONICAL = new Set([
  'pcs', 'pair', 'set', 'box', 'pack', 'dozen',
  'g', 'kg', 'ton', 'lb', 'oz',
  'ml', 'L', 'm3', 'gal',
  'mm', 'cm', 'm', 'km', 'in', 'ft',
  'm2', 'ha',
  'hr', 'day', 'month',
])

/** Canonical UOM code for a legacy Bulgarian unit label. */
export function normalizeUomBg(raw: unknown): string {
  const u = String(raw ?? '').trim().replace(/^\//, '')
  if (!u || u === '0' || u === ',') return 'pcs'
  if (CANONICAL.has(u)) return u
  const upper = u.toLocaleUpperCase('bg')
  return BG_UOM[upper] ?? 'pcs'
}
