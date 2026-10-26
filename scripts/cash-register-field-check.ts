// FR-21 §8.4 — the field check around a cash-register release. READ-ONLY.
//
// Run it from packages/portal-api on the build host: its bare imports resolve from there, and
// `bun -e` swallows CLI flags, so the window comes from the environment.
//
//   git -C ~/lgr show origin/master:scripts/cash-register-field-check.ts > /tmp/field-check.ts
//   cd ~/lgr/packages/portal-api
//   export MONGODB_URI=…            # through a port-forward (the deploy-prod skill has the recipe)
//   export FIELD_FROM=2026-09-26 FIELD_TO=2026-10-25 FIELD_DIGEST_DAY=2026-10-23
//   bun -e "$(cat /tmp/field-check.ts)" > /tmp/field-before.json   # with the code before the release
//   … deploy, then `bun run migrate` …
//   bun -e "$(cat /tmp/field-check.ts)" > /tmp/field-after.json    # with the code after it
//   diff /tmp/field-before.json /tmp/field-after.json
//
// Both runs read the same CLOSED window of Bulgarian days (inclusive), so sales rung in between
// change nothing. Per org — every org holding POS rows or cash-register documents, or the slugs in
// FIELD_ORGS (comma-separated) — it prints:
// - the two stores' counts;
// - SUPTO 18.1–18.5 over the window;
// - the digest's KPIs for FIELD_DIGEST_DAY;
// - the journal's total and that day's cash.
// Across R2's migration only `code` and `origins` may differ: `origins` is what 0008 labels.
//
// ⚠ The output holds business figures. It stays on the build host — never in an issue, a PR or
// this repository.
//
// It never writes. There is no connectDB() (its warmup writes), and autoIndex and autoCreate are
// off, so a model the newer code knows creates no collection and builds no index on prod.
import { mongoose } from 'db/connection'
import { initServiceContext } from 'services/context'
import { createMongoRepositories } from 'dal-mongo'
import { Org, Invoice, POSTransaction } from 'db/models'
import * as supto from 'services/biz/supto-export.service'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { listJournal } from 'services/biz/cash-register/journal.service'
import { localDayEnd, localDayStart } from 'services/biz/local-day'

const day = (name: string): string => {
  const v = process.env[name]
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name}=YYYY-MM-DD is required`)
  return v
}
const FROM_DAY = day('FIELD_FROM')
const TO_DAY = day('FIELD_TO')
const DIGEST_DAY = day('FIELD_DIGEST_DAY')
const FROM = localDayStart(FROM_DAY)
const TO = localDayEnd(TO_DAY)
const cents = (n: number) => Math.round(n * 100) / 100
const sum = (rows: any[]) => cents(rows.reduce((s, r) => s + (Number(r.total) || 0), 0))

await mongoose.connect(process.env.MONGODB_URI!, { autoIndex: false, autoCreate: false })
try {
  initServiceContext(await createMongoRepositories({ backend: 'mongo' } as any))
  let code = 'R1'
  try {
    await import('services/biz/cash-register/register.service')
    code = 'R2'
  } catch { /* R1 has no write service */ }

  const db = mongoose.connection.db!
  const wanted = (process.env.FIELD_ORGS || '').split(',').map(s => s.trim()).filter(Boolean)
  const orgs: any[] = wanted.length
    ? await Org.find({ slug: { $in: wanted } }, { slug: 1, settings: 1 }).sort({ slug: 1 }).lean().exec()
    : await Org.find({ _id: { $in: [
        ...await db.collection('postransactions').distinct('orgId'),
        ...await db.collection('invoices').distinct('orgId', { type: { $in: ['cash_sale', 'cash_storno'] } }),
      ] } }, { slug: 1, settings: 1 }).sort({ slug: 1 }).lean().exec()

  const out: Record<string, any> = { code, window: [FROM_DAY, TO_DAY], digestDay: DIGEST_DAY }
  const missing = wanted.filter(slug => !orgs.some(o => o.slug === slug))
  if (missing.length) out.missing = missing

  for (const org of orgs) {
    const orgId = String(org._id)
    const o = org._id
    const f = { orgId, dateFrom: FROM, dateTo: TO }
    const s181 = await supto.exportSummarizedSales(f)
    const sections = Object.fromEntries(['documents', 'materials', 'stock', 'corrections', 'undocumentedSales', 'duplicates', 'editedAfterIssue', 'ops', 'backups'].map(k => [k, false]))
    const digest: any = await buildDailyDigest(orgId, DIGEST_DAY, { sections })

    const row: Record<string, any> = {
      pos: await POSTransaction.countDocuments({ orgId: o }).exec(),
      posByType: await POSTransaction.aggregate([{ $match: { orgId: o } }, { $group: { _id: { t: '$type', s: '$status' }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).exec(),
      cashSales: await Invoice.countDocuments({ orgId: o, type: 'cash_sale' }).exec(),
      cashSalesVoided: await Invoice.countDocuments({ orgId: o, type: 'cash_sale', status: 'voided' }).exec(),
      cashStornos: await Invoice.countDocuments({ orgId: o, type: 'cash_storno' }).exec(),
      tillDocuments: await Invoice.countDocuments({ orgId: o, 'register.origin': 'pos' }).exec(),
      copies: await Invoice.countDocuments({ orgId: o, 'register.legacy.source': 'postransactions' }).exec(),
      origins: await Invoice.aggregate([{ $match: { orgId: o, type: 'cash_sale' } }, { $group: { _id: '$register.origin', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).exec(),
      s181: { pos: s181.transactions.length, posTotal: sum(s181.transactions), cash: s181.cashSales.length, cashTotal: sum(s181.cashSales) },
      s182: (await supto.exportPaymentDetails(f)).length,
      s183: (await supto.exportItemizedSales(f)).length,
      s184: (await supto.exportReversedSales(f)).length,
      s185: (await supto.exportCancelledSales(f)).length,
      digestKpis: digest.kpis,
    }

    // The journal lists every sale once: a copied POS row is read as its document.
    const all = await listJournal({ orgId, size: 1 })
    row.journalTotal = all.total
    row.journalInvariant = all.total === row.pos - row.copies + row.cashSales + row.cashStornos
    const dayRows = await listJournal({ orgId, dateFrom: DIGEST_DAY, dateTo: DIGEST_DAY, timeZone: org.settings?.timezone, size: 500 })
    let cash = 0
    for (const r of dayRows.rows) {
      if (r.status === 'voided') continue
      const sign = r.kind === 'storno' ? -1 : 1
      for (const p of r.payments) if (p.method === 'cash') cash += sign * p.amount
    }
    row.journalDay = { rows: dayRows.total, cashKept: cents(cash) }

    // #249: an invoiced cash sale is listed once, carrying its invoice, and the invoice is no
    // cash-register row.
    const invoiced: any[] = await Invoice.find({ orgId: o, type: 'invoice', 'cashSaleRef.cashSaleId': { $exists: true } }, { invoiceNumber: 1, status: 1, cashSaleRef: 1 }).sort({ _id: -1 }).limit(3).lean().exec()
    row.invoicedCashSales = []
    for (const inv of invoiced) {
      const csNumber = inv.cashSaleRef?.number
      const same = csNumber ? (await listJournal({ orgId, search: csNumber, size: 10 })).rows.filter((r: any) => r.number === csNumber) : []
      const asRow = (await listJournal({ orgId, search: inv.invoiceNumber, size: 10 })).rows.some((r: any) => r.number === inv.invoiceNumber)
      row.invoicedCashSales.push({
        invoice: inv.invoiceNumber, status: inv.status, cashSale: csNumber,
        journalRows: same.length, invoicingState: same[0]?.invoicingState,
        invoices: (same[0]?.invoices || []).map((i: any) => i.number), invoiceListedAsRow: asRow,
      })
    }
    out[org.slug] = row
  }
  console.log(JSON.stringify(out, null, 1))
} finally {
  await mongoose.disconnect()
}
