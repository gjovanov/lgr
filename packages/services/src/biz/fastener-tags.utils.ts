/**
 * Pure extraction of fastener facets from Bulgarian product names (regal-pz
 * catalog conventions): DIN/ISO/EN standard numbers, dimensions ("М8Х25",
 * "Ф20Х400", "6Х70"), and coating/material/strength codes (ZN, BL, HDG, A2…).
 *
 * IMPORT-PURE on purpose: no db/models, no context — safe to import from
 * scripts and unit tests without booting Mongoose.
 *
 * Canonical tag forms (decided 2026-08-03):
 *   - DIN/ISO/EN: single space, Latin-folded variant → "DIN 933", "DIN 7504-K",
 *     "ISO 4017", "EN 14399-4"
 *   - dimensions: uppercase Cyrillic М/Ф prefix + Cyrillic Х separator + dot
 *     decimals → "М8Х25", "Ф90Х529", "6Х70", "М10Х1.25Х40"
 *   - coatings/material/strength: ZN, BL, HDG, YELLOW ZINC, A2, A4, МЕСИНГ,
 *     6.8, 8.8, 10.9, 12.9
 */

export interface DinRef {
  base: string // "933", "7504"
  variant: string | null // "K", "A", "1" — Latin-folded, only if whitelisted
}

export interface FastenerFacets {
  din: DinRef[]
  iso: string[] // canonical tags: "ISO 7380"
  en: string[] // canonical tags: "EN 14399-4"
  dims: string[] // canonical tags: "М8Х25"
  coatings: string[] // canonical tags: "ZN", "A2", "8.8", …
}

/**
 * DIN variants that exist as distinct catalog rows. Anything else after a DIN
 * number is corpus junk — the strength-class marker ("DIN 933 - K 8.8"), the
 * class value itself ("DIN 7380 - 10.9"), steel grades ("DIN 6885 - C45K") or
 * unrelated codes ("DIN338-HSS-G").
 */
export const DIN_VARIANT_WHITELIST: Record<string, ReadonlySet<string>> = {
  '125': new Set(['A', 'B']),
  '7504': new Set(['K', 'M', 'N', 'O', 'P', 'R']),
  '7380': new Set(['1', '2']),
  '976': new Set(['1']),
}

/** Fold Cyrillic capital lookalikes to Latin (names mix scripts: "DIN 7504 Р"). */
const CYR_TO_LAT: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
}
export function foldCyrillicLookalikes(s: string): string {
  return s.toUpperCase().replace(/[АВЕКМНОРСТХ]/g, ch => CYR_TO_LAT[ch] ?? ch)
}

export function formatDinTag(ref: DinRef): string {
  return ref.variant ? `DIN ${ref.base}-${ref.variant}` : `DIN ${ref.base}`
}
export function formatIsoTag(num: string): string {
  return `ISO ${num}`
}
export function formatEnTag(num: string): string {
  return `EN ${num}`
}

// ── DIN ──────────────────────────────────────────────────────────────────────
// Base: "DIN 933", "DIN933", "DIN-933", "DIN.933" (not preceded by a letter).
const DIN_RE = /(?<![A-Za-zА-Яа-я])DIN[\s.\-]{0,2}(\d{1,5})/giu

/**
 * Variant is accepted ONLY when the (base, letter/digit) pair is whitelisted
 * AND the attachment is tight:
 *   - directly attached letter:        "DIN 7504K"
 *   - tight hyphen + single alnum:     "DIN 7504-K", "DIN 7380-2"
 *   - single space + single letter:    "DIN 7504 K" (Cyrillic Р folds to P)
 * Spaced hyphens are never variants ("DIN 933 - K 8.8" → the K is the class
 * marker), multi-char continuations never match ("DIN338-HSS", "DIN9-13").
 */
export function extractDinRefs(name: string): DinRef[] {
  const out: DinRef[] = []
  const seen = new Set<string>()
  for (const m of name.matchAll(DIN_RE)) {
    const base = m[1]
    const rest = name.slice(m.index! + m[0].length)
    let candidate: string | null = null
    let mm: RegExpMatchArray | null
    if ((mm = rest.match(/^([A-Za-zА-Яа-я])(?![A-Za-zА-Яа-я0-9])/))) candidate = mm[1]
    else if ((mm = rest.match(/^-([A-Za-zА-Яа-я0-9])(?![A-Za-zА-Яа-я0-9.,])/))) candidate = mm[1]
    else if ((mm = rest.match(/^ ([A-Za-zА-Яа-я])(?![A-Za-zА-Яа-я0-9])/))) candidate = mm[1]
    let variant: string | null = null
    if (candidate) {
      const folded = /\d/.test(candidate) ? candidate : foldCyrillicLookalikes(candidate)
      if (DIN_VARIANT_WHITELIST[base]?.has(folded)) variant = folded
    }
    const key = `${base}|${variant ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ base, variant })
    }
  }
  return out
}

// ── ISO / EN ─────────────────────────────────────────────────────────────────
const ISO_RE = /(?<![A-Za-zА-Яа-я])ISO[\s.\-]{0,2}(\d{3,5}(?:-\d)?)/giu
const EN_RE = /(?<![A-Za-zА-Яа-я])EN[\s.\-]{0,2}(\d{4,5}(?:-\d)?)/gu

export function extractIsoRefs(name: string): string[] {
  return [...new Set([...name.matchAll(ISO_RE)].map(m => formatIsoTag(m[1])))]
}
export function extractEnRefs(name: string): string[] {
  return [...new Set([...name.matchAll(EN_RE)].map(m => formatEnTag(m[1])))]
}

// ── Dimensions ───────────────────────────────────────────────────────────────
// prefix? NUM Х NUM (Х NUM)? — separator Cyrillic/Latin х/Х/x/X, dot or comma
// decimals, optional М/M/Ф/F/Ø prefix (adjacent or one space, not part of a
// word: "BM 10Х35" has no prefix). Fraction/partial guard: a segment that is
// part of a pipe-thread fraction ("1/2Х3/8", "Ф20Х1/2") or slash-suffixed
// ("БОЛТ 10Х100/94", "20Х20/87") never produces a dimension — the trailing
// (?![\d.,]|\/\d) also stops backtracking from emitting truncated numbers.
const DIM_RE =
  /(?:(?<![A-Za-zА-Яа-я0-9])([МмMmФфFfØø])\s?)?(?<![\d.,/])(\d+(?:[.,]\d+)?)\s*[хХxX]\s*(\d+(?:[.,]\d+)?)(?![\d.,]|\/\d)(?:\s*[хХxX]\s*(\d+(?:[.,]\d+)?)(?![\d.,]|\/\d))?/gu

function canonNum(n: string): string {
  return n.replace(',', '.')
}

export function extractDimensions(name: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of name.matchAll(DIM_RE)) {
    const rawPrefix = m[1] ?? ''
    let prefix = ''
    if (/[МмMm]/.test(rawPrefix)) prefix = 'М'
    else if (/[ФфFfØø]/.test(rawPrefix)) prefix = 'Ф'
    const segs = [m[2], m[3], m[4]].filter((s): s is string => s != null).map(canonNum)
    const tag = prefix + segs.join('Х')
    if (!seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}

// ── Coatings / material / strength ───────────────────────────────────────────
// Word boundaries in this corpus are spaces, dashes, slashes, parens, commas.
const B = '[\\s\\-()/.,+]'
const COATING_RULES: { tag: string; re: RegExp }[] = [
  { tag: 'ZN', re: new RegExp(`(^|${B})ZN(${B}|$)`, 'i') },
  { tag: 'ZN', re: /ПОЦ/iu }, // "ПОЦ." / "ПОЦИНКОВАН" spelled out
  { tag: 'BL', re: new RegExp(`(^|${B})BL(${B}|$)`, 'i') },
  { tag: 'HDG', re: new RegExp(`(^|${B})HDG(${B}|$)`, 'i') },
  { tag: 'YELLOW ZINC', re: /YELLOW\s+ZINC/i },
  { tag: 'A2', re: new RegExp(`(^|${B})[AА]2(-\\d{2})?(${B}|$)`, 'u') },
  { tag: 'A4', re: new RegExp(`(^|${B})[AА]4(-\\d{2})?(${B}|$)`, 'u') },
  { tag: 'МЕСИНГ', re: /МЕСИНГ/iu },
]
const STRENGTH_RE = new RegExp(`(^|${B})(?:[KК]\\s?)?(6[.,]8|8[.,]8|10[.,]9|12[.,]9)(${B}|$)`, 'u')

export function extractCoatings(name: string): string[] {
  const out: string[] = []
  for (const { tag, re } of COATING_RULES) {
    if (re.test(name) && !out.includes(tag)) out.push(tag)
  }
  const sm = name.match(STRENGTH_RE)
  if (sm) out.push(sm[2].replace(',', '.'))
  return out
}

// ── Composite ────────────────────────────────────────────────────────────────
export function extractFastenerFacets(name: string): FastenerFacets {
  return {
    din: extractDinRefs(name),
    iso: extractIsoRefs(name),
    en: extractEnRefs(name),
    dims: extractDimensions(name),
    coatings: extractCoatings(name),
  }
}
