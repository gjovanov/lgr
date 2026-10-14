/**
 * Amount-in-words ("Словом") generator for invoicing documents.
 *
 * Deterministic (no network) — writes a localized verbal-amount line into a
 * document's notes on save, e.g. (bg):
 *   "Словом : двадесет и три евро и четиридесет и четири цента, Данъчна основа 19.53 €"
 *
 * The cents are spelled too (gjovanov/lgr#127) — „Словом" is the amount IN WORDS, and the
 * legacy PlusMinus forms printed them as digits only because its generator could not.
 *
 * Lives in `config` (no dependencies) because both sides write it: the invoicing UI on every
 * save of an outgoing document, and the doc import (`doc-import/map-invoice.ts`) for an
 * imported OUTGOING document. ⚠ Until 2026-10-13 the import stored PlusMinus's own line
 * verbatim ("… и 76 цента Данъчна основа 16.47 €": digit cents, no comma), so an imported sales
 * invoice printed that until someone re-saved it. Imported BILLS keep the supplier's line: it
 * quotes their document. The printed form splits the line at the numeric tax-base tail.
 *
 * Supports en / bg / de / mk for integers 0…999,999,999. The whole amount is
 * spelled; the tax base (subtotal) is appended numerically as a cross-check, the
 * way the legacy documents print it.
 */

type Lang = 'en' | 'bg' | 'de' | 'mk'

interface Words {
  label: string
  taxBaseLabel: string
  and: string
  currency: (code: string) => { major: string; minor: string; symbol: string }
  spell: (n: number) => string
}

function normLang(locale?: string): Lang {
  const l = (locale || 'en').toLowerCase().split('-')[0]
  return (['en', 'bg', 'de', 'mk'].includes(l) ? l : 'en') as Lang
}

// ── English ──
const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
function enBelow1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) { parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`); n %= 100 }
  if (n >= 20) { parts.push(EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_ONES[n % 10] : '')); n = 0 }
  if (n > 0) parts.push(EN_ONES[n])
  return parts.join(' ')
}
function enSpell(n: number): string {
  if (n === 0) return 'zero'
  const groups: Array<[number, string]> = [[1_000_000, 'million'], [1000, 'thousand'], [1, '']]
  const out: string[] = []
  for (const [div, name] of groups) {
    const q = Math.floor(n / div)
    if (q > 0) { out.push(enBelow1000(q) + (name ? ' ' + name : '')); n %= div }
  }
  return out.join(' ')
}

// ── Bulgarian ──
const BG_ONES = ['нула', 'едно', 'две', 'три', 'четири', 'пет', 'шест', 'седем', 'осем', 'девет', 'десет', 'единадесет', 'дванадесет', 'тринадесет', 'четиринадесет', 'петнадесет', 'шестнадесет', 'седемнадесет', 'осемнадесет', 'деветнадесет']
const BG_TENS = ['', '', 'двадесет', 'тридесет', 'четиридесет', 'петдесет', 'шестдесет', 'седемдесет', 'осемдесет', 'деветдесет']
const BG_HUNDREDS = ['', 'сто', 'двеста', 'триста', 'четиристотин', 'петстотин', 'шестстотин', 'седемстотин', 'осемстотин', 'деветстотин']
function bgBelow1000(n: number, masc = true): string {
  const parts: string[] = []
  if (n >= 100) { parts.push(BG_HUNDREDS[Math.floor(n / 100)]); n %= 100 }
  if (n >= 20) {
    parts.push(BG_TENS[Math.floor(n / 10)])
    if (n % 10) parts.push('и ' + oneBg(n % 10, masc))
    n = 0
  } else if (n > 0) {
    if (parts.length) parts.push('и ' + oneBg(n, masc))
    else parts.push(oneBg(n, masc))
  }
  return parts.join(' ')
}
function oneBg(n: number, masc: boolean): string {
  if (n === 1) return masc ? 'един' : 'едно'
  if (n === 2) return masc ? 'два' : 'две'
  return BG_ONES[n]
}
function bgSpell(n: number): string {
  if (n === 0) return 'нула'
  const out: string[] = []
  const mil = Math.floor(n / 1_000_000); n %= 1_000_000
  const thou = Math.floor(n / 1000); n %= 1000
  if (mil > 0) out.push(mil === 1 ? 'един милион' : `${bgBelow1000(mil)} милиона`)
  if (thou > 0) out.push(thou === 1 ? 'хиляда' : (thou === 2 ? 'две хиляди' : `${bgBelow1000(thou, false)} хиляди`))
  if (n > 0) out.push(bgBelow1000(n))
  return out.join(' ')
}

// ── German ──
const DE_ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn']
const DE_TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig']
function deBelow1000(n: number): string {
  let s = ''
  if (n >= 100) { s += (Math.floor(n / 100) === 1 ? 'ein' : DE_ONES[Math.floor(n / 100)]) + 'hundert'; n %= 100 }
  if (n >= 20) { const u = n % 10; s += (u ? (u === 1 ? 'ein' : DE_ONES[u]) + 'und' : '') + DE_TENS[Math.floor(n / 10)]; n = 0 }
  else if (n > 0) s += DE_ONES[n]
  return s
}
function deSpell(n: number): string {
  if (n === 0) return 'null'
  let s = ''
  const mil = Math.floor(n / 1_000_000); n %= 1_000_000
  const thou = Math.floor(n / 1000); n %= 1000
  if (mil > 0) s += (mil === 1 ? 'eine Million ' : deBelow1000(mil) + ' Millionen ')
  if (thou > 0) s += (thou === 1 ? 'ein' : deBelow1000(thou)) + 'tausend'
  if (n > 0) s += deBelow1000(n)
  return s.trim()
}

// ── Macedonian ──
const MK_ONES = ['нула', 'еден', 'два', 'три', 'четири', 'пет', 'шест', 'седум', 'осум', 'девет', 'десет', 'единаесет', 'дванаесет', 'тринаесет', 'четиринаесет', 'петнаесет', 'шеснаесет', 'седумнаесет', 'осумнаесет', 'деветнаесет']
const MK_TENS = ['', '', 'дваесет', 'триесет', 'четириесет', 'педесет', 'шеесет', 'седумдесет', 'осумдесет', 'деведесет']
const MK_HUNDREDS = ['', 'сто', 'двесте', 'триста', 'четиристотини', 'петстотини', 'шестотини', 'седумстотини', 'осумстотини', 'деветстотини']
function mkBelow1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) { parts.push(MK_HUNDREDS[Math.floor(n / 100)]); n %= 100 }
  if (n >= 20) { parts.push(MK_TENS[Math.floor(n / 10)]); if (n % 10) parts.push('и ' + MK_ONES[n % 10]); n = 0 }
  else if (n > 0) parts.push((parts.length ? 'и ' : '') + MK_ONES[n])
  return parts.join(' ')
}
function mkSpell(n: number): string {
  if (n === 0) return 'нула'
  const out: string[] = []
  const mil = Math.floor(n / 1_000_000); n %= 1_000_000
  const thou = Math.floor(n / 1000); n %= 1000
  if (mil > 0) out.push(mil === 1 ? 'еден милион' : `${mkBelow1000(mil)} милиони`)
  if (thou > 0) out.push(thou === 1 ? 'илјада' : `${mkBelow1000(thou)} илјади`)
  if (n > 0) out.push(mkBelow1000(n))
  return out.join(' ')
}

function currencyWords(lang: Lang, code: string): { major: string; minor: string; symbol: string } {
  const c = (code || 'EUR').toUpperCase()
  const table: Record<Lang, Record<string, { major: string; minor: string }>> = {
    en: { EUR: { major: 'euro', minor: 'cents' }, BGN: { major: 'leva', minor: 'stotinki' }, USD: { major: 'dollars', minor: 'cents' } },
    bg: { EUR: { major: 'евро', minor: 'цента' }, BGN: { major: 'лева', minor: 'стотинки' }, USD: { major: 'долара', minor: 'цента' } },
    de: { EUR: { major: 'Euro', minor: 'Cent' }, BGN: { major: 'Lewa', minor: 'Stotinki' }, USD: { major: 'Dollar', minor: 'Cent' } },
    mk: { EUR: { major: 'евра', minor: 'центи' }, BGN: { major: 'лева', minor: 'стотинки' }, USD: { major: 'долари', minor: 'центи' } },
  }
  const entry = table[lang][c] || { major: c, minor: lang === 'en' ? 'cents' : 'ст.' }
  const symbols: Record<string, string> = { EUR: '€', BGN: 'лв', USD: '$', GBP: '£' }
  return { ...entry, symbol: symbols[c] || c }
}

const DEFS: Record<Lang, Omit<Words, 'currency'>> = {
  en: { label: 'In words', taxBaseLabel: 'Tax base', and: 'and', spell: enSpell },
  bg: { label: 'Словом', taxBaseLabel: 'Данъчна основа', and: 'и', spell: bgSpell },
  de: { label: 'In Worten', taxBaseLabel: 'Steuerbasis', and: 'und', spell: deSpell },
  mk: { label: 'Со зборови', taxBaseLabel: 'Даночна основа', and: 'и', spell: mkSpell },
}

/** Regex matching any of the four localized "in words" line labels (for de-dup on re-save). */
export const AMOUNT_IN_WORDS_LABELS = /^(Словом|In words|In Worten|Со зборови)\s*:/i

/** The language an existing amount-in-words line was written in, from its label; else undefined. */
export function amountInWordsLocale(notes: string | undefined): Lang | undefined {
  for (const raw of (notes || '').split('\n')) {
    const m = AMOUNT_IN_WORDS_LABELS.exec(raw.trim())
    if (!m) continue
    const label = m[1].toLowerCase()
    return (Object.keys(DEFS) as Lang[]).find((l) => DEFS[l].label.toLowerCase() === label)
  }
  return undefined
}

export function amountInWords(total: number, subtotal: number, currency: string, locale?: string): string {
  const lang = normLang(locale)
  const def = DEFS[lang]
  const cur = currencyWords(lang, currency)
  const cents = Math.round((Math.abs(total) - Math.floor(Math.abs(total))) * 100)
  const whole = Math.floor(Math.abs(total))
  const words = `${def.spell(whole)} ${cur.major} ${def.and} ${def.spell(cents)} ${cur.minor}`
  const sub = Number(subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
  return `${def.label} : ${words}, ${def.taxBaseLabel} ${sub} ${cur.symbol}`
}

/** Replace any existing amount-in-words line in `notes` with a fresh one; append if absent. */
export function upsertAmountInWords(notes: string, total: number, subtotal: number, currency: string, locale?: string): string {
  const line = amountInWords(total, subtotal, currency, locale)
  const kept = (notes || '')
    .split('\n')
    .filter((l) => !AMOUNT_IN_WORDS_LABELS.test(l.trim()))
    .join('\n')
    .trimEnd()
  return kept ? `${kept}\n${line}` : line
}
