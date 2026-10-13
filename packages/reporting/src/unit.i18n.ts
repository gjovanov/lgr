/**
 * Unit-of-measure abbreviations for the PRINTED documents (invoice form, приемо-предавателен
 * протокол, декларация за съответствие).
 *
 * Why this exists: `Invoice.lines[].unit` stores the canonical CODE (`pcs`, `kg`, …) — the same
 * vocabulary `ui-shared/composables/useProductUnits` offers, defaulted to `'pcs'` by the invoice
 * controller. On screen that code is resolved through `warehouse.uomShort.<code>`, but the
 * reporting package runs server-side with no Vue/i18n available, so the printed forms were
 * putting the raw `pcs` in the „Мярка" column of a Bulgarian document (gjovanov/lgr#127).
 *
 * The Bulgarian column reproduces the legacy PlusMinus forms, which print the abbreviation
 * upper-cased and followed by a dot — „БР.", „КГ.", „М." — so that is what this table holds;
 * the other locales keep the same abbreviations the UI shows.
 *
 * An unrecognised value is returned VERBATIM: `unit` is a free-text field on the API, and a
 * document that was imported or typed with „бр." or „ролка" must print what it says rather than
 * be silently blanked or guessed at.
 */

export type UnitLocale = 'en' | 'bg' | 'de' | 'mk'

/** Keyed by the canonical UOM code (`UOM_CODES` in ui-shared). */
type UnitTable = Record<string, string>

const en: UnitTable = {
  pcs: 'pcs', pair: 'pr', set: 'set', box: 'box', pack: 'pk', dozen: 'dz',
  g: 'g', kg: 'kg', ton: 't', lb: 'lb', oz: 'oz',
  ml: 'ml', L: 'L', m3: 'm³', gal: 'gal',
  mm: 'mm', cm: 'cm', m: 'm', km: 'km', in: 'in', ft: 'ft',
  m2: 'm²', ha: 'ha',
  hr: 'hr', day: 'd', month: 'mo',
}

const bg: UnitTable = {
  pcs: 'БР.', pair: 'ЧФТ.', set: 'КОМПЛ.', box: 'КУТ.', pack: 'ОП.', dozen: 'ДУЗ.',
  g: 'Г.', kg: 'КГ.', ton: 'Т.', lb: 'ФНТ.', oz: 'УНЦ.',
  ml: 'МЛ.', L: 'Л.', m3: 'М³', gal: 'ГАЛ.',
  mm: 'ММ.', cm: 'СМ.', m: 'М.', km: 'КМ.', in: 'ИНЧ', ft: 'ФТ.',
  m2: 'М²', ha: 'ХА.',
  hr: 'Ч.', day: 'ДН.', month: 'МЕС.',
}

const de: UnitTable = {
  pcs: 'Stk', pair: 'Paar', set: 'Satz', box: 'Box', pack: 'Pck', dozen: 'Dtz',
  g: 'g', kg: 'kg', ton: 't', lb: 'lb', oz: 'oz',
  ml: 'ml', L: 'L', m3: 'm³', gal: 'gal',
  mm: 'mm', cm: 'cm', m: 'm', km: 'km', in: 'in', ft: 'ft',
  m2: 'm²', ha: 'ha',
  hr: 'Std', day: 'Tag', month: 'Mon',
}

const mk: UnitTable = {
  pcs: 'ком', pair: 'пар', set: 'комп', box: 'кут', pack: 'пак', dozen: 'дуж',
  g: 'г', kg: 'кг', ton: 'т', lb: 'фнт', oz: 'унц',
  ml: 'мл', L: 'л', m3: 'м³', gal: 'гал',
  mm: 'мм', cm: 'см', m: 'м', km: 'км', in: 'инч', ft: 'ст',
  m2: 'м²', ha: 'ха',
  hr: 'ч', day: 'ден', month: 'мес',
}

const TABLE: Record<UnitLocale, UnitTable> = { en, bg, de, mk }

/**
 * Spellings of a canonical code that reach us from elsewhere — legacy imports, hand-typed
 * lines, the OCR drafts. They resolve to the code so the document still prints „БР." rather
 * than echoing whatever the row happened to carry.
 */
const ALIASES: Record<string, string> = {
  pc: 'pcs', pce: 'pcs', piece: 'pcs', pieces: 'pcs',
  бр: 'pcs', 'бр.': 'pcs', броя: 'pcs', брой: 'pcs', шт: 'pcs', stk: 'pcs', ком: 'pcs',
  кг: 'kg', 'кг.': 'kg', л: 'L', 'л.': 'L', м: 'm', 'м.': 'm',
  м2: 'm2', м3: 'm3', компл: 'set', 'компл.': 'set', оп: 'pack', 'оп.': 'pack',
  liter: 'L', litre: 'L', l: 'L', ltr: 'L',
}

function normLocale(locale?: string): UnitLocale {
  const key = (locale || 'en').toLowerCase().split('-')[0] as UnitLocale
  return TABLE[key] ? key : 'en'
}

/**
 * The printed abbreviation for a line's unit, e.g. `unitLabel('pcs', 'bg') === 'БР.'`.
 * Empty in, empty out — a line with no unit prints an empty cell, not a guessed one.
 */
export function unitLabel(unit: unknown, locale?: string): string {
  const raw = String(unit ?? '').trim()
  if (!raw) return ''
  const table = TABLE[normLocale(locale)]
  // The codes are case-sensitive only in `L` vs `l`, which the alias map settles.
  const code = table[raw] ? raw : (ALIASES[raw.toLowerCase()] ?? raw)
  return table[code] ?? raw
}
