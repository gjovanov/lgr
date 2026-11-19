/**
 * #814 (FR-25a): an org that keeps imported books, in the e2e database. `packages/e2e/scripts/nightly.ts` runs this
 * right after the seed, with the same environment, and a failure here fails the run as a failed seed does:
 *
 *   bun --env-file=.env.test run packages/tests/src/helpers/books-org.ts
 *
 * The seed makes no such org, and only an ops script (`scripts/link-books.ts`) links one, so no browser test could open
 * a screen that shows what the books import wrote. Here:
 *
 * - `e2e-books`, a NEW org (never a seeded one: every other project's specs run on those) with an admin of its own,
 *   linked as a split of one, its own home: the shape a store's books take on prod;
 * - filled through the books import's own service functions, as `scripts/import-accounting-books.ts` fills a real one
 *   over HTTP: the chart, the analytics (two customers, a bank account, a fixed asset with its properties), the 2026
 *   opening, January and February, the finish, and one filed VAT month whose register rows match two invoices;
 * - `e2e-analytics`, an org of LGR's own with a few analytics, the only kind a person may change. Nothing in LGR writes
 *   an analytic outside a books org, so these are inserted as the import would write them (as the integration tests do).
 *
 * Idempotent: on a database that has them, a second run makes nothing new (each import answers `unchanged`). It reads
 * the fixture from `packages/e2e/tests/helpers/books-org.ts`, which the specs read too. Every value is made up.
 *
 * It lives beside `seed.ts` for the reason the seed does: the workspace packages it calls resolve from here, and not
 * from `packages/e2e`.
 */
import { connectDB, disconnectDB } from 'db/connection'
import { AccountingAnalytic, BankAccount, FixedAsset, Identity, JournalEntry, Org, User, VatRegisterEntry, Account } from 'db/models'
import { initServiceContext } from 'services/context'
import { defaultOrgSettings, provisionNewOrg } from 'services/biz/auth.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { finishImport, importAnalytics, importChart, importJournalMonth, importOpening, type Importer } from 'services/biz/accounting-books/import.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import type { ImportDocument, JournalAnswer } from 'services/biz/accounting-books/import.types'
import { generateMonthFiles } from 'services/biz/vat-files/month'
import { applyVatImport, planVatImport } from 'services/biz/vat-files/vat-return.service'
import {
  ASSET, BANK, BOOKS_ADMIN, BOOKS_CHART, BOOKS_ORG, CUSTOMER, FEBRUARY_INVOICE, NATIVE_ANALYTIC, NATIVE_ORG, PAID_INVOICE,
  PART_PAID_INVOICE, PAYMENT, SECOND_CUSTOMER, VAT_PERIOD,
} from '../../../e2e/tests/helpers/books-org'

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** The person behind both memberships: found by address, made once. */
async function person(passwordHash: string) {
  const held = await Identity.findOne({ email: BOOKS_ADMIN.email })
  if (held) return held
  return Identity.create({
    email: BOOKS_ADMIN.email,
    password: passwordHash,
    passwordSetBy: 'self',
    emailVerified: true,
    emailVerifiedAt: new Date(),
    isActive: true,
    firstName: BOOKS_ADMIN.firstName,
    lastName: BOOKS_ADMIN.lastName,
  })
}

/**
 * An org with the person as its admin, as a new org is provisioned (apps, built-in roles, the founder the Administrator).
 * Found by slug on a second run, and left as it is.
 */
async function orgWithAdmin(spec: { slug: string; name: string; taxNumber?: string; vatNumber?: string }, identityId: unknown, passwordHash: string) {
  const held = await Org.findOne({ slug: spec.slug })
  if (held) {
    const admin = await User.findOne({ orgId: held._id, username: BOOKS_ADMIN.username })
    if (!admin) throw new Error(`${spec.slug} exists without ${BOOKS_ADMIN.username}: drop the org and run again`)
    return { org: held, admin }
  }
  const org = await Org.create({
    name: spec.name,
    slug: spec.slug,
    ...(spec.taxNumber ? { taxNumber: spec.taxNumber } : {}),
    ...(spec.vatNumber ? { vatNumber: spec.vatNumber } : {}),
    // As a books org is made (`link-books.service.ts`): kept in EUR. In English, as the other specs read their screens.
    settings: { ...defaultOrgSettings({ baseCurrency: 'EUR', locale: 'en' }), timezone: 'Europe/Sofia' },
    subscription: { plan: 'professional', maxUsers: 50 },
  })
  const admin = await User.create({
    email: BOOKS_ADMIN.email,
    username: BOOKS_ADMIN.username,
    password: passwordHash,
    firstName: BOOKS_ADMIN.firstName,
    lastName: BOOKS_ADMIN.lastName,
    orgId: org._id,
    identityId,
    isActive: true,
  })
  await provisionNewOrg(org, admin)
  return { org, admin }
}

/** The analytics file as the accountant's program writes it (`ap_*.json`), read by the importer's own parser. */
function analyticsFile() {
  const rows = [
    { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
    {
      ap: CUSTOMER.path,
      params: { 'БУЛСТАТ': CUSTOMER.eik, 'ИНДДС': CUSTOMER.vatNumber, 'АДРЕС': 'ул. Тестова 1', 'ГРАД': 'гр. Тестоград', 'МОЛ': CUSTOMER.representative },
    },
    { ap: SECOND_CUSTOMER.path, params: { 'БУЛСТАТ': SECOND_CUSTOMER.eik, 'ИНДДС': SECOND_CUSTOMER.vatNumber, 'ГРАД': 'гр. Пробоград' } },
    { ap: 'БАНКОВИ СМЕТКИ', params: {}, group: 'true' },
    { ap: BANK.path, params: { 'БАНКА': BANK.bankName } },
    { ap: 'ДА', params: {}, group: 'true' },
    {
      // Every property `fixed-asset-params.ts` reads, as the program lists them: the import makes the asset from these.
      ap: ASSET.path,
      params: {
        'СМЕТКА': ASSET.account, 'ДЕБИТ': '603', 'КРЕДИТ': '2414', 'МЕТОД': 'линеен', 'ДАТА': '15.03.2024', 'СТОЙНОСТ': '1200',
        'ОБЩАСТОЙНОСТ': '1500', 'ПРОЦЕНТ': '15', 'СРОК': '6.6667', 'НАЧ.АМ.': '0', 'КАТ': '4', 'ДАТАЕКСП': '01.04.2024',
        'ДАННОРМА': '30', 'ДАНСРОК': '3.3333', 'ДАНСТОЙН': '1500', 'ОБЩДАНАМ': '450', 'НАЧДАНАМ': '0', 'ПЕРДАНАМ': '2025',
        'ОТПДАТА': '', 'ОТПДАП': '', 'НАЧИСЛ': '',
      },
    },
  ]
  return parseAnalyticsFile(new TextEncoder().encode(JSON.stringify(rows)))
}

/** January: the part-paid invoice, the bank document that paid part of it (each links the other), and a cash sale. */
const JANUARY: ImportDocument[] = [
  {
    date: PART_PAID_INVOICE.date,
    docType: PART_PAID_INVOICE.docType,
    docNumber: PART_PAID_INVOICE.docNumber,
    total: PART_PAID_INVOICE.total,
    comment: 'Продажба на стоки',
    ops: [
      { d: '411', k: '702', ad: CUSTOMER.path, amount: 100 },
      { d: '411', k: '4532', ad: CUSTOMER.path, amount: 20 },
    ],
    props: {
      paymentCode: '2',
      paidAmount: PART_PAID_INVOICE.paid,
      registerDocType: '1',
      vatRate: 20,
      taxEventDate: PART_PAID_INVOICE.date,
      partnerPath: CUSTOMER.path,
      links: [{ docType: PAYMENT.docType, docNumber: PAYMENT.docNumber, date: PAYMENT.date, amount: PAYMENT.amount }],
      docOptions: { printed: 'true' },
      source: { createdBy: 'operator1', createdAt: '2026-01-12T09:15:00Z', modifiedBy: 'operator1', modifiedAt: '2026-01-20T10:00:00Z' },
    },
  },
  {
    date: PAID_INVOICE.date,
    docType: PAID_INVOICE.docType,
    docNumber: PAID_INVOICE.docNumber,
    total: PAID_INVOICE.total,
    comment: 'Продажба в брой',
    ops: [
      { d: '411', k: '702', ad: SECOND_CUSTOMER.path, amount: 50 },
      { d: '411', k: '4532', ad: SECOND_CUSTOMER.path, amount: 10 },
      { d: '501', k: '411', ak: SECOND_CUSTOMER.path, amount: 60 },
    ],
    props: { paymentCode: '1', paidAmount: PAID_INVOICE.total, paidCash: PAID_INVOICE.total, registerDocType: '1', vatRate: 20, taxEventDate: PAID_INVOICE.date },
  },
  {
    date: PAYMENT.date,
    docType: PAYMENT.docType,
    docNumber: PAYMENT.docNumber,
    total: PAYMENT.amount,
    // A bank line's comment names the invoices it pays.
    comment: `${PART_PAID_INVOICE.docType} ${PART_PAID_INVOICE.docNumber}`,
    ops: [{ d: '503', k: '411', ad: BANK.path, ak: CUSTOMER.path, amount: PAYMENT.amount }],
    props: {
      bankOperation: 'TEST-0001',
      links: [{ docType: PART_PAID_INVOICE.docType, docNumber: PART_PAID_INVOICE.docNumber, date: PART_PAID_INVOICE.date, amount: PAYMENT.amount }],
    },
  },
]

/** February: an invoice nothing has paid, and a month's depreciation (an operation with no document). */
const FEBRUARY: ImportDocument[] = [
  {
    date: FEBRUARY_INVOICE.date,
    docType: FEBRUARY_INVOICE.docType,
    docNumber: FEBRUARY_INVOICE.docNumber,
    total: FEBRUARY_INVOICE.total,
    comment: 'Продажба на стоки',
    ops: [
      { d: '411', k: '702', ad: CUSTOMER.path, amount: 200 },
      { d: '411', k: '4532', ad: CUSTOMER.path, amount: 40 },
    ],
    props: { paymentCode: '2', paidAmount: 0, registerDocType: '1', vatRate: 20, taxEventDate: FEBRUARY_INVOICE.date },
  },
  { date: '2026-02-28', ops: [{ d: '603', k: '2414', ak: ASSET.path, amount: 18.75, comment: 'Амортизация 02.2026' }] },
]

/**
 * The January return as filed: two sales rows, for the two invoices, by their register type and number, and no
 * purchases. Its files come from the codec's own encoder, so they regenerate byte for byte, which the import demands.
 */
function vatFiles() {
  const row = (docNumber: string, date: string, partnerVat: string, partnerName: string, base: number, vat: number) => ({
    rowNo: 0, docTypeCode: '01', docNumber, docDate: day(date), partnerVat, partnerName, description: 'Стоки', code: '',
    cells: { '02-11': base * 100, '02-21': vat * 100 },
  })
  return generateMonthFiles({
    vatId: BOOKS_ORG.vatNumber,
    name: BOOKS_ORG.name.toUpperCase(),
    period: VAT_PERIOD,
    filer: 'ТЕСТОВ ПОДАТЕЛ',
    declared: {},
    sales: [
      row(PART_PAID_INVOICE.docNumber, PART_PAID_INVOICE.date, CUSTOMER.vatNumber, CUSTOMER.name.toUpperCase(), 100, 20),
      row(PAID_INVOICE.docNumber, PAID_INVOICE.date, SECOND_CUSTOMER.vatNumber, SECOND_CUSTOMER.name.toUpperCase(), 50, 10),
    ],
    purchases: [],
  })
}

const journalLine = (a: JournalAnswer) => `${a.month}: ${a.new} new, ${a.changed} changed, ${a.unchanged} unchanged`

async function booksOrg(identityId: unknown, passwordHash: string) {
  const { org, admin } = await orgWithAdmin({ slug: BOOKS_ORG.slug, name: BOOKS_ORG.name, taxNumber: BOOKS_ORG.eik, vatNumber: BOOKS_ORG.vatNumber }, identityId, passwordHash)
  const orgId = String(org._id)
  await linkBooks({ split: true, booksSlug: BOOKS_ORG.slug, branches: [{ slug: BOOKS_ORG.slug, code: BOOKS_ORG.branchCode }] }, { dryRun: false })

  const by: Importer = { id: String(admin._id) }
  const file = { eik: BOOKS_ORG.eik, dryRun: false }
  const chart = await importChart(orgId, { ...file, accounts: BOOKS_CHART.map(([code, name]) => ({ code, name })) }, by)
  const analytics = await importAnalytics(orgId, { ...file, items: analyticsFile() }, by)
  if (analytics.fixedAssets.problems?.length) throw new Error(`the fixed asset was not taken: ${JSON.stringify(analytics.fixedAssets.problems)}`)
  const opening = await importOpening(orgId, {
    ...file,
    year: 2026,
    accounts: [{ code: '101', debit: 0, credit: 2000 }, { code: '204', debit: 1500, credit: 0 }, { code: '503', debit: 500, credit: 0 }],
    analytics: [{ code: '503', path: BANK.path, debit: 500, credit: 0 }],
  }, by)
  const months = [
    await importJournalMonth(orgId, { ...file, month: '2026-01', coverage: { from: '2026-01-01', to: '2026-01-31' }, documents: JANUARY }, by),
    await importJournalMonth(orgId, { ...file, month: '2026-02', coverage: { from: '2026-02-01', to: '2026-02-28' }, documents: FEBRUARY }, by),
  ]
  for (const m of months) if (m.balanced !== m.entries) throw new Error(`${m.month}: ${m.entries - m.balanced} entries do not balance`)
  await finishImport(orgId, file, by)

  const plan = await planVatImport(org, vatFiles())
  await applyVatImport(orgId, plan)

  const [accounts, analyticCount, entries, assets, banks, vatRows] = await Promise.all([
    Account.countDocuments({ orgId }),
    AccountingAnalytic.countDocuments({ orgId }),
    JournalEntry.countDocuments({ orgId }),
    FixedAsset.countDocuments({ orgId }),
    BankAccount.countDocuments({ orgId }),
    VatRegisterEntry.countDocuments({ orgId, period: VAT_PERIOD }),
  ])
  console.log(`books-org: ${BOOKS_ORG.slug} (${BOOKS_ADMIN.username}/${BOOKS_ADMIN.password}): ${accounts} accounts, ${analyticCount} analytics, ${entries} entries, ${assets} fixed asset(s), ${banks} bank account(s), ${vatRows} VAT rows`)
  console.log(`books-org:   chart ${chart.created} new, analytics ${analytics.created} new, opening ${opening.outcome}, ${months.map(journalLine).join('; ')}, VAT ${VAT_PERIOD} ${plan.action}`)
}

/** An org of LGR's own with a root and one partner under it, written as the import writes an analytic. */
async function nativeOrg(identityId: unknown, passwordHash: string) {
  const { org } = await orgWithAdmin(NATIVE_ORG, identityId, passwordHash)
  const root = await AccountingAnalytic.findOneAndUpdate(
    { orgId: org._id, path: NATIVE_ANALYTIC.root },
    { $setOnInsert: { root: NATIVE_ANALYTIC.root, name: NATIVE_ANALYTIC.root, nameLower: NATIVE_ANALYTIC.root.toLocaleLowerCase('bg'), kind: 'customer', isActive: true } },
    { upsert: true, new: true },
  )
  await AccountingAnalytic.updateOne(
    { orgId: org._id, path: NATIVE_ANALYTIC.path },
    {
      $setOnInsert: {
        root: NATIVE_ANALYTIC.root, parentId: root._id, name: NATIVE_ANALYTIC.name, nameLower: NATIVE_ANALYTIC.name.toLocaleLowerCase('bg'),
        kind: 'customer', isActive: true,
      },
    },
    { upsert: true },
  )
  console.log(`books-org: ${NATIVE_ORG.slug} (${BOOKS_ADMIN.username}/${BOOKS_ADMIN.password}): ${await AccountingAnalytic.countDocuments({ orgId: org._id })} analytics of its own`)
}

export async function makeBooksOrg() {
  await connectDB()
  const { createMongoRepositories } = await import('dal-mongo')
  initServiceContext(await createMongoRepositories({ backend: 'mongo' }))

  const passwordHash = await Bun.password.hash(BOOKS_ADMIN.password)
  const identity = await person(passwordHash)
  await booksOrg(identity._id, passwordHash)
  await nativeOrg(identity._id, passwordHash)
}

if (import.meta.main) {
  await makeBooksOrg()
  await disconnectDB()
  console.log(`books-org: done in ${(performance.now() / 1000).toFixed(1)} s`)
  process.exit(0)
}
