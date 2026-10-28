/**
 * Deterministic field extraction straight from the OCR text.
 *
 * These run alongside the AI extraction, not instead of it: the model reliably reads the
 * line-item table but routinely drops the two-column party block and the labelled footer
 * rows, which regexes over `pdftotext -layout` output never do. Whatever the model
 * returned wins; these fill the gaps.
 */
import { clean } from './detect.js'

/**
 * Fallback for the two-column party block of legacy invoices:
 *   ПОЛУЧАТЕЛ  <name>          ДОСТАВЧИК <name>
 *   Град       <city>          Град      <city>
 *   Адрес      <street>        Адрес     <street>
 * The AI sometimes drops these (column confusion) — the raw text never does.
 * Left column = ПОЛУЧАТЕЛ (receiver), right = ДОСТАВЧИК (supplier).
 */
export function parsePartyAddresses(rawText: string): { receiver: { street?: string; city?: string }; supplier: { street?: string; city?: string } } {
  const receiver: { street?: string; city?: string } = {}
  const supplier: { street?: string; city?: string } = {}
  for (const line of (rawText || '').split('\n')) {
    let m = /^\s*Град\s{2,}(.+?)(?:\s{3,}Град\s{2,}(.+?))?\s*$/.exec(line)
    if (m) { receiver.city ??= clean(m[1]); if (m[2]) supplier.city ??= clean(m[2]); continue }
    m = /^\s*Адрес\s{2,}(.+?)(?:\s{3,}Адрес\s{2,}(.+?))?\s*$/.exec(line)
    if (m) { receiver.street ??= clean(m[1]); if (m[2]) supplier.street ??= clean(m[2]) }
  }
  return { receiver, supplier }
}

/** Map the invoice's "Плащане:" value (or the AI's payment_terms) to our enum. */
export function parsePaymentMethod(rawText: string, aiPaymentTerms?: string | null): string | undefined {
  const m = /Плащане\s*:\s*([^\n]+)/i.exec(rawText || '')
  const v = clean(m?.[1]) || clean(aiPaymentTerms)
  if (!v) return undefined
  if (/сметка|превод|transfer/i.test(v)) return 'bank_transfer'
  // Before cash: „cash on delivery" contains „cash", and наложен платеж is not paid at the counter.
  if (/наложен|cash on delivery|\bCOD\b/i.test(v)) return 'cash_on_delivery'
  if (/брой|cash/i.test(v)) return 'cash'
  if (/карта|card/i.test(v)) return 'card'
  return undefined
}

/** The amount-in-words line ("Словом : седемстотин и три евро и 55 цента"). */
export function parseSlovom(rawText: string): string | undefined {
  const m = /(Словом\s*:\s*[^\n]+)/i.exec(rawText || '')
  return m ? clean(m[1]).replace(/\s+/g, ' ') : undefined
}

/** The document author ("Съставил: Николета Тачева"). */
export function parsePreparedBy(rawText: string): string | undefined {
  const m = /Съставил\s*:\s*([^\n]+)/i.exec(rawText || '')
  return clean(m?.[1]) || undefined
}

/** The place of transaction ("Място на сделката: : гр.Пазарджик" — tolerates the doubled colon). */
export function parsePlaceOfTransaction(rawText: string): string | undefined {
  const m = /Място на сделката\s*:?\s*:?\s*([^\n]+)/i.exec(rawText || '')
  // The value shares its line with other columns — cut at 3+ consecutive spaces.
  return clean(m?.[1]?.split(/\s{3,}/)[0]) || undefined
}

/**
 * Pull the standard legal clauses off the invoice into `terms`:
 *  - the ЗДДС/ДОПК personal-data consent block ("Получателят е дал съгласие …")
 *  - the no-stamp/signature clause ("Съгласно чл.6, ал.1 от ЗСч. …")
 * Multi-line blocks are joined until an empty line or a new labelled section.
 */
export function parseTerms(rawText: string): string | undefined {
  const lines = (rawText || '').split('\n').map(l => l.trim())
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^(Получателят е дал съгласие|Съгласно чл)/i.test(lines[i])) {
      const block = [lines[i]]
      while (i + 1 < lines.length && lines[i + 1] && !/^(Съгласно чл|Получател\s*:|Съставил|Дата|Банка|IBAN|ФАКТУРА|Плащане)/i.test(lines[i + 1])) {
        block.push(lines[++i])
      }
      blocks.push(block.join('\n'))
    }
  }
  return blocks.length ? blocks.map(b => `- ${b}`).join('\n\n') : undefined
}

export interface StockNoteHeader {
  /** Документ № / Номер — the note's own running number. */
  number?: string
  /** ISO date parsed from "Дата: DD.MM.YYYY". */
  date?: string
  /** Source store as printed ("ОБЕКТИ:СКЛАД - 1" keeps its full value; see `storeLeaf`). */
  from?: string
  /** Destination store as printed. */
  to?: string
  /** Free-text Основание / За обект. */
  basis?: string
}

/** `ОБЕКТИ:СКЛАД - 1` → `СКЛАД - 1`. Warehouse names are matched on both forms. */
export function storeLeaf(value: string): string {
  const v = clean(value)
  const idx = v.lastIndexOf(':')
  return idx >= 0 ? clean(v.slice(idx + 1)) : v
}

/** `DD.MM.YYYY` → `YYYY-MM-DD`. Returns undefined for anything else. */
export function bgDateToIso(raw: unknown): string | undefined {
  const m = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/.exec(clean(raw))
  if (!m) return undefined
  const [, d, mo, y] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/**
 * Header of a стокова/складова разписка or искане. The AI profile returns these too;
 * this is the deterministic backstop for the labelled rows, which `-layout` preserves.
 */
export function parseStockNoteHeader(rawText: string): StockNoteHeader {
  const text = rawText || ''
  const out: StockNoteHeader = {}

  const numberMatch =
    /(?:Документ|Номер|№)\s*[№:]?\s*(\d{4,})/i.exec(text) ||
    /Разписка\s*[№:]?\s*(\d{4,})/i.exec(text)
  if (numberMatch) out.number = clean(numberMatch[1])

  const dateMatch = /Дата\s*:?\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i.exec(text)
  if (dateMatch) out.date = bgDateToIso(dateMatch[1])

  // "От склад" / "Предал" side and "За склад" / "Приел" side. Values share their line with
  // other columns, so cut at 3+ spaces like the invoice footer parser does.
  const cut = (v?: string) => clean(v?.split(/\s{3,}/)[0]) || undefined
  const from = /(?:От\s+склад|Склад\s+източник|Предава\s+от)\s*:?\s*([^\n]+)/i.exec(text)
  if (from) out.from = cut(from[1])
  const to = /(?:За\s+склад|Към\s+склад|Склад\s+получател|Приема\s+в)\s*:?\s*([^\n]+)/i.exec(text)
  if (to) out.to = cut(to[1])
  // Single-warehouse notes just print "Склад:" — treat it as the side the kind implies.
  if (!out.from && !out.to) {
    const single = /Склад\s*:?\s*([^\n]+)/i.exec(text)
    if (single) out.from = cut(single[1])
  }

  const basis = /(?:Основание|За обект)\s*:?\s*([^\n]+)/i.exec(text)
  if (basis) out.basis = cut(basis[1])

  return out
}
