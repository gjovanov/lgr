import { createHash } from 'node:crypto'
import type { ClientSession } from 'mongoose'
import { mongoose } from 'db/connection'
import { Org, TaxReturn, User, VatRegisterEntry, type ITaxReturnDeclarant, type ITaxReturnFile } from 'db/models'
import { createAuditEntry } from '../audit-log.service.js'
import { uploadFile } from '../file.service.js'
import type { VatRow } from './codec.js'
import { DECLARED_CELLS, type VatSide } from './layouts.js'
import { compareFiledMonth, generateMonthFiles, readFiledMonth, type VatFile, type VatMonth } from './month.js'
import { deklarCells, isVatPeriod, numberRows, periodBounds, viesRequired, withRowTotals, type DeclaredCells } from './rules.js'

/**
 * A VAT return's life (FR-25 §3.8, §7.1): rows go in, `generate` produces the files, a person files
 * them, and LGR records who, when and the acknowledgement. **LGR never submits anything** (D7), and
 * holds no credential for the NRA's portal.
 *
 * Rows renumber and regenerate while the return is open, and freeze at `filed`.
 *
 * ⚠ A VAT file is never stored: its bytes are regenerated from the rows on every download, and refused
 * unless they equal the `sha256` recorded when they were generated or imported. The rows are the
 * record, the gate (`scripts/compare-vat-files.ts`) proves the path byte for byte, and the import runs
 * from wherever the private files are, which is not where a `File`'s bytes live. A layout that changes
 * one day has to keep regenerating the months before it, or this refuses instead of serving other bytes.
 */

const OPEN_STATUSES = ['draft', 'generated']
const BOOKS = 'books'

/** A refusal that is an answer, with the HTTP status it answers with. */
export class VatReturnRefused extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: string, message: string, readonly fields?: string[]) {
    super(message)
    this.name = 'VatReturnRefused'
  }
}

/** What `generate` may be told, beside the rows. */
export interface VatGenerateInput {
  orgId: string
  userId: string
  period: string
  filer?: string
  vies?: NonNullable<ITaxReturnDeclarant['vies']>
  declared?: DeclaredCells
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const describeFiles = (files: VatFile[]): ITaxReturnFile[] => files.map(f => ({ name: f.name, sha256: sha256(f.bytes), bytes: f.bytes.length }))
const digits = (value?: string) => (value ?? '').replace(/\D/g, '')

function assertPeriod(period: string): void {
  if (!isVatPeriod(period)) throw new VatReturnRefused(422, 'vat_period_invalid', 'A VAT period is YYYYMM')
}

/** The period's return. A superseded one is history. */
const returnOf = (orgId: string, period: string) =>
  TaxReturn.findOne({ orgId, kind: 'vat', periodCode: period, status: { $ne: 'corrected' } })

/**
 * The person filing (00-04) is named by their ЕГН or ЛНЧ in practice: every filed month on prod was.
 * A name stays, as names do; an identifier answers as its last four digits.
 */
const maskedFiler = (filer?: string) => (filer && /^\d{10}$/.test(filer.trim()) ? `••••••${filer.trim().slice(-4)}` : filer)

/** A return as an API answers it: the VIES declarant's and the filer's ЕГН go in the file, and in no JSON. */
export function withoutPersonalId<T>(ret: T): T {
  const r = ret as any
  if (!r?.declarant) return ret
  const { id: _id, ...vies } = r.declarant.vies ?? {}
  return { ...r, declarant: { ...r.declarant, filer: maskedFiler(r.declarant.filer), ...(r.declarant.vies ? { vies } : {}) } }
}

function toRow(doc: any): VatRow {
  return {
    rowNo: doc.rowNo, docTypeCode: doc.docTypeCode, docNumber: doc.docNumber ?? '', docDate: doc.docDate,
    partnerVat: doc.partnerVat ?? '', partnerName: doc.partnerName ?? '', description: doc.description ?? '',
    ...(typeof doc.branch === 'number' ? { branch: doc.branch } : {}), code: doc.code ?? '', cells: doc.cells ?? {},
  }
}

async function rowDocs(orgId: string, period: string, session?: ClientSession) {
  const docs = await VatRegisterEntry.find({ orgId, period, ledger: BOOKS })
    .sort({ rowNo: 1, docDate: 1, docNumber: 1 })
    .session(session ?? null)
    .lean()
  return { sales: docs.filter(d => d.side === 'sales'), purchases: docs.filter(d => d.side === 'purchase') }
}

function declaredIn(cells: Record<string, number> | undefined): DeclaredCells {
  const declared: DeclaredCells = {}
  for (const code of DECLARED_CELLS) if (cells?.[code]) declared[code] = cells[code]
  return declared
}

function monthOf(period: string, declarant: ITaxReturnDeclarant, declared: DeclaredCells, sales: VatRow[], purchases: VatRow[]): VatMonth {
  const v = declarant.vies
  return {
    vatId: declarant.vatId, name: declarant.name, filer: declarant.filer, period, declared, sales, purchases,
    ...(v?.name ? {
      vies: {
        declarant: { id: v.id ?? '', name: v.name, city: v.city, postcode: v.postcode, address: v.address, kind: v.kind },
        companyAddress: v.companyAddress,
      },
    } : {}),
  }
}

/** The cells every return shares with a hand-made one, in the document's currency units. */
function totalsOf(cells: Record<string, number>) {
  const units = (code: string) => (cells[code] ?? 0) / 100
  return { totalTax: units('01-20'), totalOutput: units('01-20'), totalInput: units('01-40'), netPayable: units('01-50') - units('01-60') }
}

/** The period's bytes, as they stand now. */
async function regenerate(ret: any, session?: ClientSession): Promise<VatFile[]> {
  const { sales, purchases } = await rowDocs(String(ret.orgId), ret.periodCode, session)
  return generateMonthFiles(monthOf(ret.periodCode, ret.declarant, declaredIn(ret.cells), sales.map(toRow), purchases.map(toRow)))
}

const sameFiles = (a: ITaxReturnFile[] = [], b: ITaxReturnFile[] = []) =>
  a.length === b.length && a.every(f => b.some(r => r.name === f.name && r.sha256 === f.sha256))

function staleRefusal(): VatReturnRefused {
  return new VatReturnRefused(409, 'vat_return_stale', 'The rows have changed since these files were generated. Generate them again.')
}

/** What is known of who the return names: this period's, the last return's, the org's, then what was asked. */
async function resolveDeclarant(input: VatGenerateInput, current: any, needsVies: boolean, session: ClientSession): Promise<ITaxReturnDeclarant> {
  const last: any = current?.declarant?.filer ? current : await TaxReturn.findOne({ orgId: input.orgId, kind: 'vat', 'declarant.filer': { $type: 'string' } })
    .sort({ periodCode: -1 }).session(session).lean()
  const lastVies: any = last?.declarant?.vies?.name ? last : await TaxReturn.findOne({ orgId: input.orgId, kind: 'vat', 'declarant.vies.name': { $type: 'string' } })
    .sort({ periodCode: -1 }).session(session).lean()
  const org = await Org.findById(input.orgId).select('name vatNumber').session(session).lean()
  const vies = input.vies ?? lastVies?.declarant?.vies
  const declarant: ITaxReturnDeclarant = {
    vatId: last?.declarant?.vatId ?? org?.vatNumber ?? '',
    name: last?.declarant?.name ?? org?.name ?? '',
    filer: input.filer ?? last?.declarant?.filer ?? '',
    ...(vies?.name ? { vies } : {}),
  }
  const missing = (['vatId', 'name', 'filer'] as const).filter(f => !declarant[f])
  if (needsVies) {
    for (const f of ['id', 'name', 'city', 'postcode', 'address', 'kind', 'companyAddress'] as const) {
      if (!vies?.[f]) missing.push(`vies.${f}` as any)
    }
  }
  if (missing.length) throw new VatReturnRefused(422, 'vat_declarant_missing', 'The return does not say who files it.', missing)
  return declarant
}

/**
 * Number the rows, compute the return and produce its files. Open returns only: a filed one is
 * frozen, and a correction is a return of its own (`supersedesId`). With no rows it is a nil return,
 * which is due all the same (ЗДДС чл. 125(5)).
 */
export async function generateVatReturn(input: VatGenerateInput) {
  const { orgId, userId, period } = input
  assertPeriod(period)
  const session = await mongoose.startSession()
  let id = ''
  try {
    await session.withTransaction(async () => {
      const current: any = await returnOf(orgId, period).session(session).lean()
      if (current && !OPEN_STATUSES.includes(current.status)) {
        throw new VatReturnRefused(409, 'vat_return_frozen', 'This return is filed, and a filed return does not change.')
      }
      const docs = await rowDocs(orgId, period, session)
      const number = (rows: any[]) => numberRows(rows.map(d => ({ ...toRow(d), _id: d._id })))
      const sales = number(docs.sales).map(r => ({ ...r, cells: withRowTotals(r.cells) }))
      const purchases = number(docs.purchases)

      const declarant = await resolveDeclarant(input, current, viesRequired(sales), session)
      const declared = { ...declaredIn(current?.cells), ...input.declared }
      const files = generateMonthFiles(monthOf(period, declarant, declared, sales, purchases))

      const ops = [...sales, ...purchases].map(r => ({ updateOne: { filter: { _id: r._id, orgId }, update: { $set: { rowNo: r.rowNo, cells: r.cells } } } }))
      if (ops.length) await VatRegisterEntry.bulkWrite(ops, { session })

      const cells = deklarCells(sales, purchases, declared)
      const fields = {
        status: 'generated', source: 'generated', cells, declarant, files: describeFiles(files),
        rowCounts: { sales: sales.length, purchase: purchases.length }, ...totalsOf(cells),
      }
      if (current) {
        const saved = await TaxReturn.findOneAndUpdate({ _id: current._id, orgId, status: { $in: OPEN_STATUSES } }, { $set: fields }, { session, new: true }).lean()
        if (!saved) throw new VatReturnRefused(409, 'vat_return_frozen', 'This return was filed meanwhile.')
        id = String(saved._id)
      } else {
        const [created] = await TaxReturn.create([{ orgId, type: 'vat', kind: 'vat', periodCode: period, period: periodBounds(period), ...fields }], { session })
        id = String(created._id)
      }
    })
  } catch (e: any) {
    // Two people generating the same new month: one return, and the other one says so.
    if (e?.code === 11000) throw new VatReturnRefused(409, 'vat_return_busy', 'This return was generated by someone else just now.')
    throw e
  } finally {
    await session.endSession()
  }
  createAuditEntry({ orgId, userId, action: 'generate', module: 'accounting', entityType: 'tax_return', entityId: id, entityName: `VAT ${period}` })
  return withoutPersonalId(await TaxReturn.findById(id).lean())
}

/** The checks of `mark-filed`, on what the transaction will read again. Before an acknowledgement is stored. */
function assertFilable(ret: any): void {
  if (!ret) throw new VatReturnRefused(404, 'vat_return_missing', 'There is no return for this period.')
  if (ret.status !== 'generated') throw new VatReturnRefused(409, 'vat_return_not_generated', 'Only a generated return can be marked as filed.')
}

/**
 * A person says they filed it. The return freezes with its rows, in one transaction, and only if the
 * files they took are still what the rows produce.
 */
export async function markVatReturnFiled(input: {
  orgId: string
  userId: string
  period: string
  ackNumber: string
  ackFile?: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }
}) {
  const { orgId, userId, period, ackNumber, ackFile } = input
  assertPeriod(period)
  assertFilable(await returnOf(orgId, period).lean())
  const fileId = ackFile ? String((await uploadFile(orgId, userId, 'accounting', ackFile))._id) : undefined

  const session = await mongoose.startSession()
  let id = ''
  try {
    await session.withTransaction(async () => {
      const current: any = await returnOf(orgId, period).session(session).lean()
      assertFilable(current)
      if (!sameFiles(describeFiles(await regenerate(current, session)), current.files)) throw staleRefusal()
      const saved = await TaxReturn.findOneAndUpdate(
        { _id: current._id, orgId, status: 'generated' },
        { $set: { status: 'filed', filedAt: new Date(), filedBy: userId, ack: { number: ackNumber, ...(fileId ? { fileId } : {}) } } },
        { session, new: true },
      ).lean()
      if (!saved) throw new VatReturnRefused(409, 'vat_return_not_generated', 'Only a generated return can be marked as filed.')
      await VatRegisterEntry.updateMany({ orgId, period, ledger: BOOKS }, { $set: { frozen: true } }, { session })
      id = String(saved._id)
    })
  } finally {
    await session.endSession()
  }
  createAuditEntry({
    orgId, userId, action: 'file', module: 'accounting', entityType: 'tax_return', entityId: id, entityName: `VAT ${period}`,
    changes: [{ field: 'status', oldValue: 'generated', newValue: 'filed' }, { field: 'ack.number', oldValue: null, newValue: ackNumber }],
  })
  return withoutPersonalId(await TaxReturn.findById(id).lean())
}

/** One of the period's files, regenerated and proven against what was recorded. */
export async function vatReturnFile(orgId: string, period: string, name: string): Promise<VatFile> {
  assertPeriod(period)
  const ret: any = await returnOf(orgId, period).lean()
  const recorded = ret?.files?.some((f: ITaxReturnFile) => f.name === name)
  if (!recorded) throw new VatReturnRefused(404, 'vat_file_missing', 'This return has no such file.')
  const files = await regenerate(ret)
  if (!sameFiles(describeFiles(files), ret.files)) throw staleRefusal()
  return files.find(f => f.name === name)!
}

/** What the screen shows of a period: its return if it has one, and the rows waiting for it. */
export async function vatPeriodSummary(orgId: string, period: string) {
  assertPeriod(period)
  const [taxReturn, sales, purchases] = await Promise.all([
    TaxReturn.findOne({ orgId, kind: 'vat', periodCode: period, status: { $ne: 'corrected' } }).lean(),
    VatRegisterEntry.countDocuments({ orgId, period, ledger: BOOKS, side: 'sales' }),
    VatRegisterEntry.countDocuments({ orgId, period, ledger: BOOKS, side: 'purchase' }),
  ])
  const filer = taxReturn?.filedBy ? await User.findOne({ _id: taxReturn.filedBy, orgId }).select('firstName lastName').lean() : null
  return { taxReturn: withoutPersonalId(taxReturn), counts: { sales, purchase: purchases }, filedByName: filer ? `${filer.firstName} ${filer.lastName}`.trim() : '' }
}

export interface VatImportPlan {
  period: string
  action: 'new' | 'unchanged' | 'replace'
  sales: number
  purchases: number
  month: VatMonth
  files: ITaxReturnFile[]
  existingId?: unknown
}

/**
 * What importing a filed month would do, writing nothing. ⚠ It refuses a month that does not
 * regenerate byte for byte: rows that cannot reproduce what was filed must not become the record.
 * It refuses another company's files too, since the accountant's PC holds other companies' books.
 */
export async function planVatImport(org: { _id: unknown; vatNumber?: string; taxNumber?: string }, filed: VatFile[]): Promise<VatImportPlan> {
  const month = readFiledMonth(filed)
  assertPeriod(month.period)
  const own = [digits(org.vatNumber), digits(org.taxNumber)].filter(Boolean)
  if (!own.length) throw new VatReturnRefused(422, 'vat_org_unidentified', 'This org has no VAT or tax number to check the files against.')
  if (!own.includes(digits(month.vatId))) throw new VatReturnRefused(422, 'vat_files_foreign', 'These files name another company.')

  const differing = compareFiledMonth(filed).filter(c => c.differing)
  if (differing.length) {
    throw new VatReturnRefused(422, 'vat_files_differ', `Regenerating does not reach the filed bytes: ${differing.map(c => `${c.name} ${c.only ? `only ${c.only}` : `${c.differing} records`}`).join(', ')}`)
  }
  const files = describeFiles(generateMonthFiles(month))
  const existing: any = await TaxReturn.findOne({ orgId: org._id, kind: 'vat', periodCode: month.period, status: { $ne: 'corrected' } }).lean()
  const base = { period: month.period, sales: month.sales.length, purchases: month.purchases.length, month, files }
  if (!existing) return { ...base, action: 'new' }
  if (sameFiles(existing.files, files)) return { ...base, action: 'unchanged', existingId: existing._id }
  // A month LGR generated and a person filed has an acknowledgement behind it: not for a file copy to overwrite.
  if (existing.source !== 'imported' && !OPEN_STATUSES.includes(existing.status)) {
    throw new VatReturnRefused(409, 'vat_return_filed_here', 'This period was filed from LGR, and these files differ from it.')
  }
  return { ...base, action: 'replace', existingId: existing._id }
}

/** Writes one planned month, as filed, in one transaction: its rows frozen, its return `filed`. */
export async function applyVatImport(orgId: string, plan: VatImportPlan): Promise<void> {
  if (plan.action === 'unchanged') return
  const { month, period } = plan
  const sales = numberRows(month.sales).map(r => ({ ...r, cells: withRowTotals(r.cells) }))
  const purchases = numberRows(month.purchases)
  const entry = (side: VatSide) => (row: VatRow) => ({
    orgId, period, side, ledger: BOOKS, frozen: true, rowNo: row.rowNo, docTypeCode: row.docTypeCode, docNumber: row.docNumber, docDate: row.docDate,
    ...(row.partnerVat ? { partnerVat: row.partnerVat } : {}), ...(row.partnerName ? { partnerName: row.partnerName } : {}),
    ...(row.description ? { description: row.description } : {}), ...(row.branch !== undefined ? { branch: row.branch } : {}),
    ...(row.code ? { code: row.code } : {}), cells: row.cells,
  })
  const cells = deklarCells(sales, purchases, month.declared)
  const v = month.vies
  const declarant: ITaxReturnDeclarant = {
    vatId: month.vatId, name: month.name, filer: month.filer,
    ...(v ? { vies: { ...v.declarant, companyAddress: v.companyAddress } } : {}),
  }
  const fields = {
    status: 'filed', source: 'imported', cells, declarant, files: plan.files,
    rowCounts: { sales: sales.length, purchase: purchases.length }, ...totalsOf(cells),
  }
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      await VatRegisterEntry.deleteMany({ orgId, period, ledger: BOOKS }, { session })
      await VatRegisterEntry.insertMany([...sales.map(entry('sales')), ...purchases.map(entry('purchase'))], { session })
      if (plan.action === 'replace') {
        await TaxReturn.updateOne({ _id: plan.existingId, orgId }, { $set: fields }, { session })
      } else {
        await TaxReturn.create([{ orgId, type: 'vat', kind: 'vat', periodCode: period, period: periodBounds(period), ...fields }], { session })
      }
    })
  } finally {
    await session.endSession()
  }
}
