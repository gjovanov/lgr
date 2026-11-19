import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mongoose } from 'db/connection'
import { AuditLog, DocFile, Invoice } from 'db/models'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestJournalEntry, createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import {
  SCRIPT, applyCashSaleVat, manifestOf, parseManifest, planCashSaleVat, undoCashSaleVat,
} from '../../../../scripts/lib/cash-sale-invoice-vat'
import { manifestText } from '../../../../scripts/lib/repair-run'

/**
 * FR-25 R3: an invoice issued for a cash sale, imported before the PDF reader took the printed VAT, gets the VAT and sum
 * due its PDF prints, and its one mirrored till payment moves with the total (`scripts/repair-cash-sale-invoice-vat.ts`).
 * Made-up documents only.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

/** A text row with cells at fixed columns, the layout `pdftotext -layout` gives the reader. */
function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) out = out.padEnd(at, ' ') + text
  return out
}

/** A фактура whose two lines of 0.33 print VAT 0.13 (on the base), where the lines' own rounded VAT sums to 0.14. */
const pdf = (number: string) => [
  row([70, 'ФАКТУРА'], [100, 'Номер:']),
  row([102, 'Дата:']),
  row([110, number]),
  row([110, '15.10.2026']),
  row([0, 'ПОЛУЧАТЕЛ'], [17, 'ТЕСТ КЛИЕНТ ООД'], [77, 'ДОСТАВЧИК'], [95, 'ТЕСТ ДОСТАВЧИК ООД']),
  row([0, 'ЕИК'], [17, '999000191'], [77, 'ЕИК'], [95, '123456786']),
  row([0, 'ИН по ДДС'], [17, 'BG999000191'], [77, 'ИН по ДДС'], [95, 'BG123456786']),
  row([4, 'No'], [33, 'Име'], [66, 'Мяр'], [78, 'Кол'], [92, 'Цена'], [106, 'ТО'], [117, 'Стойност']),
  row([0, '1'], [13, 'ТЕСТ ВИНТ 4.2Х16'], [66, 'БР'], [80, '1'], [92, '0.33'], [124, '0.33']),
  row([0, '2'], [13, 'ТЕСТ ВИНТ 4.2Х19'], [66, 'БР'], [80, '1'], [92, '0.33'], [124, '0.33']),
  row([0, 'Словом : тест'], [80, 'Данъчна основа'], [120, '0.66 €']),
  row([80, 'ДДС ( 20 % )'], [120, '0.13 €']),
  row([80, 'Сума за плащане'], [120, '0.79 €']),
].join('\n')

const line = { description: 'ТЕСТ', quantity: 1, unit: 'pcs', unitPrice: 0.33, discount: 0, taxRate: 20, taxAmount: 0.07, lineTotal: 0.4 }
const asStored = { subtotal: 0.66, discountTotal: 0, taxTotal: 0.14, total: 0.8, totalBase: 0.8 }

let org: any, user: any, contact: any, sale: any
const ids: Record<string, any> = {}
const read = async (key: string) => (await Invoice.findById(ids[key]).lean().exec()) as any

/** The payment `cash-sale-invoice.service.ts#mirroredPayments` writes: the cash sale's money, on the tax document. */
const mirrored = (amount: number) => ({ date: new Date('2026-10-15'), amount, method: 'cash', origin: 'cash_register', reference: sale.invoiceNumber })

async function imported(key: string, number: string, over: Record<string, unknown>) {
  const inv: any = await createTestInvoice(org._id, contact._id, {
    invoiceNumber: `INV-${number}`, lines: [line, line], ...asStored, status: 'paid', amountPaid: 0.8, amountDue: 0, payments: [mirrored(0.8)],
    cashSaleRef: { cashSaleId: sale._id, number: sale.invoiceNumber, issueDate: new Date('2026-10-15') },
    ...over,
  } as any)
  await DocFile.create({
    orgId: org._id, docType: 'invoice', docNumber: number, docDate: '2026-10-15', status: 'committed', committedTarget: 'invoice',
    committedIds: [inv._id], extractedText: pdf(number), originalName: `invoicem_${number}.pdf`, currentPath: '/dev/null',
    currentChecksum: number, mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
  })
  ids[key] = inv._id
}

async function world() {
  await Promise.all([Invoice, DocFile, AuditLog].map((M: any) => M.deleteMany({ orgId: org._id }).exec()))
  sale = await createTestInvoice(org._id, contact._id, { invoiceNumber: 'CS-2026-00001', type: 'cash_sale', status: 'paid', ...asStored, amountPaid: 0.8, amountDue: 0 } as any)
  await imported('attached', '3000700201', {})
  await imported('attached2', '3000700202', {})
  await imported('notForASale', '3000700203', { cashSaleRef: undefined, payments: [{ ...mirrored(0.8), origin: 'cash_on_issue', reference: undefined }] })
  await imported('posted', '3000700204', {})
  await createTestJournalEntry(org._id, new mongoose.Types.ObjectId(), user._id, { sourceModule: 'invoicing', sourceId: ids.posted } as any)
  await imported('right', '3000700205', { taxTotal: 0.13, total: 0.79, totalBase: 0.79, amountPaid: 0.79, payments: [mirrored(0.79)] })
  await imported('held', '3000700206', { receiptHolds: [{ receiptId: new mongoose.Types.ObjectId(), amount: 0.8 }] })
  await imported('twoPayments', '3000700207', { payments: [mirrored(0.5), mirrored(0.3)] })
}

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg({ name: 'Касова фактура', slug: 'cash-sale-vat-test' } as any)
  user = await createTestUser(org._id)
  contact = await createTestContact(org._id, { companyName: 'ТЕСТ КЛИЕНТ ООД', taxId: '999000191', vatNumber: 'BG999000191' } as any)
  await world()
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('the dry run', () => {
  it('plans the invoices issued for a cash sale whose one mirrored payment moves with the total, and counts the rest', async () => {
    const survey = await planCashSaleVat(String(org._id))
    expect(survey.plans.map(p => p.invoiceNumber).sort()).toEqual(['INV-3000700201', 'INV-3000700202'])
    expect(survey.plans[0].before).toEqual({ taxTotal: 0.14, total: 0.8, totalBase: 0.8, amountPaid: 0.8, payment: 0.8 })
    expect(survey.plans[0].after).toEqual({ taxTotal: 0.13, total: 0.79, totalBase: 0.79, amountPaid: 0.79, payment: 0.79 })
    expect(survey.counts).toEqual({
      'committed invoice PDFs': 7,
      'to repair: the VAT and sum due it prints, its mirrored payment with them': 2,
      'left: not issued for a cash sale (repair-printed-invoice-totals.ts takes those)': 1,
      'left: it has a journal entry of its own': 1,
      'equal to the print already': 1,
      'left: held by a payment receipt': 1,
      'left: paid, cash_register+cash_register: not one mirrored payment of the whole total': 1,
    })
  })

  it('writes nothing', async () => {
    expect((await read('attached')).taxTotal).toBe(0.14)
    expect(await AuditLog.countDocuments({ via: SCRIPT })).toBe(0)
  })
})

describe('the run', () => {
  it('puts the printed VAT and sum due on the invoice, moves its payment with them, and leaves one audit row', async () => {
    const survey = await planCashSaleVat(String(org._id))
    const result = await applyCashSaleVat(survey)
    expect(result).toEqual({ repaired: 2, failed: [] })
    const inv = await read('attached')
    expect(inv).toMatchObject({ taxTotal: 0.13, total: 0.79, totalBase: 0.79, amountPaid: 0.79, amountDue: 0, subtotal: 0.66, status: 'paid' })
    expect(inv.payments.map((p: any) => [p.amount, p.origin, p.reference])).toEqual([[0.79, 'cash_register', 'CS-2026-00001']])
    // The lines, and what the run had no business with, are as they were.
    expect(inv.lines.map((l: any) => l.taxAmount)).toEqual([0.07, 0.07])
    expect((await read('posted')).taxTotal).toBe(0.14)
    expect((await Invoice.findById(sale._id).lean().exec() as any).total).toBe(0.8)
    const audit: any[] = await AuditLog.find({ orgId: org._id, via: SCRIPT }).lean()
    expect(audit).toHaveLength(1)
    expect(String(audit[0].entityId)).toBe(String(org._id))
    expect(audit[0].changes.map((c: any) => [c.field, c.newValue])).toEqual([['invoices', 2]])
  })

  it('a second run finds nothing to repair', async () => {
    expect((await planCashSaleVat(String(org._id))).plans).toEqual([])
  })

  it('an invoice changed since the dry run, or posted since, is left alone and reported', async () => {
    await world()
    const survey = await planCashSaleVat(String(org._id))
    await Invoice.updateOne({ _id: ids.attached }, { $set: { 'payments.0.amount': 0.7, amountPaid: 0.7, amountDue: 0.1, status: 'partially_paid' } }).exec()
    await createTestJournalEntry(org._id, new mongoose.Types.ObjectId(), user._id, { sourceModule: 'invoicing', sourceId: ids.attached2 } as any)
    const result = await applyCashSaleVat(survey)
    expect(result.repaired).toBe(0)
    expect(result.failed).toHaveLength(2)
    expect((await read('attached')).taxTotal).toBe(0.14)
    expect((await read('attached2')).taxTotal).toBe(0.14)
    expect(await AuditLog.countDocuments({ orgId: org._id, via: SCRIPT })).toBe(0)
  })
})

describe('undo', () => {
  it('gives the invoices their figures back where nothing changed since, and refuses another org\'s manifest', async () => {
    await world()
    const survey = await planCashSaleVat(String(org._id))
    const manifest = parseManifest(manifestText(manifestOf(survey, 'cash-sale-vat-test')), String(org._id))
    expect(manifest.invoices.map(i => i.after.taxTotal)).toEqual([0.13, 0.13])
    await applyCashSaleVat(survey)
    // A person edits one afterwards: the undo leaves it as they set it.
    await Invoice.updateOne({ _id: ids.attached2 }, { $set: { taxTotal: 0.12 } }).exec()
    expect(await undoCashSaleVat(manifest, false)).toEqual({ invoices: 2, back: 1, changed: 1 })
    expect((await read('attached')).taxTotal).toBe(0.13)
    expect(await undoCashSaleVat(manifest, true)).toEqual({ invoices: 2, back: 1, changed: 1 })
    expect(await read('attached')).toMatchObject({ taxTotal: 0.14, total: 0.8, totalBase: 0.8, amountPaid: 0.8 })
    expect((await read('attached')).payments[0].amount).toBe(0.8)
    expect((await read('attached2')).taxTotal).toBe(0.12)
    expect(await AuditLog.countDocuments({ orgId: org._id, via: SCRIPT })).toBe(2)

    const text = manifestText(manifest)
    expect((await captureRejection(Promise.resolve().then(() => parseManifest(text, String(new mongoose.Types.ObjectId()))))).code).toBe('other_org')
    expect((await captureRejection(Promise.resolve().then(() => parseManifest('{"a":1}', String(org._id))))).code).toBe('not_a_manifest')
  })
})

describe('the script', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'repair-cash-sale-invoice-vat.ts'), ...args], {
      cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  it('a dry run of counts, --expect, a manifest outside the checkout, and --undo', async () => {
    await world()
    // The script builds no index and refuses to write without the unique ones: the app (here, the test) builds them.
    await Promise.all([Invoice, AuditLog].map(M => M.init()))
    const dir = mkdtempSync(join(tmpdir(), 'repair-cash-sale-invoice-vat-test-'))
    try {
      const dry = await cli('--org', 'cash-sale-vat-test')
      expect(dry.code).toBe(0)
      expect(dry.out).toContain('Re-run with --execute --expect 2.')
      // Counts only: no document number, name or amount.
      for (const private_ of ['3000700201', 'ТЕСТ КЛИЕНТ', '0.79', '0.13']) expect(dry.out).not.toContain(private_)

      expect((await cli('--org', 'cash-sale-vat-test', '--execute')).code).toBe(2)
      expect((await cli('--org', 'cash-sale-vat-test', '--execute', '--expect', '3', '--out', dir)).code).toBe(2)
      expect((await read('attached')).taxTotal).toBe(0.14)

      const run = await cli('--org', 'cash-sale-vat-test', '--execute', '--expect', '2', '--out', dir)
      expect(run.code).toBe(0)
      expect(run.out).toContain('Repaired: 2 of 2 invoices')
      expect((await read('attached')).taxTotal).toBe(0.13)
      const [file] = readdirSync(dir)
      expect(file).toMatch(/^repair-cash-sale-invoice-vat-cash-sale-vat-test-.+\.json$/)
      expect(readFileSync(join(dir, file), 'utf8')).toContain(String(ids.attached))

      expect((await cli('--org', 'cash-sale-vat-test')).out).toContain('Re-run with --execute --expect 0.')
      const undoDry = await cli('--org', 'cash-sale-vat-test', '--undo', join(dir, file))
      expect(undoDry.code).toBe(0)
      expect(undoDry.out).toContain('to give their figures back')
      expect((await read('attached')).taxTotal).toBe(0.13)
      expect((await cli('--org', 'cash-sale-vat-test', '--undo', join(dir, file), '--execute')).code).toBe(0)
      expect((await read('attached')).taxTotal).toBe(0.14)

      const refused = await cli('--org', 'cash-sale-vat-test-missing')
      expect(refused.code).toBe(2)
      expect(refused.out).toContain('Refused (not_found)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(existsSync(dir)).toBe(false)
  }, 120_000)
})
