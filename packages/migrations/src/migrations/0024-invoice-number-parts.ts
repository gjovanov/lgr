import type { Migration, MigrationContext } from '../types.js'
import { numberPartsOf, type InvoiceNumberParts } from 'db/plugins/invoice-number-parts'

type Db = MigrationContext['db']

/**
 * #929: every invoice carries its running number, `numberHead` / `numberSeq` (`db/plugins/invoice-number-parts`),
 * which the next number of a series is read from (`invoice-numbering.service#currentMaxSuffix`) through the index
 * `invoice_number_seq`, instead of a scan of every number the org ever issued.
 *
 * From this release on every write keeps the fields (the model's hooks, and each raw writer through
 * `withNumberParts`); this fills them on the documents written before, and builds the index first.
 *
 * - **Before it runs** the numbering is still correct, only as slow as it was: a document without `numberHead` is read
 *   by the old scan of its number (`unbackfilledMax`), beside the stored maximum of the others.
 * - **While it runs** each document is either written already (read through the index) or not yet (read by the
 *   scan): never neither, so the maximum never drops.
 * - **After it**, no document of the org lacks the field, one indexed read says so, and the scan does not run.
 *
 * ⚠ It RECOMPUTES every document, not only those missing the fields: a value that does not match its number (written
 * by a pod of the previous release changing a number a pod of this one had given parts, during a rollout) is put
 * right too. So run it once the rollout is complete. Each write names the number it read: a document whose number
 * changed in between got its parts from that write's own hook.
 *
 * A number with no running number (a till placeholder `~pending:…`, a POS transaction number with no `-<digits>`
 * at its end) gets `numberHead: ''`, `numberSeq: null`, so it reads as done, and is COUNTED, never silently passed
 * over. That lowers no maximum: the old scan's pattern ended in `-<digits>`, so it never counted such a number either.
 *
 * Batched (a cursor per org, writes of 500), scoped by `orgFilter`, idempotent: a second run finds every document
 * already set and writes nothing. `--dry-run` prints counts only, per org (by id): invoices, already set, to set
 * (missing or stale), with no running number. Expand only: the previous release neither reads nor writes the
 * fields, and the index is one more it does not use.
 */
const INDEX = 'invoice_number_seq'
const BATCH = 500

interface OrgCounts {
  invoices: number
  alreadySet: number
  missing: number
  stale: number
  noRunningNumber: number
}

interface Write {
  updateOne: { filter: Record<string, unknown>; update: { $set: InvoiceNumberParts } }
}

const sameParts = (doc: Record<string, unknown>, want: InvoiceNumberParts) =>
  doc.numberHead === want.numberHead && (doc.numberSeq ?? null) === want.numberSeq

/**
 * Walk every invoice in scope, org by org, counting; with `write`, put right each one whose parts are missing or
 * stale, a batch at a time. Returns the counts per org id, and how many documents the writes changed.
 */
async function walk(db: Db, orgFilter: Record<string, unknown>, write: boolean): Promise<{ byOrg: Map<string, OrgCounts>; written: number }> {
  const invoices = db.collection('invoices')
  const byOrg = new Map<string, OrgCounts>()
  let written = 0
  let pending: Write[] = []
  const flush = async () => {
    if (pending.length) written += (await invoices.bulkWrite(pending, { ordered: false })).modifiedCount
    pending = []
  }
  const orgs: unknown[] = await invoices.distinct('orgId', orgFilter)
  for (const orgId of orgs) {
    const c: OrgCounts = { invoices: 0, alreadySet: 0, missing: 0, stale: 0, noRunningNumber: 0 }
    byOrg.set(String(orgId), c)
    const cursor = invoices.find({ ...orgFilter, orgId }, { projection: { invoiceNumber: 1, numberHead: 1, numberSeq: 1 }, sort: { _id: 1 } })
    for await (const doc of cursor) {
      c.invoices++
      const want = numberPartsOf(doc.invoiceNumber)
      if (want.numberSeq === null) c.noRunningNumber++
      if (sameParts(doc, want)) {
        c.alreadySet++
        continue
      }
      if (typeof doc.numberHead === 'string') c.stale++
      else c.missing++
      if (!write) continue
      pending.push({ updateOne: { filter: { _id: doc._id, invoiceNumber: doc.invoiceNumber }, update: { $set: want } } })
      if (pending.length >= BATCH) await flush()
    }
  }
  await flush()
  return { byOrg, written }
}

const summary = (orgId: string, c: OrgCounts) =>
  `${orgId}: ${c.invoices} invoice(s); ${c.alreadySet} already set, ${c.missing + c.stale} to set (${c.missing} missing, ` +
  `${c.stale} stale); ${c.noRunningNumber} with no running number`

export const invoiceNumberParts: Migration = {
  id: '0024-invoice-number-parts',
  description: "Every invoice stores its running number (numberHead / numberSeq) and the index the next number is read through, so drawing a number no longer scans the org's invoices (#929)",
  async preview({ db, orgFilter }: MigrationContext) {
    const { byOrg } = await walk(db, orgFilter, false)
    const lines = [...byOrg].map(([id, c]) => summary(id, c))
    return lines.length ? lines : ['no invoices']
  },
  async up({ db, log, orgFilter }) {
    const invoices = db.collection('invoices')
    // The same key and name as the schema's (`INVOICE_NUMBER_SEQ_KEY`): a no-op where the server built it already.
    await invoices.createIndex({ orgId: 1, numberHead: 1, numberSeq: -1 }, { name: INDEX })
    const { byOrg, written } = await walk(db, orgFilter, true)
    let toSet = 0
    for (const [id, c] of byOrg) {
      toSet += c.missing + c.stale
      log(summary(id, c), { orgId: id, ...c })
    }
    const left = await invoices.countDocuments({ ...orgFilter, numberHead: null })
    log(`invoices given their running number: ${written} of ${toSet}; left without one: ${left} (the numbering reads those by their numbers)`)
  },
}
