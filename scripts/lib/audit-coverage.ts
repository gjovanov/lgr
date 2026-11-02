/**
 * Pure helpers for the PlusMinus↔LGR document audit (`scripts/audit-coverage-api.ts`). No I/O, so the
 * rules that decide "is it safe to book this document" are unit-tested (`unit/audit-coverage.test.ts`).
 */

/** Latin look-alikes of Cyrillic letters — PlusMinus and LGR spell the same article with either. */
const CYR2LAT: Record<string, string> = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'х': 'x', 'у': 'y' }

export const collapse = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
/** Name key that survives case, spacing and Latin-vs-Cyrillic look-alikes. */
export const fold = (s: unknown): string => [...collapse(s)].map(c => CYR2LAT[c] ?? c).join('')

export { lineItemName } from '../../packages/services/src/biz/doc-import/map-plusminus-line.js'
import { lineItemName } from '../../packages/services/src/biz/doc-import/map-plusminus-line.js'
export { stripItemLabel as stripLabel } from '../../packages/services/src/biz/doc-import/map-plusminus-line.js'

export type DocFamily = 'stokrazp' | 'sklrazp' | 'sklisk'
/** Direction of a family's quantities on the shelf: a receipt adds, a transfer-out / write-off removes. */
export const FAMILY_SIGN: Record<DocFamily, 1 | -1> = { stokrazp: 1, sklrazp: -1, sklisk: -1 }

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

export interface LineEffect { name: string; key: string; eff: number }

/** Signed stock effect per article of one document (lines of the same article merged, zero-quantity lines dropped). */
export function docLineEffects(family: DocFamily, doc: { lines?: Array<{ name?: unknown; item?: unknown; quantity?: unknown }> }): LineEffect[] {
  const sign = FAMILY_SIGN[family]
  const by = new Map<string, LineEffect>()
  for (const l of doc.lines ?? []) {
    const q = num(l.quantity)
    if (!q) continue
    const name = lineItemName(l)
    if (!name) continue
    const key = fold(name)
    const e = by.get(key) ?? { name, key, eff: 0 }
    e.eff += sign * q
    by.set(key, e)
  }
  return [...by.values()]
}

/**
 * How a not-yet-booked document line relates to the product's CURRENT gap to the PlusMinus snapshot
 * (`gap` = snapshot − LGR; positive means LGR is too low). This is the double-count guard:
 *   EXACT     booking the line alone closes the gap — book it
 *   PARTIAL   same direction, smaller than the gap — book it, something else still explains the rest
 *   ALREADY   LGR already agrees with the snapshot — booking would CREATE drift (the effect is in already:
 *             a re-baseline or a hand correction absorbed it)
 *   CONTRA    opposite direction or larger than the whole gap — the document is real but something else is
 *             also off on this product; book the document, expect a residual for the true-up
 *   NOPRODUCT the article is not in LGR at all
 * `setEffect` is the combined effect of ALL candidate documents on this product, so two documents that
 * each look PARTIAL but together close the gap are recognised as EXACT.
 */
export type GuardClass = 'EXACT' | 'PARTIAL' | 'ALREADY' | 'CONTRA' | 'NOPRODUCT'
export function classifyLine(gap: number | null, eff: number, setEffect: number = eff, tol = 0.001): GuardClass {
  if (gap === null) return 'NOPRODUCT'
  if (Math.abs(gap) < tol) return 'ALREADY'
  if (Math.abs(gap - setEffect) < tol) return 'EXACT'
  if (Math.sign(gap) === Math.sign(eff) && Math.abs(eff) <= Math.abs(gap) + tol) return 'PARTIAL'
  return 'CONTRA'
}

/** Documents dated on or before the last full quantity re-baseline are already inside LGR's numbers. */
export const isPreBaseline = (isoDate: string, baseline: string | undefined): boolean => !!baseline && isoDate <= baseline

/** `YYYYMMDD` (PlusMinus) → `YYYY-MM-DD`. */
export const isoFromPm = (s: unknown): string => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s ?? ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s ?? '')
}
