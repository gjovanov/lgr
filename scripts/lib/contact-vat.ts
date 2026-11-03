/**
 * A branch contact whose VAT number the books hold better. FR-25 R3: the sales register LGR derives names
 * a partner by the contact's VAT number, else its ЕИК, and the filed one by the VAT number the accountant
 * keyed. Where a store's card had no VAT number, or a malformed one (a stray letter, a missing one), the
 * import copied that, and the row differs.
 *
 * What it changes: a contact's `vatNumber`, to what the filed register names, only when
 *   - the filed partner is `BG` and the contact's own ЕИК, so it is the same company;
 *   - the contact holds no VAT number, or one that is no VAT number at all;
 *   - VIES says the number is valid. The books can be wrong too: a number VIES calls invalid is the
 *     accountant's to correct, not LGR's to copy.
 * Left alone and counted: a filed partner that is another number; a contact holding another well-formed VAT
 * number; VIES calling it invalid, or not answering.
 */
import { Contact, Invoice, VatRegisterEntry } from '../../packages/db/src/models/index.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import { booksBranches, compareSalesRegisterOf } from '../../packages/services/src/biz/vat-files/sales-register.service.js'

export type ViesAnswer = 'valid' | 'invalid' | 'unknown'
export type ViesCheck = (vatNumber: string) => Promise<ViesAnswer>

/** The EU's VIES service: is this VAT number registered in its member state, today. */
export const viesCheck: ViesCheck = async vatNumber => {
  const m = /^([A-Z]{2})([0-9A-Z]+)$/.exec(vatNumber)
  if (!m) return 'invalid'
  try {
    const res = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${m[1]}/vat/${m[2]}`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return 'unknown'
    const body: any = await res.json()
    if (body?.isValid === true) return 'valid'
    return body?.isValid === false && body?.userError === 'INVALID' ? 'invalid' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface ContactVatPlan {
  orgId: string
  branch: string
  id: string
  name: string
  /** What was read, which the write is conditional on. */
  before: string | null
  vatNumber: string
  /** The filed rows that name it. */
  rows: number
}

const REGISTER_TYPES = ['invoice', 'credit_note', 'debit_note']
const VAT_NUMBER = /^[A-Z]{2}[0-9A-Z]{2,13}$/
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const compact = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toUpperCase()

/** Every filed row of `periods` whose partner differs from LGR's, against its contact. Reads only, VIES aside. */
export async function planContactVatFromRegister(booksOrgId: unknown, periods: string[], vies: ViesCheck = viesCheck) {
  const counts: Record<string, number> = {}
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }
  const { branches } = await booksBranches(booksOrgId)
  const plans = new Map<string, ContactVatPlan>()
  const verdicts = new Map<string, ViesAnswer>()
  for (const period of periods) {
    const gate = await compareSalesRegisterOf(booksOrgId, period)
    for (const d of gate.details) {
      if (!/differs in .*partner/.test(d.outcome)) continue
      bump('filed rows whose partner differs')
      const code = d.outcome.split(' ')[0]
      const branch = branches.find(b => b.code === code)
      const [docTypeCode, number] = d.key.split(':')
      const ten = number.padStart(10, '0')
      const filed: any = await VatRegisterEntry.findOne({ orgId: booksOrgId, ledger: 'books', side: 'sales', period, docTypeCode, docNumber: { $in: [ten, number] } }).select('partnerVat').lean()
      const inv: any = branch && await Invoice.findOne({ orgId: branch.orgId, direction: 'outgoing', type: { $in: REGISTER_TYPES }, invoiceNumber: { $regex: `${ten}$` } }).select('contactId').lean()
      const c: any = inv?.contactId && await Contact.findOne({ _id: inv.contactId, orgId: branch!.orgId }).select('companyName taxId taxNumber vatNumber').lean()
      if (!filed || !c) { bump('left: the row\'s document or contact is not found'); continue }

      const filedVat = compact(filed.partnerVat)
      const eik = digits(c.taxId) || digits(c.taxNumber)
      if (!/^BG\d{9}(\d{4})?$/.test(filedVat) || filedVat.slice(2) !== eik) { bump('left: the books name another number than the contact\'s own ЕИК'); continue }
      const held = compact(c.vatNumber)
      if (held === filedVat) { bump('left: the contact holds that VAT number already'); continue }
      if (held && VAT_NUMBER.test(held)) { bump('left: the contact holds another VAT number'); continue }

      const id = String(c._id)
      const planned = plans.get(id)
      if (planned) { planned.rows++; bump('to set: another row of a contact already planned'); continue }
      if (!verdicts.has(filedVat)) verdicts.set(filedVat, await vies(filedVat))
      const verdict = verdicts.get(filedVat)
      if (verdict !== 'valid') { bump(verdict === 'invalid' ? 'left: VIES says the number the books filed is not valid' : 'left: VIES did not answer'); continue }
      plans.set(id, { orgId: String(branch!.orgId), branch: code, id, name: c.companyName ?? '', before: c.vatNumber ?? null, vatNumber: filedVat, rows: 1 })
      bump('to set: the VAT number VIES confirms')
    }
  }
  return { plans: [...plans.values()], counts }
}

/** Write one contact's VAT number, if it still holds what the plan read. One AuditLog row. */
export async function applyContactVatFromRegister(plan: ContactVatPlan, by: unknown, reason: string): Promise<boolean> {
  const held = plan.before ? { vatNumber: plan.before } : { $or: [{ vatNumber: { $exists: false } }, { vatNumber: null }, { vatNumber: '' }] }
  const res = await Contact.updateOne({ _id: plan.id, orgId: plan.orgId, ...held }, { $set: { vatNumber: plan.vatNumber } }).exec()
  if (res.modifiedCount !== 1) return false
  const audited = await recordAuditEntry({
    orgId: plan.orgId, userId: String(by), action: 'update', module: 'invoicing', entityType: 'contact', entityId: plan.id, entityName: plan.name,
    changes: [{ field: 'vatNumber', oldValue: plan.before, newValue: plan.vatNumber }, { field: 'reason', oldValue: null, newValue: reason }],
  })
  // A correction of master data is not done until its audit row is: a failed one stops the run.
  if (!audited) throw new Error(`the audit row for contact ${plan.id} was not written; the change itself was`)
  return true
}
