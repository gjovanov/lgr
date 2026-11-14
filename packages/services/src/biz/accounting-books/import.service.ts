/**
 * FR-25 §5: a legal entity's books, from PlusMinus's exports into its books org, exactly as booked.
 * The steps in order: chart, analytics, opening, the journal a month at a time, and `finish`.
 *
 * Every step answers with what it would change, and writes only on `dryRun: false`.
 *
 * ⚠ What must not be "tidied" here (FR-25 §1.4):
 * - A correction is a NEGATIVE amount on the same side. Swapping sides gives other turnover columns.
 * - An amount keeps every decimal the file has: 702's cost is a share of a moving average, and only
 *   the base amount rounds. So `debit` is never rounded, and the file's totals still add up.
 * - The month is replaced, never merged, because the file has no row key. But an entry that survives
 *   keeps its `_id` and its number: the books move into the store orgs later (FR-25 D1), and ids are
 *   never reissued.
 * - `contactId` goes on a line wherever its analytic links to a Contact. The balance sheet splits an
 *   account that runs on both sides by it: without it 411 nets a customer who owes against one who
 *   has paid in advance, and the sheet still balances.
 *
 * FR-25 R7, a split (`settings.accounting.books.split`): each org of the group is sent the same files
 * and keeps its share. A store keeps the sales documents of its series; the home keeps everything else,
 * the opening included. Every org keeps the whole chart and the whole analytic tree, and a store makes
 * a partner's Contact only when one of its own entries names the partner.
 */
import { mongoose } from 'db/connection'
import { hasRepresentative } from 'config/contact-representative'
import {
  Account,
  AccountingAnalytic,
  BOOKS_IMPORT,
  BankAccount,
  Contact,
  FiscalPeriod,
  FiscalYear,
  FixedAsset,
  JournalEntry,
  Org,
  type AnalyticKind,
  type IJournalEntryLine,
} from 'db/models'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry } from '../audit-log.service.js'
import { ensureFiscalPeriod } from '../accounting.service.js'
import { reserveNumbers } from '../sequence.service.js'
import { fiscalRangeFilter } from '../../utils/fiscal-range.js'
import { closingOfYear, rebuildBalances } from './books-ledger.js'
import {
  BANK_ACCOUNT_FOREIGN,
  BANK_ACCOUNT_LOCAL,
  ENTRY_NUMBER_PREFIX,
  accountShapeOf,
  analyticRootDef,
  ancestorsOfPath,
  baseAmount,
  chartJunkReason,
  docTypeDef,
  exchangeRateOf,
  ledgerCurrencyOn,
  lowerBg,
  nameOfPath,
  rootOfPath,
} from './registry.js'
import { importHashOf, pathsOf, planMonth, settlesOfOperation, sha256, type PlannedEntry } from './journal-plan.js'
import { ContactIndex } from './contact-match.js'
import type {
  AnalyticsAnswer,
  AnalyticsBody,
  ChartAnswer,
  ChartBody,
  FinishAnswer,
  ImportDocument,
  JournalAnswer,
  JournalBody,
  LedgerCurrency,
  MonthDiff,
  OpeningAnalyticLine,
  OpeningAnswer,
  OpeningBody,
  SplitRole,
} from './import.types.js'
import { itemOfRow, type AnalyticItem } from './plusminus-exports.js'

export class BooksImportError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message)
    this.name = 'BooksImportError'
  }
}

export interface Importer {
  id: string
  operatorCode?: string
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** Only `dryRun: false` writes: a request that forgot the flag changes nothing. */
const isDryRun = (body: { dryRun?: boolean }) => body.dryRun !== false

const eikOf = (taxNumber: string | undefined) => String(taxNumber ?? '').replace(/^BG/i, '').trim()

interface BooksOrg {
  id: string
  branches: { orgId: string; docSeries?: string[] }[]
  /** FR-25 R7: the books are split over a group, and this org keeps its share. */
  split?: { homeOrgId: string; role: SplitRole }
}

/**
 * The books org, and proof the file is about it. The accountant's PC holds other companies' books, and
 * their exports look the same (FR-25 §1.1). An org that is not a books org runs none of this (§11).
 */
async function booksOrg(orgId: string, eik: string): Promise<BooksOrg> {
  const org: any = await Org.findById(orgId, { taxNumber: 1, 'settings.accounting.books': 1 }).lean()
  if (!org) throw new BooksImportError(404, 'not_found', 'Not found')
  const books = org.settings?.accounting?.books
  if (books?.mode !== 'books') throw new BooksImportError(409, 'not_a_books_org', 'This organisation keeps no imported books: link it first (scripts/link-books.ts).')
  if (!eikOf(org.taxNumber) || eikOf(eik) !== eikOf(org.taxNumber)) {
    throw new BooksImportError(422, 'other_company', 'This file belongs to another company than this organisation.')
  }
  const id = String(org._id)
  const home = books.split?.homeOrgId ? String(books.split.homeOrgId) : undefined
  return {
    id,
    branches: (books.branches ?? []).map((b: any) => ({ orgId: String(b.orgId), docSeries: b.docSeries })),
    ...(home ? { split: { homeOrgId: home, role: home === id ? 'home' as const : 'member' as const } } : {}),
  }
}

async function audit(orgId: string, by: Importer, what: string, changes: Record<string, unknown>): Promise<void> {
  await recordAuditEntry({
    orgId,
    userId: by.id,
    operatorCode: by.operatorCode,
    action: 'import',
    module: 'accounting',
    entityType: 'accounting_import',
    entityId: orgId,
    entityName: what,
    changes: Object.entries(changes).map(([field, newValue]) => ({ field, oldValue: null, newValue })),
  })
}

// ── The chart (§5.1) ────────────────────────────────────────────────────────────────────────────

export async function importChart(orgId: string, body: ChartBody, by: Importer): Promise<ChartAnswer> {
  const org = await booksOrg(orgId, body.eik)
  const dryRun = isDryRun(body)

  const junk: ChartAnswer['junk'] = []
  const wanted = new Map<string, string>()
  for (const { code, name } of body.accounts) {
    const reason = chartJunkReason(code, name)
    if (reason) junk.push({ code, reason })
    else wanted.set(code, name.trim())
  }

  const stored = new Map((await Account.find({ orgId: org.id }, { code: 1, name: 1 }).lean()).map((a: any) => [a.code as string, a]))
  const ops: any[] = []
  let created = 0
  let updated = 0
  let unchanged = 0
  for (const [code, name] of wanted) {
    const account: any = stored.get(code)
    if (!account) {
      created++
      ops.push({ insertOne: { document: { orgId: oid(org.id), code, name, ...accountShapeOf(code), isActive: true, balance: 0 } } })
    } else if (account.name !== name) {
      updated++
      ops.push({ updateOne: { filter: { _id: account._id, orgId: oid(org.id) }, update: { $set: { name } } } })
    } else {
      unchanged++
    }
  }

  if (!dryRun && ops.length) {
    await Account.bulkWrite(ops)
    await audit(org.id, by, 'chart', { created, updated })
  }
  return { dryRun, created, updated, unchanged, junk }
}

// ── The analytics (§5.2) ────────────────────────────────────────────────────────────────────────

interface StoredAnalytic {
  id: mongoose.Types.ObjectId
  contactId?: string
  unit?: string
}

type AnalyticMap = Map<string, StoredAnalytic>

async function storedAnalytics(orgId: string): Promise<AnalyticMap> {
  const rows: any[] = await AccountingAnalytic.find({ orgId }, { path: 1, contactId: 1, unit: 1 }).lean()
  return new Map(rows.map(a => [a.path, { id: a._id, ...(a.contactId ? { contactId: String(a.contactId) } : {}), ...(a.unit ? { unit: a.unit } : {}) }]))
}

const CONTACT_TYPE: Partial<Record<AnalyticKind, 'customer' | 'supplier' | 'both'>> = { customer: 'customer', supplier: 'supplier', partner: 'both' }

const kindOfPath = (path: string): AnalyticKind => analyticRootDef(rootOfPath(path))?.kind ?? 'other'

function newContact(orgId: string, type: string, item: AnalyticItem) {
  const companyName = item.path.slice(item.path.indexOf(':') + 1).trim()
  const street = item.address || item.city
  return {
    orgId: oid(orgId),
    type,
    companyName,
    ...(item.taxId ? { taxId: item.taxId, taxNumber: item.taxId } : {}),
    ...(item.vatNumber ? { vatNumber: item.vatNumber } : {}),
    ...(item.phone ? { phone: item.phone } : {}),
    // FR-25a: the МОЛ has a field of its own; it was a notes line, `МОЛ: <name>`, before.
    ...(item.contactPerson ? { representative: item.contactPerson } : {}),
    ...(street ? { addresses: [{ type: 'billing', street, ...(item.city ? { city: item.city } : {}), country: 'BG', isDefault: true }] } : {}),
  }
}

/**
 * How a partner with no Contact is treated (FR-25 R7). A books org of its own makes one for every
 * partner it meets (`create`), and finds one only of the partner's own type, by its key as written. A
 * store keeping a share (`split`) finds a partner with a number by any number a contact holds, of any
 * type (`contact-match.ts`); at analytics time it only links (`create: false`), and makes a partner's
 * Contact when one of its own entries names it.
 */
interface ContactPolicy {
  create: boolean
  split: boolean
}

const OWN_BOOKS: ContactPolicy = { create: true, split: false }

/** What a partner's analytic keeps of the file (`params`), read the way the file is: its Contact's numbers. */
async function itemsKept(orgId: string, paths: string[]): Promise<Map<string, AnalyticItem>> {
  if (!paths.length) return new Map()
  const rows: any[] = await AccountingAnalytic.find({ orgId, path: { $in: paths } }, { path: 1, params: 1 }).lean()
  return new Map(rows.map(a => [a.path as string, itemOfRow(a.path, a.params ?? [])]))
}

/**
 * Every path, with what is above it, in the tree. Returns what it created. A partner gets a Contact
 * by the same keys as the seed skills, name included: `contactId` on a line is what tells a debtor
 * from a customer who paid in advance, and a person with no ЕИК has a balance like anyone else.
 */
async function ensureAnalytics(
  orgId: string,
  items: ReadonlyMap<string, AnalyticItem | undefined>,
  known: AnalyticMap,
  dryRun: boolean,
  policy: ContactPolicy = OWN_BOOKS,
) {
  const paths = new Set<string>()
  for (const path of items.keys()) {
    for (const p of [...ancestorsOfPath(path), path]) if (!known.has(p)) paths.add(p)
  }
  const missing = [...paths]
  const byRoot: Record<string, number> = {}
  for (const path of missing) byRoot[rootOfPath(path)] = (byRoot[rootOfPath(path)] ?? 0) + 1

  const contacts: AnalyticsAnswer['contacts'] = { created: 0, linked: 0, withoutIdentifier: 0, ...(policy.create ? {} : { deferred: 0 }) }
  // A root on its own is no one: only a path under it, booked on or listed, is a partner.
  const partners = [...items.entries()]
    .filter(([path]) => path.includes(':') && !!CONTACT_TYPE[kindOfPath(path)] && !known.get(path)?.contactId)
    .map(([path, item]) => ({ path, item, type: CONTACT_TYPE[kindOfPath(path)]! }))

  const contactIds = new Map<string, mongoose.Types.ObjectId>()
  if (partners.length) {
    const held = new ContactIndex<mongoose.Types.ObjectId>(policy.split)
    // A split finds a partner by any number a contact holds, the oldest first (`contact-match.ts`).
    const rows: any[] = await Contact.find({ orgId }, { type: 1, taxId: 1, taxNumber: 1, vatNumber: 1, companyName: 1, createdAt: 1 }).lean()
    for (const c of rows) held.add(c._id, { ...c, createdAt: c.createdAt ?? c._id.getTimestamp() })
    // A store's partner met by the journal is made from what its analytic keeps of the file (R7).
    const kept = policy.split ? await itemsKept(orgId, partners.filter(p => !p.item && known.has(p.path)).map(p => p.path)) : new Map<string, AnalyticItem>()

    const fresh: any[] = []
    for (const { path, item: given, type } of partners) {
      const item = given ?? kept.get(path) ?? { path }
      const contact = newContact(orgId, type, item)
      if (!item.taxId && !item.vatNumber) contacts.withoutIdentifier++
      const match = held.find(contact)
      if (match) {
        contacts.linked++
        contactIds.set(path, match)
        continue
      }
      if (!policy.create) {
        contacts.deferred!++
        continue
      }
      contacts.created++
      const _id = new mongoose.Types.ObjectId()
      held.add(_id, contact)
      contactIds.set(path, _id)
      fresh.push({ _id, ...contact })
    }
    if (!dryRun && fresh.length) await Contact.insertMany(fresh)
  }

  // An analytic that was there without a partner gets one. In a dry run too, in memory: the hashes
  // it answers with must be the ones the real run would compare.
  const links = [...contactIds].filter(([path]) => known.has(path))
  if (!dryRun && links.length) {
    await AccountingAnalytic.bulkWrite(links.map(([path, contactId]) => ({
      updateOne: { filter: { _id: known.get(path)!.id, orgId: oid(orgId) }, update: { $set: { contactId } } },
    })))
  }
  for (const [path, contactId] of links) known.get(path)!.contactId = String(contactId)

  if (dryRun) return { created: missing.length, byRoot, contacts }

  const ids = new Map<string, mongoose.Types.ObjectId>(missing.map(p => [p, new mongoose.Types.ObjectId()]))
  const rows = missing.map(path => {
    const parent = ancestorsOfPath(path).pop()
    const name = nameOfPath(path)
    const item = items.get(path)
    const contactId = contactIds.get(path)
    return {
      _id: ids.get(path),
      orgId: oid(orgId),
      path,
      root: rootOfPath(path),
      ...(parent ? { parentId: ids.get(parent) ?? known.get(parent)?.id } : {}),
      name,
      nameLower: lowerBg(name),
      kind: kindOfPath(path),
      ...(item?.unit ? { unit: item.unit } : {}),
      ...(contactId ? { contactId } : {}),
      // FR-25a: the file's own properties. Never an employee's: that file is refused before here.
      ...(paramsOf(item) && kindOfPath(path) !== 'personnel' ? { params: paramsOf(item) } : {}),
      isActive: true,
    }
  })
  if (rows.length) await AccountingAnalytic.insertMany(rows, { ordered: false })
  for (const row of rows) {
    known.set(row.path, {
      id: row._id!,
      ...(row.contactId ? { contactId: String(row.contactId) } : {}),
      ...(row.unit ? { unit: row.unit } : {}),
    })
  }
  return { created: missing.length, byRoot, contacts }
}

/**
 * A partner the journal met first has a Contact with only a name. When a file brings its numbers
 * they go there, in what is still blank: a value someone keyed is theirs.
 */
async function fillContacts(orgId: string, items: readonly AnalyticItem[], known: AnalyticMap): Promise<void> {
  const linked = items.filter(item => !!CONTACT_TYPE[kindOfPath(item.path)] && known.get(item.path)?.contactId)
  if (!linked.length) return
  const ids = linked.map(item => known.get(item.path)!.contactId)
  const rows = new Map((await Contact.find({ orgId, _id: { $in: ids } }, { taxId: 1, taxNumber: 1, vatNumber: 1, phone: 1, notes: 1, representative: 1, addresses: 1 }).lean()).map((c: any) => [String(c._id), c]))
  for (const item of linked) {
    const contact = rows.get(known.get(item.path)!.contactId!)
    if (!contact) continue
    const { orgId: _org, type: _type, companyName: _name, ...fields } = newContact(orgId, '', item) as Record<string, any>
    // A contact from before FR-25a keeps its МОЛ in its notes: it has one, and the file does not give it a second.
    const held = (key: string) => (key === 'representative' ? hasRepresentative(contact) : Array.isArray(contact[key]) ? contact[key].length : contact[key])
    const blanks = Object.entries(fields).filter(([key]) => !held(key))
    if (blanks.length) await Contact.updateOne({ _id: contact._id, orgId }, { $set: Object.fromEntries(blanks) })
  }
}

export async function importAnalytics(orgId: string, body: AnalyticsBody, by: Importer): Promise<AnalyticsAnswer> {
  const org = await booksOrg(orgId, body.eik)
  const dryRun = isDryRun(body)

  // ⚠ Refused here too, whatever the CLI did: FR-25 §5 keeps employees out of the books' import.
  if (body.items.some(item => kindOfPath(item.path) === 'personnel')) {
    throw new BooksImportError(422, 'personal_data', 'ap_ПЕРСОНАЛ holds employees: the books do not need it.')
  }

  const known = await storedAnalytics(org.id)
  const items = new Map(body.items.map(item => [item.path, item]))
  // FR-25 R7: a store links the partners it already holds, and makes the others' Contacts only when its
  // own entries name them, so the sister store's customers and the supplier list stay out of it.
  const { created, byRoot, contacts } = await ensureAnalytics(org.id, items, known, dryRun, org.split ? { create: false, split: true } : OWN_BOOKS)
  // A store's contacts are its people's: the books fill in blanks only where they made the Contact.
  if (!dryRun && !org.split) await fillContacts(org.id, body.items, known)

  // What already exists may have gained a unit, a bank account or an asset.
  const banks = await linkBankAccounts(org.id, body.items, dryRun)
  const assets = new Map((await FixedAsset.find({ orgId: org.id }, { name: 1 }).lean()).map((a: any) => [a.name as string, a._id]))
  const fixedAssets = { linked: 0, unlinked: 0 }
  const stored: any[] = await AccountingAnalytic.find({ orgId: org.id, path: { $in: body.items.map(i => i.path) } }, { path: 1, unit: 1, bankAccountId: 1, fixedAssetId: 1, params: 1 }).lean()
  const storedByPath = new Map(stored.map(a => [a.path, a]))

  const ops: any[] = []
  let updated = 0
  let unchanged = 0
  for (const item of body.items) {
    const isAsset = kindOfPath(item.path) === 'fixed_asset'
    const assetId = isAsset ? assets.get(nameOfPath(item.path)) : undefined
    if (isAsset) fixedAssets[assetId ? 'linked' : 'unlinked']++

    const row = storedByPath.get(item.path)
    if (!row) continue
    const set: Record<string, unknown> = {}
    if (item.unit && row.unit !== item.unit) set.unit = item.unit
    const bankId = banks.ids.get(item.path)
    if (bankId && String(row.bankAccountId ?? '') !== String(bankId)) set.bankAccountId = bankId
    if (assetId && String(row.fixedAssetId ?? '') !== String(assetId)) set.fixedAssetId = assetId
    // FR-25a: a file that lists the properties replaces them; one that lists none (an older client) leaves them.
    const params = paramsOf(item)
    if (params && !sameParams(row.params, params)) set.params = params
    if (Object.keys(set).length) {
      updated++
      ops.push({ updateOne: { filter: { _id: row._id, orgId: oid(org.id) }, update: { $set: set } } })
    } else {
      unchanged++
    }
  }

  if (!dryRun && ops.length) await AccountingAnalytic.bulkWrite(ops)
  if (!dryRun && (created || updated)) await audit(org.id, by, 'analytics', { created, updated })

  return { dryRun, created, updated, unchanged, byRoot, contacts, bankAccounts: banks.answer, fixedAssets }
}

type Params = { key: string; value: string }[]

/** An item's properties as an analytic keeps them: each with a name, in the file's order. Unset when there are none. */
function paramsOf(item: AnalyticItem | undefined): Params | undefined {
  const params = (item?.params ?? []).filter(p => typeof p?.key === 'string' && p.key.trim()).map(p => ({ key: p.key, value: String(p.value ?? '') }))
  return params.length ? params : undefined
}

/** The same properties, in the same order. */
const sameParams = (a: Params | undefined, b: Params) =>
  JSON.stringify((a ?? []).map(p => [p.key, p.value ?? ''])) === JSON.stringify(b.map(p => [p.key, p.value ?? '']))

/** `БАНКОВИ СМЕТКИ:<iban>`: a BankAccount, booked on 503 or, for a currency account, 504. */
async function linkBankAccounts(orgId: string, items: readonly AnalyticItem[], dryRun: boolean) {
  const answer = { created: 0, linked: 0, noLedgerAccount: 0 }
  const ids = new Map<string, mongoose.Types.ObjectId>()
  const banks = items.filter(item => kindOfPath(item.path) === 'bank_account')
  if (!banks.length) return { answer, ids }

  const ledger = new Map((await Account.find({ orgId, code: { $in: [BANK_ACCOUNT_LOCAL, BANK_ACCOUNT_FOREIGN] } }, { code: 1 }).lean()).map((a: any) => [a.code as string, a._id]))
  const held = new Map((await BankAccount.find({ orgId }, { accountNumber: 1 }).lean()).map((b: any) => [b.accountNumber as string, b._id]))
  const fresh: any[] = []
  for (const item of banks) {
    const iban = nameOfPath(item.path).replace(/\s+/g, '')
    const existing = held.get(iban)
    if (existing) {
      answer.linked++
      ids.set(item.path, existing)
      continue
    }
    const accountId = ledger.get(item.foreignCurrency ? BANK_ACCOUNT_FOREIGN : BANK_ACCOUNT_LOCAL)
    if (!accountId) {
      answer.noLedgerAccount++
      continue
    }
    answer.created++
    const _id = new mongoose.Types.ObjectId()
    ids.set(item.path, _id)
    fresh.push({ _id, orgId: oid(orgId), name: iban, bankName: item.bankName || iban.slice(4, 8), accountNumber: iban, iban, accountId })
  }
  if (!dryRun && fresh.length) await BankAccount.insertMany(fresh)
  return { answer, ids }
}

// ── What every entry needs ──────────────────────────────────────────────────────────────────────

/** The period a month's entries belong to. In the middle of the month, whatever the server's timezone. */
async function periodOfMonth(orgId: string, month: string, dryRun: boolean) {
  const middle = dayOf(`${month}-15`)
  const period: any = await FiscalPeriod.findOne({ orgId, ...fiscalRangeFilter(middle) }, { status: 1 }).lean()
  if (period && period.status !== 'open') {
    throw new BooksImportError(409, 'period_closed', `The period ${month} is closed: an import does not rewrite it.`)
  }
  if (period) return { state: 'exists' as const, id: String(period._id) }
  // A year someone closed or locked before it had periods (a store org can hold such years, FR-25 R7)
  // gets none made open inside it: that would be an import rewriting a closed year.
  const year: any = await FiscalYear.findOne({ orgId, ...fiscalRangeFilter(middle) }, { status: 1 }).lean()
  if (year && year.status !== 'open') {
    throw new BooksImportError(409, 'period_closed', `The fiscal year of ${month} is ${year.status}: an import does not write into it.`)
  }
  if (dryRun) return { state: 'would_create' as const, id: '' }
  return { state: 'created' as const, id: await ensureFiscalPeriod(orgId, middle) }
}

/** The accounts by code. A dry run still answers with the rest: the chart may be in the same run. */
async function accountIdsOf(orgId: string, codes: Iterable<string>, dryRun: boolean) {
  const wanted = [...new Set(codes)]
  const rows: any[] = await Account.find({ orgId, code: { $in: wanted } }, { code: 1 }).lean()
  const ids = new Map<string, mongoose.Types.ObjectId>(rows.map(a => [a.code, a._id]))
  const unknownAccounts = wanted.filter(code => !ids.has(code)).sort()
  if (unknownAccounts.length && !dryRun) {
    throw new BooksImportError(422, 'unknown_accounts', `${unknownAccounts.length} account(s) are not in the chart: import the chart first.`, { accounts: unknownAccounts })
  }
  for (const code of unknownAccounts) ids.set(code, new mongoose.Types.ObjectId())
  return { ids, unknownAccounts }
}

interface LineContext {
  currency: LedgerCurrency
  branchOrgId: mongoose.Types.ObjectId
  analytics: AnalyticMap
}

function lineOn(ctx: LineContext, side: 'debit' | 'credit', accountId: mongoose.Types.ObjectId, amount: number, path?: string): IJournalEntryLine {
  const analytic = path ? ctx.analytics.get(path) : undefined
  const base = baseAmount(amount, ctx.currency)
  return {
    accountId: accountId as any,
    side,
    debit: side === 'debit' ? amount : 0,
    credit: side === 'credit' ? amount : 0,
    currency: ctx.currency,
    exchangeRate: exchangeRateOf(ctx.currency),
    baseDebit: side === 'debit' ? base : 0,
    baseCredit: side === 'credit' ? base : 0,
    branchOrgId: ctx.branchOrgId as any,
    ...(analytic ? { analyticId: analytic.id as any } : {}),
    ...(analytic?.contactId ? { contactId: oid(analytic.contactId) as any } : {}),
  }
}

function linesOf(doc: ImportDocument, accounts: Map<string, mongoose.Types.ObjectId>, ctx: LineContext): IJournalEntryLine[] {
  const lines: IJournalEntryLine[] = []
  doc.ops.forEach((op, i) => {
    const settles = settlesOfOperation(doc, op)
    const paths = { debit: op.ad, credit: op.ak }
    for (const side of ['debit', 'credit'] as const) {
      const line = lineOn(ctx, side, accounts.get(side === 'debit' ? op.d : op.k)!, op.amount, paths[side])
      line.opNo = i + 1
      if (op.comment) line.description = op.comment
      if (op.qty !== undefined) {
        line.quantity = op.qty
        const unit = paths[side] ? ctx.analytics.get(paths[side]!)?.unit : undefined
        if (unit) line.unit = unit
      }
      if (settles?.side === side) line.settles = settles.settles
      if (op.cur) line.fx = { currency: op.cur, ...(op.rate !== undefined ? { rate: op.rate } : {}), ...(op.fx !== undefined ? { amount: op.fx } : {}) }
      if (op.journal) line.journalCode = op.journal
      if (op.tax) line.taxCode = op.tax
      lines.push(line)
    }
  })
  return lines
}

const round2 = (n: number) => Math.round(n * 100) / 100 || 0

function totalsOf(lines: readonly IJournalEntryLine[]) {
  return {
    totalDebit: round2(lines.reduce((sum, l) => sum + l.baseDebit, 0)),
    totalCredit: round2(lines.reduce((sum, l) => sum + l.baseCredit, 0)),
  }
}

/** The two sides as booked. Each operation is on both, so this holds by construction, and is counted. */
const entryBalances = (doc: ImportDocument, lines: readonly IJournalEntryLine[]) =>
  lines.length === doc.ops.length * 2
  && Math.abs(lines.reduce((sum, l) => sum + l.debit - l.credit, 0)) < 0.005
  && Math.abs(lines.reduce((sum, l) => sum + l.baseDebit - l.baseCredit, 0)) < 0.005

// ── The opening (§5.3) ──────────────────────────────────────────────────────────────────────────

const signedOpening = (l: { debit: number; credit: number }) => l.debit - l.credit

/**
 * One entry a year, with a line per account and analytic.
 *
 * ⚠ PlusMinus's analytic balances have no account (they are per root), so the caller says which
 * account each row is on. A row may hold more than that account: КЛИЕНТИ is on 411 and 412 at once.
 * So the analytic lines are what they are, and what they leave of an account's balance goes on the
 * account with no analytic: the account's balance, and each analytic's, are both the file's.
 */
function openingLines(body: OpeningBody, accounts: Map<string, mongoose.Types.ObjectId>, ctx: LineContext) {
  const lines: IJournalEntryLine[] = []
  const analyticNet = new Map<string, number>()

  for (const row of body.analytics ?? []) {
    analyticNet.set(row.code, (analyticNet.get(row.code) ?? 0) + signedOpening(row))
    lines.push(openingLine(row, accounts, ctx))
  }

  const accountsWithRemainder: string[] = []
  const balance = new Map(body.accounts.map(a => [a.code, signedOpening(a)]))
  for (const code of new Set([...balance.keys(), ...analyticNet.keys()])) {
    const hadAnalytics = analyticNet.has(code)
    const rest = (balance.get(code) ?? 0) - (analyticNet.get(code) ?? 0)
    if (Math.abs(rest) < 0.005) continue
    if (hadAnalytics) accountsWithRemainder.push(code)
    lines.push(lineOn(ctx, rest > 0 ? 'debit' : 'credit', accounts.get(code)!, Math.abs(rest)))
  }
  return { lines, accountsWithRemainder: accountsWithRemainder.sort() }
}

function openingLine(row: OpeningAnalyticLine, accounts: Map<string, mongoose.Types.ObjectId>, ctx: LineContext): IJournalEntryLine {
  // Sided by the net, as every row of the file is: an analytic's balance sits on one side.
  const net = signedOpening(row)
  const side = net < 0 ? 'credit' : 'debit'
  const line = lineOn(ctx, side, accounts.get(row.code)!, Math.abs(net), row.path)
  if (row.quantity) {
    // A quantity is added on the debit and taken on the credit: the sign keeps goods on hand on hand.
    line.quantity = side === 'credit' ? -row.quantity : row.quantity
    const unit = ctx.analytics.get(row.path)?.unit
    if (unit) line.unit = unit
  }
  return line
}

export async function importOpening(orgId: string, body: OpeningBody, by: Importer): Promise<OpeningAnswer> {
  const org = await booksOrg(orgId, body.eik)
  const dryRun = isDryRun(body)
  const iso = `${body.year}-01-01`
  const currency = ledgerCurrencyOn(iso)

  // FR-25 R7: the company's opening is one entry, the home's. A store's share starts from nothing and
  // reads its balances from the home's opening on (`postedIn`), so it is never added twice.
  if (org.split?.role === 'member') {
    return {
      dryRun, year: body.year, currency, outcome: 'unchanged', lines: 0, balanced: true,
      accountsWithRemainder: [], unknownAccounts: [], analyticsToCreate: 0, continuity: null, split: { role: 'member' },
    }
  }

  const { ids: accounts, unknownAccounts } = await accountIdsOf(org.id, [...body.accounts.map(a => a.code), ...(body.analytics ?? []).map(a => a.code)], dryRun)
  const period = await periodOfMonth(org.id, `${body.year}-01`, dryRun)
  const analytics = await storedAnalytics(org.id)
  const items = new Map<string, AnalyticItem | undefined>((body.analytics ?? []).map(a => [a.path, undefined]))
  const created = await ensureAnalytics(org.id, items, analytics, dryRun, org.split ? { create: true, split: true } : OWN_BOOKS)

  const ctx: LineContext = { currency, branchOrgId: oid(org.id), analytics }
  const { lines, accountsWithRemainder } = openingLines(body, accounts, ctx)
  const importKey = `opening|${body.year}`
  const importHash = openingHash(lines)
  const existing: any = await JournalEntry.findOne({ orgId: org.id, importKey }, { importHash: 1 }).lean()
  const outcome = !existing ? 'new' : existing.importHash === importHash ? 'unchanged' : 'changed'

  if (!dryRun && outcome !== 'unchanged') {
    const fields = { date: dayOf(iso), docDate: dayOf(iso), fiscalPeriodId: oid(period.id), lines, ...totalsOf(lines), importHash, importBatchId: new mongoose.Types.ObjectId() }
    if (existing) {
      await JournalEntry.updateOne({ _id: existing._id, orgId: org.id }, { $set: fields })
    } else {
      const [entryNumber] = await reserveNumbers(org.id, ENTRY_NUMBER_PREFIX, 1, 6, body.year)
      await JournalEntry.create({
        ...fields,
        orgId: org.id,
        entryNumber,
        description: `Начално салдо ${body.year}`,
        type: 'opening',
        status: 'posted',
        ledger: 'books',
        sourceModule: BOOKS_IMPORT,
        importKey,
        branchOrgId: org.id,
        docCurrency: currency,
        createdBy: by.id,
        postedBy: by.id,
        postedAt: new Date(),
      })
    }
    await audit(org.id, by, `opening ${body.year}`, { outcome, lines: lines.length })
  }

  const balanced = Math.abs(lines.reduce((sum, l) => sum + l.debit - l.credit, 0)) < 0.015
  return {
    dryRun,
    year: body.year,
    currency,
    outcome,
    lines: lines.length,
    balanced,
    accountsWithRemainder,
    unknownAccounts,
    analyticsToCreate: created.created,
    // A share's closing is not the company's: the group's continuity is summed outside (FR-25 R7).
    continuity: org.split ? null : await openingContinuity(org.id, body),
    ...(org.split ? { split: { role: org.split.role } } : {}),
  }
}

const openingHash = (lines: readonly IJournalEntryLine[]) =>
  sha256(JSON.stringify(lines.map(l => [String(l.accountId), l.side, l.debit, l.credit, String(l.analyticId ?? ''), String(l.contactId ?? ''), l.quantity])))

/** §5.3: this opening against the previous year's closing, per account, at the rate where it changed. */
async function openingContinuity(orgId: string, body: OpeningBody): Promise<OpeningAnswer['continuity']> {
  const closing = await closingOfYear(orgId, body.year - 1)
  if (!closing) return null
  const rate = closing.currency === ledgerCurrencyOn(`${body.year}-01-01`) ? 1 : exchangeRateOf('BGN')
  const opening = new Map(body.accounts.map(a => [a.code, signedOpening(a)]))
  const differing: string[] = []
  let equal = 0
  for (const code of new Set([...opening.keys(), ...closing.balances.keys()])) {
    const expected = (closing.balances.get(code) ?? 0) * rate
    if (Math.abs(expected - (opening.get(code) ?? 0)) < 0.011) equal++
    else differing.push(code)
  }
  return { checked: equal + differing.length, equal, differing: differing.sort() }
}

// ── The journal (§5.4, §5.5) ────────────────────────────────────────────────────────────────────

const NO_DOCUMENT = 'none'

function assertMonth(body: JournalBody): void {
  if (!/^\d{4}-\d{2}$/.test(body.month)) throw new BooksImportError(422, 'bad_month', 'month must be YYYY-MM.')
  for (const doc of body.documents) {
    if (!doc.date.startsWith(body.month) || doc.date < body.coverage.from || doc.date > body.coverage.to) {
      throw new BooksImportError(422, 'document_outside_month', `A document of ${doc.date} is outside ${body.month} or what the file covers.`)
    }
  }
}

/** The month's days the file covers: an imported entry outside them cannot be judged gone. */
function coveredDays(body: JournalBody) {
  const first = `${body.month}-01`
  const last = new Date(Date.UTC(Number(body.month.slice(0, 4)), Number(body.month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  return {
    from: dayOf(first > body.coverage.from ? first : body.coverage.from),
    to: dayOf(last < body.coverage.to ? last : body.coverage.to),
  }
}

function tally(by: Record<string, MonthDiff>, docType: string | undefined, what: keyof MonthDiff): void {
  const key = docType || NO_DOCUMENT
  by[key] ??= { new: 0, changed: 0, gone: 0, unchanged: 0 }
  by[key][what]++
}

/** Each account's trees, as the journal shows them (§3.3). The chart has no column for it. */
async function noteAccountRoots(orgId: string, plans: readonly PlannedEntry[], accounts: Map<string, mongoose.Types.ObjectId>): Promise<void> {
  const roots = new Map<string, Set<string>>()
  const add = (code: string, path?: string) => {
    if (!path) return
    if (!roots.has(code)) roots.set(code, new Set())
    roots.get(code)!.add(rootOfPath(path))
  }
  for (const { doc } of plans) for (const op of doc.ops) { add(op.d, op.ad); add(op.k, op.ak) }
  const ops = [...roots].map(([code, set]) => ({
    updateOne: {
      filter: { _id: accounts.get(code), orgId: oid(orgId) },
      update: {
        $addToSet: { analyticRoots: { $each: [...set] } },
        ...([...set].some(root => analyticRootDef(root)?.quantitative) ? { $set: { quantitative: true } } : {}),
      },
    },
  }))
  if (ops.length) await Account.bulkWrite(ops)
}

/**
 * FR-25a: the document's partner when its operations name none, or several: the header's own (`ПАРТНЬОР`), when it is
 * a customer, a supplier or a partner (a bank statement's header can name its bank account, which is no partner). Where
 * the operations name exactly one, that one stays, as before: it is also what the entry is found again by (`importKey`).
 */
function headerPartnerOf(plan: PlannedEntry): string | undefined {
  if (plan.partnerPath) return undefined
  const path = plan.doc.props?.partnerPath
  return path && path.includes(':') && analyticRootDef(rootOfPath(path))?.partner ? path : undefined
}

/** A switch's key: what a stored map may hold (no dot, no `$`). */
const SWITCH_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
const instantOf = (s: string | undefined) => {
  const d = s ? new Date(s) : undefined
  return d && !Number.isNaN(d.getTime()) ? d : undefined
}

/**
 * FR-25a: the rest of the document's header, as the entry stores it. Every key is there, undefined where the file says
 * nothing, so a re-import clears what the file no longer says (`replacing`), as it does for the fields before them.
 */
function headerFieldsOf(doc: ImportDocument) {
  const p = doc.props ?? {}
  const links = (p.links ?? []).filter(l => l.docType && l.docNumber).map(l => ({
    docType: l.docType,
    docNumber: l.docNumber,
    ...(isDay(l.date) ? { date: dayOf(l.date) } : {}),
    ...(l.amount !== undefined ? { amount: l.amount } : {}),
    ...(l.amountFx !== undefined ? { amountFx: l.amountFx } : {}),
  }))
  const options = Object.entries(p.docOptions ?? {}).filter(([key, value]) => SWITCH_KEY.test(key) && typeof value === 'string' && value !== '' && value !== 'false')
  const s = p.source ?? {}
  const source = present({ createdBy: s.createdBy || undefined, createdAt: instantOf(s.createdAt), modifiedBy: s.modifiedBy || undefined, modifiedAt: instantOf(s.modifiedAt), version: s.version || undefined })
  return {
    paymentCode: p.paymentCode || undefined,
    paidAmount: p.paidAmount,
    paidCash: p.paidCash,
    taxEventDate: isDay(p.taxEventDate) ? dayOf(p.taxEventDate) : undefined,
    vatRate: p.vatRate,
    vatRule: p.vatRule || undefined,
    vatExemptionReason: p.vatExemptionReason || undefined,
    registerDocType: p.registerDocType || undefined,
    protocolType: p.protocolType || undefined,
    reasonRef: p.reasonRef || undefined,
    customsRef: p.customsRef || undefined,
    bankOperation: p.bankOperation || undefined,
    reportingMonth: p.reportingMonth && /^\d{4}(0[1-9]|1[0-2])$/.test(p.reportingMonth) ? p.reportingMonth : undefined,
    links: links.length ? links : undefined,
    docOptions: options.length ? Object.fromEntries(options) : undefined,
    source: Object.keys(source).length ? source : undefined,
  }
}

/**
 * One month, whole: a re-import replaces what the month holds, and answers with the difference.
 *
 * ⚠ Prove a re-import with a dry rerun, never a live one (FR-25 §5.5): `unchanged` equal to `entries`
 * is the proof. A journal entry that was imported is the only thing touched here; a hand-keyed entry
 * in the same month is no import's to remove.
 */
export async function importJournalMonth(orgId: string, body: JournalBody, by: Importer): Promise<JournalAnswer> {
  const org = await booksOrg(orgId, body.eik)
  const dryRun = isDryRun(body)
  assertMonth(body)

  // FR-25 R7: the whole month is planned, so a share keys its entries as the whole would, and then
  // this org keeps what it holds. An entry it imported that another org of the group now holds is gone.
  const month = planMonth(body.documents, org.branches, org.split?.homeOrgId)
  const plans = org.split ? month.filter(p => p.ownerOrgId === org.id) : month
  const codes = plans.flatMap(p => p.doc.ops.flatMap(op => [op.d, op.k]))
  const { ids: accounts, unknownAccounts } = await accountIdsOf(org.id, codes, dryRun)
  const period = await periodOfMonth(org.id, body.month, dryRun)

  const analytics = await storedAnalytics(org.id)
  const seen = new Map<string, AnalyticItem | undefined>()
  for (const { doc } of plans) for (const op of doc.ops) for (const path of pathsOf(op)) seen.set(path, undefined)
  for (const plan of plans) { const path = headerPartnerOf(plan); if (path) seen.set(path, undefined) } // FR-25a
  const { created: analyticsToCreate, contacts } = await ensureAnalytics(org.id, seen, analytics, dryRun, org.split ? { create: true, split: true } : OWN_BOOKS)

  const { from, to } = coveredDays(body)
  const stored: any[] = await JournalEntry.find(
    { orgId: org.id, ledger: 'books', sourceModule: BOOKS_IMPORT, type: { $ne: 'opening' }, date: { $gte: from, $lte: to } },
    { importKey: 1, importHash: 1, docType: 1 },
  ).lean()
  const storedByKey = new Map(stored.map(e => [e.importKey as string, e]))

  const answer: JournalAnswer = {
    dryRun,
    month: body.month,
    currency: ledgerCurrencyOn(`${body.month}-01`),
    entries: plans.length,
    documents: plans.filter(p => p.doc.docType).length,
    operations: plans.reduce((sum, p) => sum + p.doc.ops.length, 0),
    balanced: 0,
    settles: 0,
    analyticsToCreate,
    fiscalPeriod: period.state,
    new: 0,
    changed: 0,
    gone: 0,
    unchanged: 0,
    byDocType: {},
    unknownDocTypes: [],
    unknownAccounts,
    ...(org.split ? { split: { role: org.split.role, fileEntries: month.length, contacts: { created: contacts.created, linked: contacts.linked } } } : {}),
  }

  const unknown = new Map<string, number>()
  const writes: any[] = []
  const inserts: Record<string, unknown>[] = []
  const batchId = new mongoose.Types.ObjectId()
  for (const plan of plans) {
    const { doc } = plan
    if (doc.docType && !docTypeDef(doc.docType)) unknown.set(doc.docType, (unknown.get(doc.docType) ?? 0) + 1)

    const currency = ledgerCurrencyOn(doc.date)
    const branchOrgId = oid(plan.branchOrgId ?? org.id)
    const lines = linesOf(doc, accounts, { currency, branchOrgId, analytics })
    if (entryBalances(doc, lines)) answer.balanced++
    answer.settles += lines.filter(l => l.settles?.length).length

    const importHash = importHashOf(plan, { branchOrgId: String(branchOrgId), contactIds: lines.map(l => l.contactId && String(l.contactId)) })
    const prior = storedByKey.get(plan.importKey)
    storedByKey.delete(plan.importKey)
    const what = !prior ? 'new' : prior.importHash === importHash ? 'unchanged' : 'changed'
    answer[what]++
    tally(answer.byDocType, doc.docType, what)
    if (what === 'unchanged') continue

    const date = dayOf(doc.date)
    const partnerPath = plan.partnerPath ?? headerPartnerOf(plan)
    const fields = {
      date,
      docDate: date,
      fiscalPeriodId: period.id ? oid(period.id) : undefined,
      description: plan.description,
      lines,
      ...totalsOf(lines),
      reference: doc.docType ? [doc.docType, doc.docNumber].filter(Boolean).join(' ') : undefined,
      docType: doc.docType,
      docNumber: doc.docNumber,
      vatKind: doc.vatKind,
      docTotal: doc.total,
      docVat: plan.docVat,
      docCurrency: currency,
      partnerAnalyticId: partnerPath ? analytics.get(partnerPath)?.id : undefined,
      branchOrgId,
      ...headerFieldsOf(doc),
      importBatchId: batchId,
      importHash,
    }
    if (prior) writes.push({ updateOne: { filter: { _id: prior._id, orgId: oid(org.id) }, update: replacing(fields) } })
    else inserts.push({ ...present(fields), importKey: plan.importKey })
  }

  for (const gone of storedByKey.values()) {
    answer.gone++
    tally(answer.byDocType, gone.docType, 'gone')
    writes.push({ deleteOne: { filter: { _id: gone._id, orgId: oid(org.id) } } })
  }
  answer.unknownDocTypes = [...unknown].map(([docType, count]) => ({ docType, count }))

  if (dryRun) return answer

  // Drawn before the transaction: an abort leaves a gap in a series nobody files.
  const year = Number(body.month.slice(0, 4))
  const numbers = inserts.length ? await reserveNumbers(org.id, ENTRY_NUMBER_PREFIX, inserts.length, 6, year) : []
  const now = new Date()
  inserts.forEach((fields, i) => {
    writes.push({
      insertOne: {
        document: {
          ...fields,
          orgId: oid(org.id),
          entryNumber: numbers[i],
          type: 'standard',
          status: 'posted',
          ledger: 'books',
          sourceModule: BOOKS_IMPORT,
          createdBy: by.id,
          postedBy: by.id,
          postedAt: now,
        },
      },
    })
  })

  if (writes.length) {
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        await JournalEntry.bulkWrite(writes, { session })
      })
    } finally {
      await session.endSession()
    }
    await audit(org.id, by, `journal ${body.month}`, { new: answer.new, changed: answer.changed, gone: answer.gone })
    logger.info({ orgId: org.id, month: body.month, new: answer.new, changed: answer.changed, gone: answer.gone }, 'Books import: a month written')
  }
  await noteAccountRoots(org.id, plans, accounts)
  return { ...answer, batchId: String(batchId) }
}

const present = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** An update that also clears what the file no longer says. */
function replacing(fields: Record<string, unknown>) {
  const cleared = Object.keys(fields).filter(k => fields[k] === undefined)
  return { $set: present(fields), ...(cleared.length ? { $unset: Object.fromEntries(cleared.map(k => [k, 1])) } : {}) }
}

// ── The end (§5.5) ──────────────────────────────────────────────────────────────────────────────

/** `Account.balance` from the lines, once, after the months: an import never touches it per entry. */
export async function finishImport(orgId: string, body: { eik: string; dryRun?: boolean }, by: Importer): Promise<FinishAnswer> {
  const org = await booksOrg(orgId, body.eik)
  const dryRun = isDryRun(body)
  const answer = await rebuildBalances(org.id, dryRun)
  if (!dryRun && answer.changed) await audit(org.id, by, 'balances', { accounts: answer.accounts, changed: answer.changed })
  return { dryRun, ...answer }
}
