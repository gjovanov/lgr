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
import type { DocKind, DocumentExtraction, DraftResult, ExtractedLineItem, ValidationCheck } from './types.js'
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
}
export interface ParsedTable {
  lines: ParsedTableLine[]
  footer: number | null
  columns: string[]
  ok: boolean
  reason?: string
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
  const head = tokens(lines[h])
  if (head.length < 4) return null

  let bodyEnd = lines.length
  for (let i = h + 1; i < lines.length; i++) if (FOOTER.test(lines[i])) { bodyEnd = i; break }

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
  const qtyIdx = cols.findIndex(c => /Кол/.test(c.label))
  let e = h + 1
  while (e < lines.length && e < bodyEnd && e <= h + 5) {
    if (!lines[e].trim()) { e++; continue }
    if (nameIdx >= 0 && lines[e].slice(cols[nameIdx].start, cols[nameIdx].end).trim()) break
    if (qtyIdx >= 0 && /[0-9]/.test(lines[e].slice(cols[qtyIdx].start, cols[qtyIdx].end))) break
    for (const t of tokens(lines[e])) {
      const c = cols.find(c => t.start >= c.start && t.start < c.end)
      if (c) c.label += t.text
    }
    e++
  }
  return { cols, headerEnd: e, bodyEnd }
}

// ── the item table ──────────────────────────────────────────────────────────────────────

function parsePage(text: string): ParsedTable {
  const lines = text.split('\n')
  const found = findColumns(lines)
  if (!found) return { lines: [], footer: null, columns: [], ok: false, reason: 'no header row' }
  const { cols, headerEnd, bodyEnd } = found
  const labels = cols.map(c => canonical(c.label))
  const at = (re: RegExp) => labels.findIndex(l => re.test(l))
  const iName = at(/Име/), iUnit = at(/^Мяр|^М$|^Мя/), iQty = at(/Кол/), iVal = at(/Стойност/)
  const priceCols = labels.map((l, i) => ({ i, label: l })).filter(x => /^Цена/.test(x.label))
  if (iName < 0 || iQty < 0 || iVal < 0) return { lines: [], footer: null, columns: labels, ok: false, reason: 'missing Име/Кол/Стойност' }

  const cell = (line: string, i: number) => (i < 0 ? '' : line.slice(cols[i].start, cols[i].end).trim())

  type Row = { name: string[]; unit: string; qty: string; val: string; prices: Record<string, string>; n: number }
  const blank = (): Row => ({ name: [], unit: '', qty: '', val: '', prices: {}, n: 0 })
  const read = (r: Row) => ({ qty: num(r.qty), total: num(r.val), printed: num(r.prices['Цена'] || '') })

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
    const dp = decimals(r.prices['Цена'] || '')
    if (dp >= 3) {
      // The printed price is itself rounded, and that error is multiplied by the quantity: at
      // 4 dp a half-ulp is 0.00005, so 3000 units carry 0.15 of legitimate slack — which is
      // exactly how a document comes to print 64.00 for 3000 x 0.0213 (= 63.90).
      const slack = 0.02 + Math.abs(total) * 0.001 + Math.abs(qty) * (5 * Math.pow(10, -dp - 1))
      return Math.abs(Math.abs(qty * printed) - Math.abs(total)) <= slack
    }
    if (qty === 0) return false
    return Math.abs(Math.abs(total / qty) - Math.abs(printed)) <= 0.0051
  }

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
  let expect = 1
  if (iNo >= 0) {
    let acc = '', from = -1
    for (let i = headerEnd; i < bodyEnd; i++) {
      const c = cell(lines[i], iNo)
      if (!/^[0-9]{1,3}$/.test(c)) continue
      if (!acc) from = i
      acc += c
      if (acc === String(expect)) { openers.add(from); expect++; acc = ''; from = -1 }
      else if (!String(expect).startsWith(acc)) {
        acc = c === String(expect) ? '' : c
        from = i
        if (!acc) { openers.add(i); expect++; from = -1 }
      }
    }
  }
  // Row 1 alone is enough. A one-line invoice has no row 2 to confirm the pattern with, and that
  // is exactly the document where the arithmetic delimiter fails: the single row reconciles on its
  // first physical line, so a wrapped name is closed out into a row of its own.
  const numbered = expect >= 2

  const rows: Row[] = []
  let cur: Row | null = null
  for (let i = headerEnd; i < bodyEnd; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const name = cell(line, iName)
    const starts = numbered ? openers.has(i) : (!!name && reconciles(cur))
    if (cur && starts) { rows.push(cur); cur = null }
    if (!cur) cur = blank()
    if (name) cur.name.push(name)
    cur.unit += cell(line, iUnit)
    cur.qty += cell(line, iQty)
    cur.val += cell(line, iVal)
    for (const p of priceCols) cur.prices[p.label] = (cur.prices[p.label] || '') + cell(line, p.i)
    if (++cur.n > 6) { rows.push(cur); cur = null }   // runaway guard: never swallow the table
  }
  if (cur) rows.push(cur)

  let footer: number | null = null
  for (const l of lines.slice(bodyEnd)) {
    const m = l.match(/(?:Крайна\s+сума|Данъчна\s+основа)\s+(-?[\d\s.,]+)/)
    if (m) { const v = num(m[1]); if (v !== null) { footer = v; break } }
  }

  let out: ParsedTableLine[] = []
  for (const r of rows) {
    const description = r.name.join(' ').replace(/\s+/g, ' ').trim()
    if (!description) continue
    const { qty, total, printed } = read(r)
    const prices: Record<string, number> = {}
    for (const p of priceCols) { const v = num(r.prices[p.label] || ''); if (v !== null && v !== 0) prices[p.label] = v }
    const exact = qty !== null && qty !== 0 && total !== null ? +(total / qty).toFixed(6) : null
    const printedIsExact = decimals(r.prices['Цена'] || '') >= 3
    out.push({
      description,
      quantity: qty,
      unit: r.unit.replace(/[^А-Яа-яA-Za-z]/g, '') || null,
      unitPrice: printedIsExact ? printed : (exact ?? printed),
      printedPrice: printed,
      total,
      prices,
      ok: reconciles(r),
    })
  }

  const sum = out.reduce((s, l) => s + (l.total ?? 0), 0)
  const footerOk = footer !== null && Math.abs(sum - footer) <= 0.05
  const bad = out.filter(l => !l.ok)
  return {
    lines: out, footer, columns: labels,
    ok: out.length > 0 && bad.length === 0 && footerOk,
    reason: !out.length ? 'no lines' : bad.length ? `${bad.length} line(s) do not reconcile` : !footerOk ? `lines sum to ${sum.toFixed(2)}, document prints ${footer}` : undefined,
  }
}

/**
 * A multi-page export repeats its header on every page — with DIFFERENT column positions each
 * time — so geometry is derived per page and the item lists concatenated. Only the last page
 * carries the total.
 */
export function parseTable(text: string): ParsedTable {
  const pages = text.split('\f').filter(p => /Име/.test(p) && /Кол/.test(p))
  if (pages.length <= 1) return parsePage(text)
  const parts = pages.map(parsePage)
  const lines = parts.flatMap(p => p.lines)
  const footer = parts.map(p => p.footer).filter(v => v !== null).pop() ?? null
  const sum = lines.reduce((s, l) => s + (l.total ?? 0), 0)
  const footerOk = footer !== null && Math.abs(sum - footer) <= 0.05
  const bad = lines.filter(l => !l.ok)
  return {
    lines, footer, columns: parts[0]?.columns ?? [],
    ok: lines.length > 0 && bad.length === 0 && footerOk,
    reason: !lines.length ? 'no lines' : bad.length ? `${bad.length} line(s) do not reconcile` : !footerOk ? `lines sum to ${sum.toFixed(2)}, document prints ${footer}` : undefined,
  }
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
  const parties = isStock ? { customer: {}, supplier: {} } : parseInvoiceParties(text)

  const extraction: DocumentExtraction = {
    document_number: number ?? null,
    issue_date: rawDate ? bgDateToIso(rawDate) ?? null : null,
    currency: /€/.test(text) ? 'EUR' : null,
    supplier: isStock ? { name: after(text, /Доставчик\s*:?\s*(.+)/) ?? null } : parties.supplier,
    customer: isStock ? {} : parties.customer,
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
