/**
 * The checks of the daily PlusMinus → LGR import (`scripts/lib/daily-import.ts`): what the pulled documents say, and
 * what the importers' console output means for the next step. Every fixture here is made up.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  diffPulls, gateAuditAfter, gateAuditBefore, gateBooked, gateCompare, gateDry, gateHistory, gatePredict, gatePrices,
  gateSameDay, gateScan, newOutsideDay, numberGaps, parseInvoicesLog, parsePull, parseReceiptsLog, sameDay, scanDay,
  type Finding,
} from '../../../../scripts/lib/daily-import'

const scratch = mkdtempSync(join(tmpdir(), 'daily-import-test-'))
afterAll(() => { if (scratch.includes('daily-import-test-')) rmSync(scratch, { recursive: true, force: true }) })

function folder(name: string, files: Record<string, unknown>): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content))
  return dir
}
const STORE = 'ОБЕКТИ:СКЛАД - 9'
const line = (item: string, quantity: number, store = STORE, type = '1') => ({ item: `СТОКИ:${item}`, name: item, quantity: String(quantity), store, operations: [{ type, store, quantity: String(quantity) }] })
const doc = (docDate: string, lines: unknown[], header: Record<string, unknown> = {}) => ({ header: { docDate, sum: '10', partner: 'ПАРТНЬОРИ:ТЕСТ ДОСТАВЧИК', ...header }, lines })
const levels = (fs: Finding[]) => fs.map(f => f.level)
const texts = (fs: Finding[], level: Finding['level']) => fs.filter(f => f.level === level).map(f => f.text).join('\n')

describe('diffPulls: a store history against the previous pull', () => {
  const old = folder('hist-old', {
    'stokrazp_9001.json': doc('20260105', [line('БОЛТ ТЕСТ М8', 10), line('ГАЙКА ТЕСТ М8', 5)]),
    'stokrazp_9002.json': doc('20260105', [line('ШАЙБА ТЕСТ', 100)]),
    'invoicem_7001.json': doc('20260105', [line('БОЛТ ТЕСТ М8', 2, STORE, '2')]),
  })
  const now = folder('hist-new', {
    'stokrazp_9001.json': doc('20260105', [line('БОЛТ ТЕСТ М8', 10)]), // a line deleted in place
    'invoicem_7001.json': doc('20260105', [line('БОЛТ ТЕСТ М8', 2, STORE, '2')]),
    'invoicem_7002.json': doc('20260106', [line('ШАЙБА ТЕСТ', 1, STORE, '2')]), // the new day
    'stokrazp_9003.json': doc('20260104', [line('ГАЙКА ТЕСТ М8', 7)]), // created now, dated earlier
  })
  const dayDir = folder('day', { 'invoicem_7002.json': doc('20260106', []), 'storeAvailability_20260106.json': {} })
  const d = diffPulls([old], [now])

  it('names what was edited, what was deleted and what is new', () => {
    expect(d.compared).toBe(3)
    expect(d.same).toBe(1)
    expect(d.changed.map(c => c.file)).toEqual(['stokrazp_9001.json'])
    expect(d.changed[0].removed).toHaveLength(1)
    expect(d.onlyOld).toEqual(['stokrazp_9002.json'])
    expect(d.onlyNew.map(n => n.file).sort()).toEqual(['invoicem_7002.json', 'stokrazp_9003.json'])
  })

  it('finds the new document the day pull cannot see', () => {
    const outside = newOutsideDay(d, dayDir)
    expect(outside.backdated).toEqual([{ file: 'stokrazp_9003.json', date: '20260104' }])
    expect(outside.notNew).toEqual([])
    const gate = gateHistory(d, outside, '2026-01-06')
    expect(texts(gate, 'act')).toContain('EDITED')
    expect(texts(gate, 'act')).toContain('DELETED')
    expect(texts(gate, 'act')).toContain('dated OUTSIDE 2026-01-06')
  })

  it('says so when the new documents are exactly the day', () => {
    const quiet = diffPulls([folder('q-old', { 'invoicem_7001.json': doc('20260105', []) })], [folder('q-new', { 'invoicem_7001.json': doc('20260105', []), 'invoicem_7002.json': doc('20260106', []) })])
    const gate = gateHistory(quiet, newOutsideDay(quiet, dayDir), '2026-01-06')
    expect(levels(gate)).toEqual(['ok', 'ok'])
  })

  it('reads number gaps across every folder at once, not per folder', () => {
    const a = folder('gap-a', { 'sklrazp_101.json': doc('20260110', []), 'sklrazp_104.json': doc('20260131', []) })
    const b = folder('gap-b', { 'sklrazp_102.json': doc('20260201', []) }) // dated in another chunk than its neighbours
    expect(numberGaps([a, b])).toEqual([{ family: 'sklrazp', missing: [103] }])
  })
})

describe('sameDay: did PlusMinus move while the day was booked', () => {
  const snapshot = (quantity: number) => ({ [STORE]: { 'СТОКИ:БОЛТ ТЕСТ М8': { quantity } } })
  const first = folder('first', { 'invoicem_7002.json': doc('20260106', []), 'storeAvailability_20260106.json': snapshot(5) })

  it('passes when every file and every quantity is the same', () => {
    const after = folder('after-same', { 'invoicem_7002.json': doc('20260106', []), 'storeAvailability_20260106.json': snapshot(5) })
    expect(levels(gateSameDay(sameDay(first, after)))).toEqual(['ok'])
  })

  it('stops when a document appeared or a quantity moved', () => {
    const after = folder('after-moved', { 'invoicem_7002.json': doc('20260106', []), 'invoicem_7003.json': doc('20260106', []), 'storeAvailability_20260106.json': snapshot(4) })
    const s = sameDay(first, after)
    expect(s.onlyAfter).toEqual(['invoicem_7003.json'])
    expect(s.snapshot?.moved).toHaveLength(1)
    expect(levels(gateSameDay(s))).toEqual(['stop'])
  })
})

describe('scanDay: documents that moved no stock', () => {
  const dir = folder('scan', {
    'stokrazp_9010.json': doc('20260106', [line('БОЛТ ТЕСТ М8', 160, 'БЕЗСКЛАД')]),
    'stokrazp_9011.json': doc('20260106', [line('ГАЙКА ТЕСТ М8', 5), { ...line('ОПАКОВКА ТЕСТ', 1), item: 'МАТЕРИАЛИ:ОПАКОВКА ТЕСТ' }]),
    'invoicem_7010.json': doc('20260106', [line('БОЛТ ТЕСТ М8', 1, STORE, '2')]),
    'invoicem_7011.json': doc('20260106', [{ ...line('БОЛТ ТЕСТ М8', 1, 'БЕЗСКЛАД', '2'), fromDocument: 'СР:5001' }]),
    'invoicem_7012.json': doc('20260106', [line('БОЛТ ТЕСТ М8', 1, STORE, '2'), line('ГАЙКА ТЕСТ М8', 1, 'БЕЗСКЛАД', '2')]),
    'storeOperations_5001.json': doc('20260106', [line('БОЛТ ТЕСТ М8', 3, STORE, '2'), line('ШАЙБА ТЕСТ', -20, STORE, '2')], { doc: 'СР' }),
  })
  const s = scanDay(dir)

  it('finds a receipt on БЕЗСКЛАД, which the importer would receive', () => {
    expect(s.stock.filter(d => d.noStock).map(d => d.file)).toEqual(['stokrazp_9010.json'])
    const held = gateScan(s).find(f => f.level === 'act' && f.text.includes('БЕЗСКЛАД: PlusMinus moved no stock'))
    expect(held?.detail).toEqual(['stokrazp_9010.json: БЕЗСКЛАД'])
  })

  it('tells stock-moving invoices from till invoices and mixed ones', () => {
    expect(s.invoices.stockMoving).toEqual(['invoicem_7010.json'])
    expect(s.invoices.noStock).toEqual([{ file: 'invoicem_7011.json', from: ['СР:5001'] }])
    expect(s.invoices.mixed).toEqual(['invoicem_7012.json'])
  })

  it('counts a till return and names items outside the goods group', () => {
    expect(s.till.negative).toEqual([{ file: 'storeOperations_5001.json', item: 'СТОКИ:ШАЙБА ТЕСТ', quantity: -20 }])
    expect(s.stock.find(d => d.file === 'stokrazp_9011.json')?.otherGroups).toEqual(['МАТЕРИАЛИ'])
  })
})

describe('parsePull', () => {
  it('reads each family, a gap and the snapshot', () => {
    const p = parsePull(['invoicem    16  7001..7016', 'sklrazp     44  101..145  GAPS:120-120', 'sklisk       0', 'snapshot   2290 products, 693 at zero quantity', 'posReceipts       34 receipts on 1 day(s)'].join('\n'))
    expect(p.families).toEqual([
      { prefix: 'invoicem', count: 16, first: '7001', last: '7016', gaps: null },
      { prefix: 'sklrazp', count: 44, first: '101', last: '145', gaps: '120-120' },
      { prefix: 'sklisk', count: 0, first: null, last: null, gaps: null },
    ])
    expect(p.snapshot).toEqual({ products: 2290, zero: 693 })
    expect(p.pos).toEqual([{ kind: 'posReceipts', count: 34, days: 1 }])
  })
})

const RECEIPTS_DRY = `
── 9020 (2026-01-06) — ПАРТНЬОРИ:ТЕСТ ДОСТАВЧИК: 2 receipt line(s), 0 price-only line(s), 0 adjustment line(s) ──
    ⚠ supplier: no active supplier is named "ТЕСТ ДОСТАВЧИК", so the receipt names none
      + CREATE SKU-00010  "НОЖ ТЕСТ 150"  qty 2 pcs
      ~ REPRICE SKU-00002  "БОЛТ ТЕСТ М8"  delivery 0.1 (purchase kept), selling →0.2  + receive qty 10
    Planned: 1 to create, 1 to reprice + receive | 2 lines | Σqty 12 | Σcost 1.2 | → Склад
── 9021 (2026-01-06) — ПАРТНЬОРИ:2000 КОРЕКЦИЯ: 0 receipt line(s), 2 price-only line(s), 0 adjustment line(s) ──
      ! NO MATCH "НОЖ ТЕСТ 150": no product here, so a price-only line repriced nothing
      ! NO MATCH "НОЖ ТЕСТ 999": no product here, so a price-only line repriced nothing
    Planned: 0 to create, 0 to reprice | 0 lines | Σqty 0 | Σcost 0 | → Склад
── 9022 (2026-01-06): 1 receipt line(s), 0 price-only line(s), 3 adjustment line(s) ──
    ⚠ UNMATCHED 2 adjustment line(s) — NOT booked (stock stays too HIGH for these): ФИЛТЪР ТЕСТ 1"; ФИЛТЪР ТЕСТ 3/4"
    would book adjustment: 1 line(s), Σqty 4

Would process: 3 document(s), 0 failed
`

describe('the receipts dry run', () => {
  const log = parseReceiptsLog(RECEIPTS_DRY)
  const gate = gateDry('receipts', RECEIPTS_DRY, 0, false)

  it('reads each document block', () => {
    expect(log.docs.map(d => d.number)).toEqual(['9020', '9021', '9022'])
    expect(log.docs[0].creates).toEqual([{ sku: 'SKU-00010', name: 'НОЖ ТЕСТ 150' }])
    expect(log.docs[2].unmatched).toEqual(['ФИЛТЪР ТЕСТ 1"', 'ФИЛТЪР ТЕСТ 3/4"'])
    expect(log.processed).toEqual({ documents: 3, failed: 0, executed: false })
  })

  it('refuses a document with an outgoing line that matches no product', () => {
    expect(texts(gate, 'act')).toContain('9022: 2 outgoing line(s) match no product')
  })

  it('lets a price-only line wait for a product an earlier receipt creates, and flags one nothing creates', () => {
    expect(texts(gate, 'act')).toContain('9021: 1 price-only line(s) name a product that does not exist')
    expect(gate.find(f => f.text.startsWith('9021') && f.level === 'act')?.detail).toEqual(['НОЖ ТЕСТ 999'])
  })

  it('treats output it cannot read as a failed check', () => {
    expect(levels(gateDry('receipts', 'something else entirely', 0, false))).toEqual(['stop'])
    expect(levels(gateDry('receipts', RECEIPTS_DRY, 1, false))).toEqual(['stop'])
  })
})

describe('the dry reruns: nothing may be left to book', () => {
  const booked = `
── 9020 (2026-01-06): 2 receipt line(s), 0 price-only line(s), 1 adjustment line(s) ──
    Quantity already booked (SM-2026-00001) — will REFRESH PRICES only, no re-receive.
    = adjustment already booked: SM-2026-00002 — skip

Would process: 1 document(s), 0 failed
`
  it('passes when both halves of every document are booked', () => {
    expect(levels(gateDry('receipts', booked, 0, true))).toEqual(['ok'])
  })

  it('flags a receipt half or an outgoing half that is not', () => {
    const half = booked.replace('    = adjustment already booked: SM-2026-00002 — skip\n', '    would book adjustment: 1 line(s), Σqty 4\n')
    expect(texts(gateDry('receipts', half, 0, true), 'act')).toContain('its outgoing lines are NOT booked')
  })

  it('reads the other families the same way', () => {
    expect(levels(gateDry('transfers', 'Would book: 0 | skipped(dup): 2 | unmatched lines: 0', 0, true))).toEqual(['ok'])
    expect(levels(gateDry('transfers', 'Would book: 1 | skipped(dup): 1 | unmatched lines: 0', 0, true))).toEqual(['act'])
    expect(levels(gateDry('till', '── 2026-01-06: 3 till transaction(s) ──\nAlready imported: CS-2026-00001 (paid) — nothing to do.', 0, true))).toEqual(['ok'])
    expect(levels(gateDry('invoices', 'New to import: 0 | already issued/drafted: 5 | entered by hand: 0\nEligible for commit: 0/0 (pre-flight skipped: 0)', 0, true))).toEqual(['ok'])
    expect(texts(gateDry('invoices', 'New to import: 2 | already issued/drafted: 3 | entered by hand: 0', 0, true), 'act')).toContain('2 invoice(s) are NOT in LGR')
  })
})

describe('the till and the invoices', () => {
  it('flags till lines that would be free text', () => {
    const dry = '── 2026-01-06: 4 till transaction(s) ──\nItems: 5 | net total: 10 EUR | gross paid: 12 EUR\nMatched products: 4/5 | free-text: 1\n  ✗ unmatched: ФИЛТЪР ТЕСТ\nDRY RUN, nothing posted | 2026-01-06 | 5 lines | qty 9 | net 10 + VAT 2 = 12 EUR | stock: dispatch'
    expect(texts(gateDry('till', dry, 0, false), 'act')).toContain('1 line(s) match no product')
  })

  const analysis = [
    'Files found: 3 (7020 … 7022)',
    'New to import: 3 | already issued/drafted: 0 | entered by hand: 0',
    '  OK  7020 ТЕСТ КЛИЕНТ ЕООД                       2 lines  12.00 EUR   (new customer, created by --convert)',
    '  OK  7021 ТЕСТ КЛИЕНТ ЕООД                       1 lines  5.00 EUR   (NO PRODUCT on 1 line(s), so it will stay a DRAFT: "НОЖ ТЕСТ 150")',
    '  OK  7022 ДРУГ КЛИЕНТ ООД                        1 lines  3.00 EUR   ',
    '  moves no stock: 7022, its goods left on salesAnalysis:2026-01-06',
    'Eligible for commit: 3/3 (pre-flight skipped: 0)',
  ].join('\n')

  it('holds an invoice whose line has no product until the receipt that creates it is booked', () => {
    const i = parseInvoicesLog(analysis)
    expect(i.ok).toEqual(['7020', '7021', '7022'])
    expect(i.noProduct).toEqual(['7021'])
    expect(i.movesNoStock).toEqual(['7022'])
    expect(i.newCustomers).toBe(1)
    expect(texts(gateDry('invoices', analysis, 0, false), 'act')).toContain('would stay drafts')
  })

  it('counts dispatches against the invoices that move stock', () => {
    const run = `${analysis}\n  ✓ 7020 → INV-7020\n  ✓ 7021 → INV-7021\n  ✓ 7022 → INV-7022\nConverted: 3/3 | stock movements: 100 → 102 (+2)\n  ✓ 7022 (salesAnalysis:2026-01-06) attached to CS-2026-00001\nSALES_DOC counter: 7022 (max imported: 7022) OK`
    expect(levels(gateBooked('invoices', run, 0))).toEqual(['ok'])
    const short = run.replace('100 → 102 (+2)', '100 → 101 (+1)')
    expect(texts(gateBooked('invoices', short, 0), 'act')).toContain('1 stock movement(s) for 2 issued invoice(s)')
    const draft = run.replace('Converted: 3/3', 'Converted: 2/3').replace('  ✓ 7021 → INV-7021', '  ✗ 7021 → still a DRAFT: no product on a line')
    expect(texts(gateBooked('invoices', draft, 0), 'act')).toContain('were NOT issued')
  })
})

describe('stock: the comparison and the prediction', () => {
  const compare = (diffs: number, extra = '') => `Matched (exact name): 100 | missing in LGR: 2\nQty diffs on matched products (tol 0.001): ${diffs}\nAfter prefix/quote-mark reconciliation (fallback pass, not a primary match):\n  3 confirmed same stock under a different-looking name (not a real gap)\n${extra}  truly missing in LGR: 0 nonzero (+1 zero-qty)\n  truly LGR-only: 1 nonzero (+5 zero-qty)\n    SKU-00099 "СТАР ТЕСТ" qty=1\n`

  it('passes a clean comparison after booking and keeps a standing LGR-only article as a note', () => {
    expect(levels(gateCompare(compare(0), 'after'))).toEqual(['ok', 'note'])
  })

  it('asks for a named reason when differences are left', () => {
    expect(texts(gateCompare(compare(2), 'after'), 'act')).toContain('2 quantity difference(s)')
  })

  it('flags an article LGR holds under a different-looking name', () => {
    const named = compare(5, '  1 same item, DIFFERENT qty — investigate:\n    ~ "ФИЛТЪР ТЕСТ 1"" snapshot=0 vs LGR "ФИЛТЪР ТЕСТ 1" (SKU-00007)=6\n')
    const gate = gateCompare(named, 'before')
    expect(texts(gate, 'act')).toContain('different-looking name')
    expect(gate.find(f => f.level === 'act')?.detail?.[0]).toContain('SKU-00007')
  })

  it('reads the prediction: zero, a residual, and an outgoing line for a product LGR does not have', () => {
    const head = 'test-org: 12 documents/receipts | products whose stock the documents move: 9 (+2 articles LGR has no product for)\n'
    expect(levels(gatePredict(`${head}matched-product differences now: 9 | predicted after booking: 0\n`))).toEqual(['ok'])
    const residual = gatePredict(`${head}matched-product differences now: 9 | predicted after booking: 1\n  RESID SKU-00002 | БОЛТ ТЕСТ М8 | 5 | 6 | -1 | 0 | -1 | \n`)
    expect(levels(residual)).toEqual(['act'])
    const names = gatePredict(`${head}matched-product differences now: 9 | predicted after booking: 0\n  NEW   "филтър тест 1"" effect=-6 snapshot=0\n  NEW   "нож тест 150" effect=2 snapshot=2\n`)
    expect(levels(names)).toEqual(['ok', 'act', 'note'])
    expect(texts(names, 'act')).toContain('a name that differs')
  })
})

describe('the audit', () => {
  const audit = (post: number, missing: string) => [
    'PlusMinus 50 · as INV-<number> in LGR 40 · not under that number 10: 6 hand-entered in LGR under another number (matched by day+total), 0 still an unissued draft, 4 NO counterpart',
    '  MISSING 7001 2026-01-01 · 1 lines · ТЕСТ КЛИЕНТ',
    missing,
    `stokrazp  PlusMinus 30 (9001…9030) · booked 28 · unbooked 2: ${post} post-baseline, 1 pre-baseline, 1 price-only/empty · LGR markers with no document in range: 0`,
    post ? '  POST  9030 2026-01-06 · 1 lines · ТЕСТ ДОСТАВЧИК' : '',
    'trading days with a PlusMinus invoice 5 · LGR cash-sale days 4 · trading days WITHOUT a cash-sale document: 1 → 2026-01-01(Thu)',
    post ? '  POST stokrazp 9030 2026-01-06 ТЕСТ ДОСТАВЧИК           ALREADY:1' : '',
  ].join('\n')

  it('ignores the opening day and passes when nothing after the baseline is left out', () => {
    expect(levels(gateAuditAfter(audit(0, ''), '2026-01-01'))).toEqual(['ok'])
  })

  it('lists what is left out after the baseline', () => {
    const gate = gateAuditAfter(audit(1, '  MISSING 7030 2026-01-06 · 1 lines · ТЕСТ КЛИЕНТ'), '2026-01-01')
    expect(texts(gate, 'act')).toContain('1 invoice(s) dated after the baseline are not in LGR')
    expect(texts(gate, 'act')).toContain('1 receipt/transfer/write-off document(s) dated after the baseline are not booked')
  })

  it('keeps a guard verdict of ALREADY as a note before booking', () => {
    expect(texts(gateAuditBefore(audit(1, ''), '2026-01-01'), 'note')).toContain('already agrees with the snapshot without 1 unbooked document')
  })
})

describe('prices', () => {
  it('passes when every change is named, stops on a cost figure, asks about an unexplained change', () => {
    expect(levels(gatePrices('price-diff: changed 3 | unexplained 0 | protected 0 | created 1 | meta 0', 0))).toEqual(['ok'])
    expect(levels(gatePrices('  PROTECTED changed SKU-00002 БОЛТ ТЕСТ М8 purchase 1→2\nprice-diff: changed 1 | unexplained 0 | protected 1 | created 0 | meta 0', 0))).toEqual(['stop', 'ok'])
    expect(levels(gatePrices('  UNEXPLAINED SKU-00003 ГАЙКА ТЕСТ selling 1→2\nprice-diff: changed 1 | unexplained 1 | protected 0 | created 0 | meta 0', 0))).toEqual(['act', 'ok'])
    expect(levels(gatePrices('no summary line', 0))).toEqual(['stop'])
  })
})
