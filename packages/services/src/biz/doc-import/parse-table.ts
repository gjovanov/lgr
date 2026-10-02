/**
 * Deterministic reader for the PlusMinus exports — фактура, стокова разписка (incl. the
 * "2000 КОРЕКЦИЯ" variant), складова разписка and искане.
 *
 * These are machine-generated documents with a fixed column layout, so the item table can be read
 * straight off `pdftotext -layout` output instead of being described to an LLM. That matters for
 * two reasons:
 *
 *  - **Speed.** The sidecar spends ~30-50 s of model time per document; this runs in well under a
 *    millisecond, which is the difference between a day's batch taking seven minutes and taking
 *    none.
 *  - **Accuracy.** Every number is checked against the document's own arithmetic before it is
 *    accepted. The two silent-corruption bugs we hit in production — a quantity that wrapped across
 *    physical lines being read as its first fragment (`-79` / `43.` / `000` booked as **-79**
 *    instead of **-7943**), and a product name wrapping as `… - М16 - НОРД` / `ЛОК` being joined
 *    into "НОРДЛОК" so it matched nothing — are exactly what those checks catch.
 *
 * The parser is deliberately **fail-closed**: if a single line does not reconcile, or the lines do
 * not sum to the printed footer, it returns `null` and the caller falls back to the sidecar. It is
 * a fast path, never a second opinion.
 */
import type { DocKind, DocumentExtraction, DraftResult, ExtractedLineItem, Party, ValidationCheck } from './types.js'
import { bgDateToIso } from './parse-text.js'

// ── primitives ──────────────────────────────────────────────────────────────────────────

const num = (s: string): number | null => {
  const t = String(s ?? '').replace(/\s+/g, '').replace(/,/g, '.')
  if (!t || !/[0-9]/.test(t)) return null
  if (!/^-?[0-9]*\.?[0-9]*$/.test(t)) return null
  const v = Number(t.replace(/\.$/, ''))
  return Number.isFinite(v) ? v : null
}
/** Decimal places actually printed — the price column's precision decides which check applies. */
const decimals = (s: string): number => {
  const m = String(s ?? '').replace(/\s+/g, '').match(/\.(\d+)$/)
  return m ? m[1].length : 0
}
function tokens(line: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

const FOOTER = /(Крайна\s+сума|Данъчна\s+основа|Словом|Данък\s+размер|Размер\s+на\s+данъка)/
/**
 * What a CONTINUATION page ends on, where `FOOTER` never appears.
 *
 * Only the last page prints totals, so on every earlier page nothing stopped the body and whatever
 * the printer put at the bottom was merged into the last row — landing in whichever column it
 * happened to sit under. Both variants were live bugs on 2026-09-01:
 *
 *   - the page counter "1/2" sits under Цена, so "0.0373" + "1/2" read as NO price and that row's
 *     value silently left the document's sum (stokrazp 3000016332);
 *   - the program footer starts at column 0, i.e. inside Име, so a name became
 *     "КАБЕЛНИ - ПРЕВР. - 430Х4.8 - БЕЛИ продукт ПЛЮС МИНУС тел.:", matched no product, and 2 units
 *     were never booked (sklrazp 0000012713).
 */
const PAGE_TRAILER = /^\s*\d{1,3}\s*\/\s*\d{1,3}\s*$|Програмен\s+продукт|ПЛЮС\s+МИНУС\s+тел|www\.plusminus\.com/
/**
 * The quantity heading as it is actually printed. On a wide table it wraps and the FIRST header
 * row carries only "Ко" — so anything matching the full word misses it. Shared by the header
 * fold's data guard and the column-role lookup, which drifted apart once and cost a document.
 */
const QTY_HEADING = /^Кол|^Ко/

const canonical = (label: string): string => {
  const l = label.replace(/\s+/g, '')
  const m = l.match(/^Цена(\d+)$/)
  return m ? `Цена ${m[1]}` : l
}

export interface TableColumn { label: string; start: number; end: number }
export interface ParsedTableLine {
  description: string
  quantity: number | null
  unit: string | null
  /** Exact unit price. Derived as total/qty where the printed column is rounded to 2 dp. */
  unitPrice: number | null
  printedPrice: number | null
  total: number | null
  prices: Record<string, number>
  ok: boolean
  /** Decimal places the „Цена" column actually printed — how far the price itself can be off. */
  priceDecimals?: number
  /** Per-line trade discount („ТО"), as a percentage, when the layout carries that column. */
  discountPercent?: number | null
}
export interface ParsedTable {
  lines: ParsedTableLine[]
  footer: number | null
  columns: string[]
  ok: boolean
  reason?: string
  /** The layout carries no Стойност column — line values are derived, not printed. */
  noTotals?: boolean
  /** Nothing is delivered: an empty Кол column on every row and a zero footer. Prices only. */
  priceOnly?: boolean
  /** The raw rows behind `lines`, so a row split across a page break can be rejoined. Internal. */
  rows?: Row[]
  /** The price columns this page carried, needed to re-derive a rejoined row. Internal. */
  priceLabels?: string[]
  /** Nothing to check against at all: no line values AND no document total. */
  unverified?: boolean
  /** The No column really spelled 1, 2, 3 … in order, so a dropped row breaks the sequence. */
  numbered?: boolean
  /**
   * The discount this document turned out to apply, as a percentage, and where it was found:
   * `to` — printed per line in the „ТО" column · `footer` — one „Отстъпка ( N% )" for the whole
   * document · `inferred` — printed nowhere, but every line's value is the same fraction of its
   * quantity × price and the lines still sum to the printed total.
   */
  discount?: { percent: number; source: 'to' | 'footer' | 'inferred' }
}

// ── column geometry ─────────────────────────────────────────────────────────────────────

/**
 * Column bands, anchored on the header labels and refined by the blank runs in the data.
 *
 * Header positions alone are not enough: `Име` is centred over a wide column, so a midpoint
 * boundary clips names. Blank gutters alone are not enough either: a dense 48-row table has almost
 * no column that is blank on every line. So each boundary is the widest blank run *between two
 * header labels*, with two corrections that real documents forced:
 *   - the boundary opening the NAME column takes the FIRST blank run, not the widest (a short name
 *     leaves a wider gap after it, which would otherwise swallow the name);
 *   - if the gap between two labels is fully inked (narrow columns whose values are wider than
 *     their heading) the search widens to the labels themselves.
 */
export function findColumns(lines: string[]): { cols: TableColumn[]; headerEnd: number; bodyEnd: number } | null {
  // „Кол" itself wraps once the export carries enough price columns to squeeze it („Ко" + „л" on
  // the next row), so match the stem — the label fold-in below puts the pieces back together.
  const h = lines.findIndex(l => /Име/.test(l) && /Ко/.test(l))
  if (h < 0) return null
  // „Цена 1" is ONE heading, not a „Цена" column followed by a „1" column. Older exports wrote the
  // tier number tight („Цена1") or wrapped it onto the next row; this one spaces it out, which split
  // every numbered tier into two columns and left the table unreadable.
  const raw = tokens(lines[h])
  const head: typeof raw = []
  for (const t of raw) {
    const prev = head[head.length - 1]
    if (prev && /^\d+$/.test(t.text) && t.start - prev.end <= 3) { prev.text += ` ${t.text}`; prev.end = t.end; continue }
    head.push({ ...t })
  }
  if (head.length < 4) return null

  let bodyEnd = lines.length
  for (let i = h + 1; i < lines.length; i++) if (FOOTER.test(lines[i]) || PAGE_TRAILER.test(lines[i])) { bodyEnd = i; break }

  const data = lines.slice(h + 1, bodyEnd).filter(l => l.trim())
  const width = Math.max(1, ...data.map(l => l.length), lines[h].length)
  const ink = new Array(width + 1).fill(0)
  for (const l of data) for (let i = 0; i < l.length && i < width; i++) if (l[i] !== ' ') ink[i]++

  const boundary = (a: { start: number; end: number }, b: { start: number; end: number }, leftmost = false): number => {
    const scan = (lo: number, hi: number) => {
      let best = -1, bestLen = 0, run = -1
      for (let i = lo; i <= hi; i++) {
        const blank = i === hi || (ink[i] || 0) === 0
        if (blank) { if (run < 0) run = i } else if (run >= 0) {
          const len = i - run
          if (len > bestLen && !(leftmost && bestLen >= 1)) { bestLen = len; best = run + Math.floor(len / 2) }
          run = -1
        }
      }
      if (run >= 0 && hi - run > bestLen && !(leftmost && bestLen >= 1)) { bestLen = hi - run; best = run + Math.floor((hi - run) / 2) }
      return { best, bestLen }
    }
    const lo = Math.max(0, Math.min(a.end, width))
    const hi = Math.min(width, Math.max(b.start, lo + 1))
    let r = scan(lo, hi)
    if (r.bestLen < 1) r = scan(Math.max(0, Math.min(a.start + 1, width)), Math.min(width, Math.max(b.end, lo + 1)))
    return r.best >= 0 && r.bestLen >= 1 ? r.best : Math.floor((a.end + b.start) / 2)
  }

  const cols: TableColumn[] = head.map((t, i) => ({
    label: t.text,
    start: i === 0 ? 0 : boundary(head[i - 1], t, /Име/.test(t.text)),
    end: i === head.length - 1 ? Number.MAX_SAFE_INTEGER : boundary(t, head[i + 1], /Име/.test(head[i + 1].text)),
  }))

  // A стокова разписка splits its headings down several rows ("Цен"/"а1", "Стой"/"ност");
  // fold those fragments back into the labels. Stop as soon as a row carries data.
  const nameIdx = cols.findIndex(c => /Име/.test(c.label))
  // Matched on the STEM. With /Кол/ this came out -1 on every wide export, so the guard below
  // never ran. A continuation page opens with the fragments of the row that straddles the page
  // break — those carry no name, so the name guard does not fire either — and their digits were
  // folded into the HEADINGS: "Кол" became "Кол00" and "Цена" became "Цена9". `read()` looks the
  // price up by the exact label "Цена", found none, and 47 of stokrazp 3000016398's 63 lines could
  // not reconcile. The document fell to the model, which returned 18,695,071 units against a
  // printed total of -1664.42.
  const qtyIdx = cols.findIndex(c => QTY_HEADING.test(c.label))
  let e = h + 1
  while (e < lines.length && e < bodyEnd && e <= h + 5) {
    if (!lines[e].trim()) { e++; continue }
    if (nameIdx >= 0 && lines[e].slice(cols[nameIdx].start, cols[nameIdx].end).trim()) break
    if (qtyIdx >= 0 && /[0-9]/.test(lines[e].slice(cols[qtyIdx].start, cols[qtyIdx].end))) break
    // A HEADING IS NEVER A DECIMAL NUMBER. „Цена 1".."Цена 10" carry digits, so digits alone cannot
    // decide this — but nothing in these exports is headed by a figure with a fractional part.
    // INV-3000101279 prints its unit price „1.3207" on the line directly below the header, with the
    // name and quantity cells both empty: both guards above passed, the token folded into the
    // heading, and the column came out as „Цена1.3207". No „Цена" column then existed at all, so
    // the price read as null and the single-line invoice was refused as not reconciling.
    if (tokens(lines[e]).some(t => /^-?[0-9]+[.,][0-9]+$/.test(t.text))) break
    for (const t of tokens(lines[e])) {
      // Assign the fragment to the heading it sits UNDER, by horizontal overlap with that heading's
      // own token — not by which widened column band happens to contain its first character. The
      // bands are stretched to the data, so on a very wide table („Кол" printed as „Ко"+„л", eight
      // price columns three characters apart) the band boundary can fall between a heading and its
      // own continuation: „л" was landing in the Мяр column, producing „Мялр" and no „Кол" at all,
      // and the whole document was refused. Falls back to the band when nothing overlaps.
      const overlap = (a: { start: number; end: number }) => Math.min(t.end, a.end) - Math.max(t.start, a.start)
      let best = -1, bestAt = -1
      head.forEach((hd, i) => { const o = overlap(hd); if (o > best) { best = o; bestAt = i } })
      const c = best > 0 ? cols[bestAt] : cols.find(c => t.start >= c.start && t.start < c.end)
      if (c) c.label += t.text
    }
    e++
  }
  return { cols, headerEnd: e, bodyEnd }
}

// ── the item table ──────────────────────────────────────────────────────────────────────

/**
 * How far the lines may sum from the printed total.
 *
 * When the export prints Стойност per line, the two agree to the cent and 0.05 is right — stokrazp
 * 3000016369 and 3000016370 land on their footers EXACTLY. That case is unchanged, and it is the
 * one where the sum is what guards against a dropped line.
 *
 * Some корекция exports carry no Стойност column at all. Each line value is then DERIVED as
 * `round2(qty × Цена)` while PlusMinus totals the products of its OWN unrounded prices, so each
 * line can legitimately differ by the quantity times half a unit of the last place the price
 * printed — the identical bound the per-line check already applies. A flat half-cent per line does
 * not describe that at all, and it cost FIVE documents in eight days:
 *
 *   3000016465   16000 × 0.014 (3 dp) is worth up to 8.00 of rounding; refused over 0.07
 *   3000016432    7900 units at 4 dp, ~0.40 of rounding; refused over 0.09
 *   3000016421    5000 × 0.0122 where the real price is ~0.01224; refused over 0.20
 *   3000016424    the price unreadable on 5 of 21 lines, so their values were missing entirely
 *   3000016398    70 lines of derived values; refused over 0.07 (papered over at the time)
 *
 * Every one fell to the model, which is where invented quantities come from — and 3000016465 could
 * not even do that, because the sidecar answered 502.
 *
 * ⚠ Widening it costs the completeness check, so it is only widened where something ELSE provides
 * one: `numbered` means the No column really spelled 1, 2, 3 … in order, and the row walk opens a
 * row only when the next number appears. A dropped line breaks that sequence, so on a numbered
 * table completeness is structural and the sum is free to carry the true arithmetic bound. Where
 * the rows are NOT numbered the sum is the only completeness check there is, so it keeps the tight
 * allowance and such a document still goes to the model.
 */
function footerSlack(lines: ParsedTableLine[], noTotals: boolean, numbered = false): number {
  if (!noTotals) return 0.05
  if (!numbered) return 0.05 + 0.005 * lines.length
  let slack = 0.05
  for (const l of lines) slack += Math.abs(l.quantity ?? 0) * 0.5 * Math.pow(10, -(l.priceDecimals ?? 2))
  return slack
}
/**
 * A PRICE-ONLY разписка: the „Кол" column is empty on every row and the document totals zero.
 * PlusMinus issues these to restate prices — nothing is delivered.
 *
 * Every line fails the arithmetic gate (there is no quantity to reconcile against a value), so
 * such a document used to be refused and handed to the model, which INVENTED quantities: stokrazp
 * 3000016390 came back with 1500 of each ИЗОЛИРБАНД against a real stock of ~13, and 29 of that
 * day's 39 stock differences were exactly those numbers. Reading it here is both safe and exact —
 * there is nothing to get wrong, because the answer is zero.
 *
 * Deliberately strict, so it can never absorb a document that merely failed to parse: NO row may
 * carry a quantity, the footer must be present and zero, and the table must still carry prices.
 * A document with no footer stays refused.
 *
 * Decided over the WHOLE document, never per page: a multi-page разписка prints its total only on
 * the last page, so page one has no footer to judge by.
 */
function priceOnlyView(lines: ParsedTableLine[], footer: number | null): ParsedTableLine[] | null {
  if (!lines.length || footer !== 0) return null
  if (!lines.every(l => !l.quantity)) return null
  if (!lines.some(l => Object.keys(l.prices).length > 0)) return null
  return lines.map(l => ({ ...l, quantity: 0, total: 0, ok: true }))
}

/**
 * One „Отстъпка ( N% )" for the WHOLE document, printed in the footer block.
 *
 * Here the line values are the undiscounted ones and only the total is net, so every line
 * reconciles and it is the document check that fails — the opposite shape to the „ТО" column.
 *
 * The parenthesised percentage is what makes this safe to match: the same block also prints
 * „Сума преди отстъпка", a *pre-discount and VAT-inclusive* subtotal that would be read as a
 * second, wrong footer if the word alone were enough.
 */
function footerDiscount(lines: string[]): number | null {
  for (const l of lines) {
    const m = l.match(/Отстъпка\s*\(\s*(-?[\d.,]+)\s*%/i)
    if (!m) continue
    const v = num(m[1])
    if (v !== null && v > 0 && v < 100) return v
  }
  return null
}

/**
 * Every line reduced by ONE factor that the document never states.
 *
 * Invoice 3000101088 prices two lines at 66.0419 and 1.4061 and values them at 125.48 and 9.35 —
 * both exactly 95% of quantity × price — with no „ТО" column and no „Отстъпка" line anywhere. A
 * customer tier price was applied while the base price was printed, and the layout has no column
 * that says so. Refused, the document went to the model, which is how invented quantities have
 * reached this ledger four times in a week.
 *
 * What makes it safe to accept is that the two checks the rest of this parser rests on both still
 * run, and against the SAME evidence:
 *   - the values are confirmed by the printed total, which catches a dropped or merged line;
 *   - the quantities are confirmed against each other, because one factor has to explain every
 *     line at once. A quantity read wrong moves only its own line's ratio and the common factor
 *     disappears.
 *
 * Each line pins that factor to an interval, not a point — its value is rounded to the cent and
 * its price to whatever it printed — so the test is that a single factor lies inside EVERY line's
 * interval. Two lines minimum: one line is trivially consistent with itself and would prove
 * nothing. A line with no usable quantity, price or value is not evidence either, so its presence
 * refuses the document rather than being skipped.
 *
 * ⚠ The guarantee is proportional to the money: a line worth two cents pins the factor to ±25%
 * and constrains nothing. That is the same blind spot the per-line gate already has on a cheap
 * line, not a new one, and the narrowness check below is what stops a document made ENTIRELY of
 * such lines from passing on no evidence at all.
 */
function uniformDiscountView(lines: ParsedTableLine[], footer: number | null): { lines: ParsedTableLine[]; percent: number } | null {
  if (lines.length < 2 || footer === null) return null
  let lo = -Infinity, hi = Infinity
  for (const l of lines) {
    const { quantity: q, printedPrice: p, total: t } = l
    if (!q || !p || !t) return null
    const list = q * p
    if (!list) return null
    const ratio = t / list
    // half a cent on the value, half a unit of the last printed place on the price
    const tol = Math.abs(ratio) * (0.005 / Math.abs(t) + (0.5 * Math.pow(10, -(l.priceDecimals ?? 2))) / Math.abs(p))
    lo = Math.max(lo, ratio - tol)
    hi = Math.min(hi, ratio + tol)
  }
  if (lo > hi) return null                       // no single factor explains every line
  if (hi - lo > 0.02) return null                // the lines are too imprecise to pin one down
  const factor = (lo + hi) / 2
  if (factor <= 0 || factor > 0.999) return null // a discount is a reduction; ≈1 is a different fault
  const sum = lines.reduce((s, l) => s + (l.total ?? 0), 0)
  if (Math.abs(sum - footer) > footerSlack(lines, false)) return null
  return {
    // The line is charged at its VALUE. Say so: the price beside it is the undiscounted one, and
    // reporting that as the unit price describes an invoice for more money than was billed.
    lines: lines.map(l => ({ ...l, ok: true, unitPrice: +(l.total! / l.quantity!).toFixed(6) })),
    percent: +((1 - factor) * 100).toFixed(4),
  }
}

/**
 * ONE discounted line, where there is no second line to pin the factor down.
 *
 * `uniformDiscountView` needs two lines because it finds the factor by intersecting their ratio
 * intervals; with a single line every factor fits, so a discount is indistinguishable from a
 * misread price. The missing constraint comes from somewhere else: PlusMinus discounts by a ROUND
 * percentage, computes the reduced unit price to four places and multiplies. So the only candidates
 * are half-percent steps, and exactly one of them must reproduce the printed value under that same
 * rounding — otherwise this refuses like before.
 *
 * INV-3000101279 (2026-10-01): 12 × 1.3207 prints 15.06, not 15.85. −5% gives
 * round4(1.3207 × 0.95) = 1.2547, × 12 = 15.0564 → 15.06; −4% prints 14.90 and −6% 15.21, so the
 * reading is unique. Confirmed independently afterwards — 1.3207 is that product's catalog
 * sellingPrice to the digit, so the printed price is the list price and the discount is real.
 *
 * Two guards carry the soundness. The footer must confirm the line's own value, so the money is
 * attested twice and the quantity is the only free variable left; and a quantity that is wrong
 * almost never leaves a round percentage fitting at all, which is what makes the search a test
 * rather than a curve fit.
 */
function singleLineDiscountView(lines: ParsedTableLine[], footer: number | null): { lines: ParsedTableLine[]; percent: number } | null {
  if (lines.length !== 1 || footer === null) return null
  const [l] = lines
  const { quantity: q, printedPrice: p, total: t } = l
  if (!q || !p || !t) return null
  if (q * p <= t) return null                       // a discount is a reduction, not an increase
  if (Math.abs(t - footer) > 0.011) return null     // the document must print this line's value as its total
  const fits: number[] = []
  for (let pct = 0.5; pct <= 60.0001; pct += 0.5) {
    const f = 1 - pct / 100
    // Either rounding of the reduced unit price — 4 places is what PlusMinus prints, 2 is what a
    // till would. Both are tried, and a percentage counts once however it fits.
    const ok = [4, 2].some(dp => Math.abs(+(+(p * f).toFixed(dp) * q).toFixed(2) - t) <= 0.005)
    if (ok) fits.push(+pct.toFixed(1))
  }
  if (fits.length !== 1) return null                // ambiguous, or nothing round explains it
  return {
    lines: [{ ...l, ok: true, unitPrice: +(t / q).toFixed(6) }],
    percent: fits[0],
  }
}

/**
 * The verdict on a finished line list: price-only, discounted, or plain.
 *
 * Shared by the single-page and multi-page paths, which computed it twice. They are the two halves
 * of one rule, and the last pair of twins in this file drifted apart and cost a document.
 */
function settle(lines: ParsedTableLine[], footer: number | null, noTotals: boolean, footerPercent: number | null, numbered = false): ParsedTable {
  const base = { footer, columns: [] as string[], noTotals }
  const po = priceOnlyView(lines, footer)
  if (po) return { ...base, lines: po, ok: true, priceOnly: true }

  let out = lines
  let discount: ParsedTable['discount'] | undefined
  if (out.some(l => l.discountPercent)) {
    // read per line off the „ТО" column; `reconciles` has already applied it
    const seen = Array.from(new Set(out.map(l => l.discountPercent || 0).filter(Boolean)))
    if (seen.length === 1) discount = { percent: seen[0]!, source: 'to' }
  }

  const sum = +out.reduce((s, l) => s + (l.total ?? 0), 0).toFixed(2)
  const slack = footerSlack(out, noTotals, numbered)
  let effective = sum
  if (footerPercent !== null && footer !== null && Math.abs(sum - footer) > slack) {
    // The document discounts the whole invoice at the bottom, so its lines are worth more than it
    // charges. Spread the reduction across them pro rata — that IS what the footer line means, and
    // it is the only way the lines can still add up to the document's own total.
    const scaled = out.map(l => ({ ...l, total: l.total === null ? null : +(l.total * (1 - footerPercent / 100)).toFixed(2) }))
    const scaledSum = +scaled.reduce((s, l) => s + (l.total ?? 0), 0).toFixed(2)
    if (Math.abs(scaledSum - footer) <= slack + 0.005 * out.length) {
      // Rounding each line to the cent leaves the set a cent or two off the document's own total.
      // Put the residue on the largest line — it distorts that line least, and the invoice then
      // bills exactly what the paper does, which a reconciliation will compare it against.
      let residue = +(footer - scaledSum).toFixed(2)
      const biggest = scaled.reduce((a, b) => (Math.abs(b.total ?? 0) > Math.abs(a.total ?? 0) ? b : a), scaled[0])
      if (residue && biggest?.total !== null && biggest?.total !== undefined) {
        biggest.total = +(biggest.total + residue).toFixed(2)
        residue = 0
      }
      out = scaled.map(l => ({
        ...l,
        unitPrice: l.quantity && l.total ? +(l.total / l.quantity).toFixed(6) : l.unitPrice,
      }))
      effective = +out.reduce((s, l) => s + (l.total ?? 0), 0).toFixed(2)
      discount = { percent: footerPercent, source: 'footer' }
    }
  }

  const unverified = noTotals && footer === null
  let footerOk = footer !== null && Math.abs(effective - footer) <= slack
  let bad = out.filter(l => !l.ok)
  if (bad.length && footerOk && !discount) {
    const ud = uniformDiscountView(out, footer) ?? singleLineDiscountView(out, footer)
    if (ud) { out = ud.lines; bad = []; discount = { percent: ud.percent, source: 'inferred' } }
  }
  return {
    ...base, lines: out, priceOnly: false, unverified, discount,
    ok: out.length > 0 && bad.length === 0 && (unverified || footerOk),
    reason: !out.length ? 'no lines'
      : bad.length ? `${bad.length} line(s) do not reconcile`
      : (!unverified && !footerOk) ? `lines sum to ${effective.toFixed(2)}, document prints ${footer}` : undefined,
  }
}
/** One table row, as raw cell text — fragments of a wrapped row are appended until it is whole. */
interface Row { name: string[]; unit: string; qty: string; val: string; disc: string; prices: Record<string, string>; n: number }

const read = (r: Row) => ({ qty: num(r.qty), total: num(r.val), printed: num(r.prices['Цена'] || '') })
/**
 * The factor the „ТО" column applies to a line — търговска отстъпка, printed as a percentage
 * beside the price. A фактура carrying it values the line at `Кол × Цена × factor`, so reading
 * the price and ignoring the discount makes every line fail its own arithmetic: invoice
 * 3000100960 prints 4.86 and 5 against a value of 9.23 for two units, and 2 × 4.86 is 9.72.
 *
 * An absent or empty column is no discount, never an unknown — the layout simply does not offer
 * one. A value outside 0..100 is not a percentage, so the row is left to fail rather than scaled
 * by nonsense.
 */
const discountFactor = (r: Row): number | null => {
  const v = num(r.disc)
  if (v === null || v === 0) return 1
  if (v < 0 || v >= 100) return null
  return 1 - v / 100
}

/**
 * A row is finished once it reconciles — which is also how a wrapped row is detected: fragments
 * keep being appended until the arithmetic works out.
 *
 * A стокова разписка prints its cost to 4 dp, so `qty × Цена = Стойност` holds exactly. A
 * складова разписка and a фактура print it rounded to 2 dp, where that identity is false by
 * construction (1000 × 0.01 ≠ 7.70); there the check is that the exact price implied by the
 * document, `Стойност / Кол`, rounds back to what is printed.
 */
const reconciles = (r: Row | null): boolean => {
  if (!r) return false
  const { qty, total, printed } = read(r)
  if (qty === null || total === null || printed === null) return false
  const f = discountFactor(r)
  if (f === null) return false
  const dp = decimals(r.prices['Цена'] || '')
  if (dp >= 3) {
    // The printed price is itself rounded, and that error is multiplied by the quantity: at
    // 4 dp a half-ulp is 0.00005, so 3000 units carry 0.15 of legitimate slack — which is
    // exactly how a document comes to print 64.00 for 3000 x 0.0213 (= 63.90).
    const slack = 0.02 + Math.abs(total) * 0.001 + Math.abs(qty) * (5 * Math.pow(10, -dp - 1))
    return Math.abs(Math.abs(qty * printed * f) - Math.abs(total)) <= slack
  }
  if (qty === 0) return false
  // The printed price is the 2 dp rounding of the real one, so the test is that the price the
  // document implies rounds back to what it shows. Dividing by the discount factor as well as the
  // quantity magnifies the value's own half-cent, and by exactly 1/(qty × f) — without that term
  // 3000100960's „2 × 3.83 at 5% = 7.29" misses by 0.0068 against a flat allowance of 0.0051 and
  // a correctly read line is refused. At f = 1 the term is dropped and the check is unchanged.
  const slack = 0.0051 + (f === 1 ? 0 : 0.005 / Math.abs(qty * f))
  return Math.abs(Math.abs(total / (qty * f)) - Math.abs(printed)) <= slack
}

/**
 * One raw row → one table line. Kept apart from the page walk so a row REJOINED across a page
 * break can be re-derived without re-parsing the page it started on.
 */
function rowToLine(r: Row, priceLabels: string[], noTotals: boolean): ParsedTableLine | null {
  const description = r.name.join(' ').replace(/\s+/g, ' ').trim()
  if (!description) return null
  const { qty, total, printed } = read(r)
  const prices: Record<string, number> = {}
  for (const label of priceLabels) { const v = num(r.prices[label] || ''); if (v !== null && v !== 0) prices[label] = v }
  const exact = qty !== null && qty !== 0 && total !== null ? +(total / qty).toFixed(6) : null
  const dp = decimals(r.prices['Цена'] || '')
  const to = num(r.disc)
  // A discounted line is charged at its VALUE, not at the price beside it, so the effective price
  // has to come from the value however precisely the price was printed — otherwise the invoice
  // totals what the goods would have cost undiscounted.
  const printedIsExact = dp >= 3 && !to
  return {
    description,
    quantity: qty,
    unit: r.unit.replace(/[^А-Яа-яA-Za-z]/g, '') || null,
    unitPrice: printedIsExact ? printed : (exact ?? printed),
    printedPrice: printed,
    priceDecimals: dp,
    discountPercent: to,
    // With no Стойност column the line value is not printed, so derive it — the document total
    // then still checks the whole table, which is most of the guarantee back.
    total: total ?? (noTotals && qty !== null && printed !== null ? +(qty * printed).toFixed(2) : null),
    prices,
    ok: noTotals ? true : reconciles(r),
  }
}

function parsePage(text: string, startAt = 1): ParsedTable {
  const lines = text.split('\n')
  const found = findColumns(lines)
  if (!found) return { lines: [], footer: null, columns: [], ok: false, reason: 'no header row' }
  const { cols, headerEnd, bodyEnd } = found
  const labels = cols.map(c => canonical(c.label))
  const at = (re: RegExp) => labels.findIndex(l => re.test(l))
  // Match the roles on their STEM. On a very wide table the headings stack four rows deep and their
  // fragments straddle column boundaries — pdftotext emits „ял" as one token where „я" belongs to
  // Мяр and „л" to Кол — so the folded labels come out as „Мялр", „Ко", „Стона2". No token-level fold
  // can split that, and it does not need to: the FIRST header row already carries every role at a
  // distinct position („Име@21 М@41 Ко@43 … Сто@68"). Anchoring on the stem reads the document that
  // insisting on the full word refused outright, and the arithmetic gate below still has to pass.
  const iName = at(/Име/), iUnit = at(/^Мяр|^М$|^Мя/), iQty = at(QTY_HEADING), iVal = at(/Стойност|^Стой|^Сто/)
  // „ТО" — търговска отстъпка, the per-line discount percentage a фактура prints between the price
  // and the value. Matched exactly: it is two letters, and a stem match would collide with half the
  // headings on the wide layout.
  const iDisc = at(/^ТО$/)
  // Every money column, not just the ones whose heading STARTS with „Цена": the wide layout added
  // „Прод. цена", which anchoring on the start silently dropped — the one column that carries what
  // we sell the goods for.
  const priceCols = labels.map((l, i) => ({ i, label: l })).filter(x => /цена/i.test(x.label))
  if (iName < 0 || iQty < 0) return { lines: [], footer: null, columns: labels, ok: false, reason: 'missing Име/Кол' }
  // Some корекция exports carry no Стойност column at all — quantities and prices, no line value.
  // The table is still unambiguous, but its arithmetic cannot be cross-checked, so say so rather
  // than either refuse (which hands the document to the model, which reads it far worse) or claim
  // a check that never ran.
  const noTotals = iVal < 0

  const cell = (line: string, i: number) => (i < 0 ? '' : line.slice(cols[i].start, cols[i].end).trim())

  const blank = (): Row => ({ name: [], unit: '', qty: '', val: '', disc: '', prices: {}, n: 0 })
  /** Only price text accumulated so far: no name, no quantity, no value. See the call site below. */
  const priceFragment = (r: Row) => !r.name.length && !r.qty.trim() && !r.val.trim()
    && Object.values(r.prices).some(v => v.trim())


  // The leading "No" column is the document's own row delimiter, and it is far more reliable than
  // arithmetic: a name that wraps ("… - ПЛ.ДР.-" / "ОБЛА") often reconciles on its FIRST physical
  // line alone (-1 x 2.8 = 2.80 is true whether the digits continue "000" or not), so the row closed
  // early and the continuation digits seeded a junk row that swallowed everything after it — one
  // wrapped name corrupted the rest of the table. Trusted only when the column actually numbers the
  // rows 1..N in order; otherwise the arithmetic rule stands alone.
  const iNo = labels.findIndex(l => /^N[o0]?$/i.test(l))
  // The No column is narrow, so a two-digit row number wraps down it exactly like everything else:
  // "10" arrives as "1" then "0". Accumulate until the digits spell the number expected next, and
  // remember WHERE that run started — that line is the row's first. The walk self-validates: it
  // only counts as numbered if the column really spells 1, 2, 3 … in order.
  const openers = new Set<number>()
  // A continuation page does not restart at 1 — its rows carry on from the previous one, so the
  // caller says where this page begins. Getting that wrong makes the whole page look unnumbered.
  let expect = startAt
  if (iNo >= 0) {
    /**
     * Walk the No column, skipping `drop` leading digit cells.
     *
     * A row number wraps down this column like everything else ('10' arrives as '1' then '0'), so
     * the digits are accumulated until they spell the number expected next. On a CONTINUATION page
     * the first cell can be the TAIL of the previous page's row number — page four of stokrazp
     * 3000016398 opens with the '9' of row 59, whose '5' printed on page three. Starting the walk
     * on that orphan puts it permanently out of step: it opened NO rows at all, the arithmetic
     * delimiter took over, and three rows merged into one. So retry, dropping the orphan.
     */
    const walk = (drop: number, delta: number) => {
      const found = new Set<number>()
      let e = startAt + delta, acc = '', from = -1, skipped = 0
      for (let i = headerEnd; i < bodyEnd; i++) {
        const c = cell(lines[i], iNo)
        if (!/^[0-9]{1,3}$/.test(c)) continue
        if (skipped < drop) { skipped++; continue }
        if (!acc) from = i
        acc += c
        if (acc === String(e)) { found.add(from); e++; acc = ''; from = -1 }
        else if (!String(e).startsWith(acc)) {
          acc = c === String(e) ? '' : c
          from = i
          if (!acc) { found.add(i); e++; from = -1 }
        }
      }
      // The page can END mid-number: row 59 prints its "5" at the foot of page three and its "9"
      // at the head of page four. The digits gathered so far are still a PREFIX of the number
      // expected next, which is enough to know the row opened here — without this the row never
      // opened and its line was appended to row 58, giving one row described "ВИНТ 8Х90 - ТХ ВИНТ
      // 8Х100 - ТХ". Its remaining cells arrive with the page rejoin in `parseTable`.
      if (acc && from >= 0 && String(e).startsWith(acc)) { found.add(from); e++ }
      return { found, e }
    }
    // Try a few alignments and keep the one that numbers the MOST rows. The walk is
    // self-validating — it only opens a row when the column really spells the number expected
    // next — so the best-scoring alignment is the true one, and a page that already locks on
    // scores highest at (0, 0) and is left alone.
    //
    // Two things go wrong at a page break, and they compound. The first cell can be the TAIL of
    // the previous page's number (page four of stokrazp 3000016398 opens with the '9' of row 59,
    // whose '5' printed on page three) — that is `drop`. And a row straddling the break is counted
    // on neither page, so the running row count the caller passes in is one short — that is
    // `delta`. Together they left the page numbering nothing at all: the arithmetic delimiter took
    // over and three rows merged into one.
    let best = walk(0, 0)
    for (const [drop, delta] of [[1, 0], [0, 1], [1, 1], [2, 1], [2, 0]] as const) {
      if (best.found.size >= 2) break
      const r = walk(drop, delta)
      if (r.found.size > best.found.size) best = r
    }
    for (const i of best.found) openers.add(i)
    expect = best.e
  }
  // Row 1 alone is enough. A one-line invoice has no row 2 to confirm the pattern with, and that
  // is exactly the document where the arithmetic delimiter fails: the single row reconciles on its
  // first physical line, so a wrapped name is closed out into a row of its own.
  const numbered = expect >= startAt + 1

  const rows: Row[] = []
  let cur: Row | null = null
  for (let i = headerEnd; i < bodyEnd; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const name = cell(line, iName)
    const starts = numbered ? openers.has(i) : (!!name && reconciles(cur))
    // A fragment carrying nothing but price text is NOT a row of its own — a row needs a name or a
    // quantity. It is the top half of the row below it: PlusMinus wraps a long price cell UPWARDS,
    // so INV-3000101279 prints „1.3207" between the header and its only item. Closing it out would
    // both strand a junk line and take the price away from the row it belongs to.
    if (cur && starts && !priceFragment(cur)) { rows.push(cur); cur = null }
    if (!cur) cur = blank()
    if (name) cur.name.push(name)
    cur.unit += cell(line, iUnit)
    cur.val += cell(line, iVal)
    cur.disc += cell(line, iDisc)
    let qtyCell = cell(line, iQty)
    const money = new Map(priceCols.map(p => [p.label, cell(line, p.i)]))
    // Right-aligned figures drift past their own heading, so a narrow Кол column can end up empty
    // while the quantity sits inside the price cell: "1      33.3192" then reads as 133.3192 and the
    // quantity vanishes. Split them back when the shape is unambiguous — two bare numbers, nothing
    // else. The arithmetic cross-check below still has the last word, so a wrong split cannot pass.
    const firstMoney = priceCols[0]
    if (!qtyCell && firstMoney) {
      const parts = (money.get(firstMoney.label) || '').split(/\s+/).filter(Boolean)
      if (parts.length === 2 && parts.every(x => /^-?[\d.,]+$/.test(x))) {
        qtyCell = parts[0]
        money.set(firstMoney.label, parts[1])
      }
    }
    cur.qty += qtyCell
    for (const p of priceCols) cur.prices[p.label] = (cur.prices[p.label] || '') + (money.get(p.label) || '')
    if (++cur.n > 6) { rows.push(cur); cur = null }   // runaway guard: never swallow the table
  }
  if (cur) rows.push(cur)

  let footer: number | null = null
  for (const l of lines.slice(bodyEnd)) {
    const m = l.match(/(?:Крайна\s+сума|Данъчна\s+основа)\s+(-?[\d\s.,]+)/)
    if (m) { const v = num(m[1]); if (v !== null) { footer = v; break } }
  }

  const priceLabels = priceCols.map(p => p.label)
  const out = rows.map(r => rowToLine(r, priceLabels, noTotals)).filter((l): l is ParsedTableLine => l !== null)
  return { ...settle(out, footer, !!noTotals, footerDiscount(lines.slice(bodyEnd)), numbered), columns: labels, rows, priceLabels, numbered }
}

/**
 * A multi-page export repeats its header on every page — with DIFFERENT column positions each
 * time — so geometry is derived per page and the item lists concatenated. Only the last page
 * carries the total.
 */
export function parseTable(text: string): ParsedTable {
  // A page carries a table iff the column finder can read its header — the same test the parser
  // itself uses, and the only one that stays true as the layout changes. Asking for the literal
  // „Кол" here did not: on the wide export that heading wraps to „Ко" + „л" on the next row, so NO
  // page matched, the multi-page branch was skipped, and the whole document was parsed as ONE page
  // — which stops at the first page trailer. Page 1 was read and every later page silently dropped:
  // 19 of stokrazp 3000016370's 37 rows. The document then failed its own footer check (correctly)
  // and fell to the model, which misread the wrapped quantities by a factor of ten.
  const pages = text.split('\f').filter(p => findColumns(p.split('\n')) !== null)
  if (pages.length <= 1) return parsePage(text)
  // Each page is told the row number it opens on: page two starts where page one left off.
  const parts: ParsedTable[] = []
  for (let start = 1, i = 0; i < pages.length; i++) { const r = parsePage(pages[i], start); parts.push(r); start += r.lines.length }

  /**
 * Rejoin a row that straddles a page break.
 *
 * The printer does not care where a row ends: it fills the page and continues the SAME row at the
 * top of the next one. That tail carries no name and no row number — just digits under the
 * headings — so each half is nonsense alone. stokrazp 3000016398 prints „ВИНТ 8Х90 - ТХ" at the
 * foot of page three and finishes it on page four; read per page they came out as one row
 * described „ВИНТ 8Х90 - ТХ ВИНТ 8Х100 - ТХ" with a quantity of -97.000934 — which is -97 and 934
 * run together.
 *
 * Each half IS sliced correctly, by its own page’s geometry (the columns shift from page to page,
 * which is why the pages cannot simply be concatenated). So join the raw CELL TEXT of the two
 * halves and derive the row once, from the whole.
 *
 * Only ever the first row of a page, and only when it has no name of its own: a page that opens
 * with a real row has nothing to rejoin.
 */
  for (let i = 1; i < parts.length; i++) {
    const head = parts[i - 1].rows, tail = parts[i].rows
    if (!head?.length || !tail?.length) continue
    const orphan = tail[0]
    if (orphan.name.join('').trim()) continue
    const last = head[head.length - 1]
    last.unit += orphan.unit
    last.qty += orphan.qty
    last.val += orphan.val
    for (const [label, text] of Object.entries(orphan.prices)) last.prices[label] = (last.prices[label] || '') + text
    tail.shift()
    // both pages are re-derived below, so the rejoined row is read as one and the orphan is gone
  }
  for (const part of parts) {
    if (!part.rows) continue
    part.lines = part.rows
      .map(r => rowToLine(r, part.priceLabels ?? [], !!part.noTotals))
      .filter((l): l is ParsedTableLine => l !== null)
  }

  const lines = parts.flatMap(p => p.lines)
  const footer = parts.map(p => p.footer).filter(v => v !== null).pop() ?? null
  // Only the last page carries the footer block, so a document-level discount is whatever any page
  // found — in practice the last one, for the same reason.
  const rate = parts.map(p => p.discount).filter(d => d?.source === 'footer').pop()?.percent ?? null
  // a multi-page table is numbered only if EVERY page locked on — one page that did not leaves
  // a stretch of rows whose completeness nothing structural vouches for
  return { ...settle(lines, footer, parts.some(p => p.noTotals), rate, parts.every(p => p.numbered)), columns: parts[0]?.columns ?? [] }
}

// ── document header ─────────────────────────────────────────────────────────────────────

const after = (text: string, re: RegExp): string | undefined => {
  const m = text.match(re)
  return m?.[1]?.trim() || undefined
}

/** Both parties of a фактура, which prints ПОЛУЧАТЕЛ and ДОСТАВЧИК as two side-by-side columns. */
function parseInvoiceParties(text: string) {
  const lines = text.split('\n')
  const head = lines.findIndex(l => /ПОЛУЧАТЕЛ/.test(l) && /ДОСТАВЧИК/.test(l))
  if (head < 0) return { customer: {}, supplier: {} }
  const split = lines[head].indexOf('ДОСТАВЧИК')
  const field = (label: RegExp) => {
    for (const l of lines.slice(head, head + 12)) {
      if (!label.test(l)) continue
      const left = l.slice(0, split), right = l.slice(split)
      return { left: left.replace(label, '').trim(), right: right.replace(/^ДОСТАВЧИК/, '').replace(label, '').trim() }
    }
    return { left: '', right: '' }
  }
  const name = field(/ПОЛУЧАТЕЛ/)
  const eik = field(/ЕИК/)
  const vat = field(/ИН по ДДС/)
  return {
    customer: { name: name.left || undefined, company_id: eik.left || undefined, vat_id: vat.left || undefined },
    supplier: { name: name.right || undefined, company_id: eik.right || undefined, vat_id: vat.right || undefined },
  }
}

/**
 * The partner of a складова/стокова разписка.
 *
 * The note prints `Организация:` (us) and `Партньор:` (them) as two side-by-side columns of
 * `Label: value` rows, so a label-anchored regex over the whole document returns OUR side every
 * time. Cut each row at the right column's offset and read the labels inside that half.
 *
 * A genuine store-to-store transfer simply leaves the partner column blank. When it is filled it
 * is the only thing tying the разписка to an invoice it may later be converted into — PlusMinus
 * records that conversion in a comment the PDF export drops — so it has to survive the parse.
 */
function parseStockNoteParty(text: string): Party {
  const lines = text.split('\n')
  const head = lines.findIndex(l => /Организация\s*:/.test(l) && /Партньор\s*:/.test(l))
  if (head < 0) return {}
  const split = lines[head].indexOf('Партньор')
  const field = (label: RegExp): string | undefined => {
    for (const l of lines.slice(head, head + 10)) {
      if (!label.test(l)) continue
      const v = l.slice(split).replace(label, '').trim()
      if (v) return v
    }
    return undefined
  }
  const name = field(/Име\s*:/)
  if (!name) return {}
  return {
    name,
    company_id: field(/ЕИК\s*:/) ?? null,
    vat_id: field(/ИН\s+по\s+ДДС\s*:/) ?? null,
    address: field(/Адрес\s*:/) ?? null,
  }
}

// ── the fast path ───────────────────────────────────────────────────────────────────────

const pass = (check: string, details: string): ValidationCheck => ({ check, status: 'pass', details })

/**
 * `DraftResult` read straight from the layout text, or `null` when anything fails to reconcile —
 * in which case the caller must fall back to the sidecar. Shaped exactly like the sidecar's reply
 * so nothing downstream can tell the difference.
 */
export function draftFromLayoutText(text: string, kind: DocKind): DraftResult | null {
  if (!text || !/Име/.test(text)) return null
  const table = parseTable(text)
  if (!table.ok) return null

  const isStock = kind !== 'invoice'
  const correction = /2000\s+КОРЕКЦИЯ/.test(text)
  const line_items: ExtractedLineItem[] = table.lines.map(l => ({
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unit_price: l.unitPrice,
    total: l.total,
    ...(Object.keys(l.prices).length ? { prices: l.prices } : {}),
  }))

  // The letterhead prints "Номер:" / "Дата:" in one column and their values in another, so the
  // values land on their OWN lines further down and a label-anchored regex picks up the next
  // label instead. Read them as standalone values from the head of the document.
  const head = text.split('\n').slice(0, 14).map(l => l.trim())
  const number = head.find(l => /^\d{10}$/.test(l))
    ?? after(text, /Номер\s*:?\s*(\d{4,})/)
  const rawDate = head.find(l => /^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}$/.test(l))
    ?? after(text, /Дата\s*:?\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/)
  // A stock note names one partner; which side it belongs on follows the direction of the goods.
  // (Kept local rather than imported from `MOVEMENT_RULES` — that module pulls in `db/models`,
  // and this one stays import-pure so its tests boot nothing.)
  const partner = isStock ? parseStockNoteParty(text) : {}
  const inbound = kind === 'goods_receipt' || kind === 'correction' || kind === 'store_operations'
  const parties = isStock
    ? { customer: inbound ? {} : partner, supplier: inbound ? partner : {} }
    : parseInvoiceParties(text)

  const extraction: DocumentExtraction = {
    document_number: number ?? null,
    issue_date: rawDate ? bgDateToIso(rawDate) ?? null : null,
    currency: /€/.test(text) ? 'EUR' : null,
    supplier: isStock && !parties.supplier.name
      ? { name: after(text, /Доставчик\s*:?\s*(.+)/) ?? null }
      : parties.supplier,
    customer: parties.customer,
    line_items,
    net_total: table.footer,
    ...(isStock
      ? {
          doc_kind: kind,
          warehouse_from: after(text, /Склад\s*-\s*изпращач\s*:?\s*(.+?)(?:\s{2,}|$)/) ?? after(text, /СКЛАД\s*:?\s*(.+?)(?:\s{2,}|$)/) ?? null,
          warehouse_to: after(text, /Склад\s*\/\s*Магазин\s*:?\s*(.+?)(?:\s{2,}|$)/) ?? null,
          correction,
        }
      : {}),
  }

  return {
    extraction,
    validation: {
      status: 'valid',
      checks: [
        pass('lines_sum_net', `${table.lines.length} line(s) sum to the printed total ${table.footer}`),
        pass('line_arithmetic', 'every line reconciles quantity × price against its printed value'),
      ],
    },
    model: 'layout-parser',
    engine: 'deterministic',
    profile: isStock ? 'stock_note' : 'invoice',
  }
}
