import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import type { Types } from 'mongoose'
import { AuditLog, Contact, DocFile, Invoice } from 'db/models'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { applyContactVat, applyPrintedTotals, planContactVat, planPrintedTotals } from '../../../../scripts/lib/printed-totals'

/**
 * #485's repair, on made-up documents: an imported invoice stored with its lines' rounded VAT gets the VAT and
 * sum due its PDF prints, and nothing else; a paid one moves its payment with it; what the repair cannot
 * prove safe is left alone and counted.
 */

/** A text row with cells at fixed columns, the layout `pdftotext -layout` gives the reader. */
function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) out = out.padEnd(at, ' ') + text
  return out
}

/** A фактура whose two lines of 0.33 print VAT 0.13 (on the base), where the lines' own rounded VAT sums to 0.14. */
const pdf = (number: string, customerVat = 'BG999000191', customerEik = '999000191') => [
  row([70, 'ФАКТУРА'], [100, 'Номер:']),
  row([102, 'Дата:']),
  row([110, number]),
  row([110, '15.09.2026']),
  row([0, 'ПОЛУЧАТЕЛ'], [17, 'ТЕСТ КЛИЕНТ ООД'], [77, 'ДОСТАВЧИК'], [95, 'ТЕСТ ДОСТАВЧИК ООД']),
  row([0, 'ЕИК'], [17, customerEik], [77, 'ЕИК'], [95, '123456786']),
  row([0, 'ИН по ДДС'], [17, customerVat], [77, 'ИН по ДДС'], [95, 'BG123456786']),
  row([4, 'No'], [33, 'Име'], [66, 'Мяр'], [78, 'Кол'], [92, 'Цена'], [106, 'ТО'], [117, 'Стойност']),
  row([0, '1'], [13, 'ТЕСТ ВИНТ 4.2Х16'], [66, 'БР'], [80, '1'], [92, '0.33'], [124, '0.33']),
  row([0, '2'], [13, 'ТЕСТ ВИНТ 4.2Х19'], [66, 'БР'], [80, '1'], [92, '0.33'], [124, '0.33']),
  row([0, 'Словом : тест'], [80, 'Данъчна основа'], [120, '0.66 €']),
  row([80, 'ДДС ( 20 % )'], [120, '0.13 €']),
  row([80, 'Сума за плащане'], [120, '0.79 €']),
].join('\n')

const line = { description: 'ТЕСТ', quantity: 1, unit: 'pcs', unitPrice: 0.33, discount: 0, taxRate: 20, taxAmount: 0.07, lineTotal: 0.4 }
const asStored = { subtotal: 0.66, discountTotal: 0, taxTotal: 0.14, total: 0.8, totalBase: 0.8 }

let org: any, user: any, contact: any
const ids: Record<string, Types.ObjectId> = {}

async function imported(key: string, number: string, over: Record<string, unknown>, text = pdf(number)) {
  const inv: any = await createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-${number}`, lines: [line, line], ...asStored, ...over } as any)
  await DocFile.create({
    orgId: org._id, docType: 'invoice', docNumber: number, docDate: '2026-09-15', status: 'committed', committedTarget: 'invoice',
    committedIds: [inv._id], extractedText: text, originalName: `invoicem_${number}.pdf`, currentPath: '/dev/null',
    currentChecksum: number, mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
  })
  ids[key] = inv._id
}

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg()
  user = await createTestUser(org._id)
  contact = await createTestContact(org._id, { companyName: 'ТЕСТ КЛИЕНТ ООД', taxId: '999000191', vatNumber: undefined } as any)
  const payment = (amount: number, extra: Record<string, unknown> = {}) => ({ date: new Date('2026-09-15'), amount, method: 'cash', origin: 'cash_on_issue', ...extra })
  await imported('unpaid', '3000700101', { status: 'sent', amountPaid: 0, amountDue: 0.8, payments: [] })
  await imported('paid', '3000700102', { status: 'paid', amountPaid: 0.8, amountDue: 0, payments: [payment(0.8, { tendered: 0.8 })] })
  await imported('paidChange', '3000700103', { status: 'paid', amountPaid: 0.8, amountDue: 0, payments: [payment(0.8, { tendered: 5 })] })
  await imported('till', '3000700104', { status: 'paid', amountPaid: 0.8, amountDue: 0, payments: [payment(0.8, { origin: 'cash_register' })] })
  await imported('edited', '3000700105', { status: 'sent', subtotal: 0.7, taxTotal: 0.14, total: 0.84, totalBase: 0.84, amountPaid: 0, amountDue: 0.84, payments: [] })
  await imported('right', '3000700106', { status: 'sent', taxTotal: 0.13, total: 0.79, totalBase: 0.79, amountPaid: 0, amountDue: 0.79, payments: [] })
})

afterAll(async () => {
  await teardownTestDB()
})

describe('#485 repair — the printed VAT and sum due, back on the stored invoice', () => {
  it('plans only what it can prove safe, and counts the rest by reason', async () => {
    const { plans, counts } = await planPrintedTotals(org._id)
    expect(plans.map(p => [p.invoiceNumber, p.category]).sort()).toEqual([
      ['INV-3000700101', 'unpaid'], ['INV-3000700102', 'paid_on_issue'], ['INV-3000700103', 'paid_on_issue'],
    ])
    expect(counts).toEqual({
      'committed invoice PDFs': 6,
      'to repair: unpaid': 1,
      'to repair: paid on issue': 2,
      'left: paid, cash_register': 1,
      'left: the PDF and the invoice hold different bases (edited, or a re-export)': 1,
      'equal to the print already': 1,
    })
  })

  it('refuses to write over a document that changed since the plan', async () => {
    const { plans } = await planPrintedTotals(org._id)
    const unpaid = plans.find(p => p.category === 'unpaid')!
    await Invoice.updateOne({ _id: ids.unpaid }, { $set: { amountDue: 0.5 } })
    expect(await applyPrintedTotals(org._id, unpaid, user._id, 'test')).toBe(false)
    expect((await Invoice.findById(ids.unpaid).lean() as any).taxTotal).toBe(0.14)
    await Invoice.updateOne({ _id: ids.unpaid }, { $set: { amountDue: 0.8 } })
  })

  it('writes the print, moves a paid invoice\'s payment with it, audits each, and then has nothing left to do', async () => {
    const { plans } = await planPrintedTotals(org._id)
    for (const p of plans) expect(await applyPrintedTotals(org._id, p, user._id, 'printed VAT (#485)')).toBe(true)

    const unpaid: any = await Invoice.findById(ids.unpaid).lean()
    expect([unpaid.taxTotal, unpaid.total, unpaid.totalBase, unpaid.amountDue, unpaid.amountPaid]).toEqual([0.13, 0.79, 0.79, 0.79, 0])
    const paid: any = await Invoice.findById(ids.paid).lean()
    expect([paid.taxTotal, paid.total, paid.amountPaid, paid.amountDue, paid.payments[0].amount, paid.payments[0].tendered]).toEqual([0.13, 0.79, 0.79, 0, 0.79, 0.79])
    // The customer handed over 5.00: what was tendered stays what was tendered.
    const change: any = await Invoice.findById(ids.paidChange).lean()
    expect([change.total, change.payments[0].amount, change.payments[0].tendered]).toEqual([0.79, 0.79, 5])
    // Lines, base and what was left alone are untouched.
    expect(paid.lines.map((l: any) => l.taxAmount)).toEqual([0.07, 0.07])
    expect(paid.subtotal).toBe(0.66)
    expect((await Invoice.findById(ids.till).lean() as any).total).toBe(0.8)
    expect((await Invoice.findById(ids.edited).lean() as any).total).toBe(0.84)

    const audit: any = await AuditLog.findOne({ orgId: org._id, entityType: 'invoice', entityId: ids.paid }).lean()
    expect(audit.changes.map(({ field, oldValue, newValue }: any) => ({ field, oldValue, newValue }))).toEqual(expect.arrayContaining([
      { field: 'taxTotal', oldValue: 0.14, newValue: 0.13 },
      { field: 'total', oldValue: 0.8, newValue: 0.79 },
      { field: 'payments.0.amount', oldValue: 0.8, newValue: 0.79 },
    ]))
    expect(String(audit.userId)).toBe(String(user._id))

    const again = await planPrintedTotals(org._id)
    expect(again.plans).toEqual([])
    expect(again.counts['equal to the print already']).toBe(4)
  })

  it('gives a contact the VAT number its own invoices print, once', async () => {
    const plans = await planContactVat(org._id)
    expect(plans).toEqual([{ id: String(contact._id), name: 'ТЕСТ КЛИЕНТ ООД', vatNumber: 'BG999000191', invoices: 6 }])
    expect(await applyContactVat(org._id, plans[0], user._id, 'test')).toBe(true)
    const after: any = await Contact.findById(contact._id).lean()
    expect(after.vatNumber).toBe('BG999000191')
    expect(after.vatNumberLower).toBe('bg999000191')
    expect(await planContactVat(org._id)).toEqual([])
    expect(await applyContactVat(org._id, plans[0], user._id, 'test')).toBe(false)
  })

  it('leaves a contact alone when its invoices print more than one VAT number', async () => {
    const other: any = await createTestContact(org._id, { companyName: 'ДРУГ', taxId: '123456786', vatNumber: undefined } as any)
    for (const [n, vat] of [['3000700201', 'BG123456786'], ['3000700202', 'BG999999999']] as const) {
      const inv: any = await createTestInvoice(org._id, other._id, { invoiceNumber: `INV-${n}`, lines: [line, line], ...asStored, status: 'sent', amountDue: 0.8 } as any)
      await DocFile.create({
        orgId: org._id, docType: 'invoice', docNumber: n, docDate: '2026-09-15', status: 'committed', committedTarget: 'invoice',
        committedIds: [inv._id], extractedText: pdf(n, vat, '123456786'), originalName: `invoicem_${n}.pdf`,
        currentPath: '/dev/null', currentChecksum: n, mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
      })
    }
    expect((await planContactVat(org._id)).map(p => p.id)).not.toContain(String(other._id))
  })
})
