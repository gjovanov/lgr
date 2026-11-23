import type { Migration, MigrationContext } from '../types.js'

type Db = MigrationContext['db']

/**
 * One meaning for an imported document's `lineTotal`: gross, as on every document LGR makes itself (#598).
 *
 * The document import (`doc-import/map-invoice.ts`, which the PlusMinus API import goes through too) stored
 * the document's NET line value there, and `taxAmount = net × rate` beside it. The forms, `withLineAmounts`,
 * an invoice for a cash sale and a reservation's conversion store net after discount PLUS VAT. So the
 * contact ledger's Total column, the product ledger's invoice sales and the journal (`lineTotal −
 * taxAmount` as revenue) read an imported invoice's net as if it were gross. The mapper writes gross now;
 * this converts the lines already imported: `lineTotal += taxAmount`.
 *
 * What it picks: invoices, credit notes and debit notes the import made, tagged `ocr-import` or whose first
 * status says `ocr_import` (written once, by the import), both directions. A cash sale is not one of
 * them: FR-21.5 made those gross (0007, 0011).
 *
 * ⚠ Decided per LINE, by the line's own terms. Unlike 0007's till days, an imported document's lines are
 * not all of one kind: "Копирай" carries the `ocr-import` tag onto a document the form saves gross, and so
 * does a person who edits an imported draft, and the org that imports its sales also issues invoices in
 * LGR. A line's net by its terms is `quantity × unitPrice × (1 − discount%)` (the import derives the price
 * so that it reproduces the paper's line value), its gross that plus its `taxAmount`. A line is
 *   - net, and converted, when its `lineTotal` is nearer the net than the gross and within half its VAT
 *     (at least a cent) of it;
 *   - gross, and left alone, when nearer the gross on the same terms;
 *   - without VAT when its `taxAmount` rounds to 0.00: net and gross are the same, nothing to change;
 *   - neither, and left alone, when it is far from both (a line with no quantity or price, say). These
 *     are counted, and `--dry-run` names their documents, for a person to look at.
 * A converted line is gross by the same test, so running this twice changes nothing.
 *
 * Only `lineTotal` changes. The headers (`subtotal`, `taxTotal`, `total`) were always the paper's and stay.
 * Each write names the values it read, so a line someone saved in between is not touched. Expand only: the
 * previous release reads `lineTotal` as an opaque amount and keeps working. Undoing it, should it ever be
 * needed, is `lineTotal −= taxAmount` on the same lines: nothing else is written.
 */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** The types the import writes, a cash sale aside. */
const TYPES = ['invoice', 'credit_note', 'debit_note']

export type LineKind = 'net' | 'gross' | 'zeroVat' | 'neither'

/** What a stored line's `lineTotal` is, by its own terms. */
export function lineKind(l: { quantity?: unknown; unitPrice?: unknown; discount?: unknown; taxAmount?: unknown; lineTotal?: unknown }): LineKind {
  const tax = round2(num(l.taxAmount))
  if (Math.abs(tax) < 0.01) return 'zeroVat'
  const net = num(l.quantity) * num(l.unitPrice) * (1 - num(l.discount) / 100)
  const total = num(l.lineTotal)
  const toNet = Math.abs(total - net)
  const toGross = Math.abs(total - (net + tax))
  const window = Math.max(Math.abs(tax) / 2, 0.01)
  if (toNet < toGross && toNet <= window) return 'net'
  if (toGross <= toNet && toGross <= window) return 'gross'
  return 'neither'
}

interface OrgCounts {
  documents: number
  converted: number
  gross: number
  zeroVat: number
  neither: number
  /** How many documents hold a line of neither kind, and the first few of them, for the dry run. */
  neitherDocs: number
  neitherIn: string[]
}

interface Plan {
  byOrg: Map<string, OrgCounts>
  /** One update per document with a net line: `$set` of each such line, guarded by what was read. */
  writes: Array<{ filter: Record<string, unknown>; set: Record<string, number> }>
}

const NAMED_PER_ORG = 10

async function plan(db: Db, orgFilter: Record<string, unknown>): Promise<Plan> {
  const byOrg = new Map<string, OrgCounts>()
  const writes: Plan['writes'] = []
  const cursor = db.collection('invoices').find(
    {
      ...orgFilter,
      type: { $in: TYPES },
      $or: [{ tags: 'ocr-import' }, { 'statusHistory.0.reason': 'ocr_import' }],
      'lines.0': { $exists: true },
    },
    { projection: { orgId: 1, invoiceNumber: 1, lines: 1 } },
  )
  for await (const doc of cursor) {
    const key = String(doc.orgId)
    const c: OrgCounts = byOrg.get(key) ?? { documents: 0, converted: 0, gross: 0, zeroVat: 0, neither: 0, neitherDocs: 0, neitherIn: [] }
    byOrg.set(key, c)
    const filter: Record<string, unknown> = { _id: doc._id }
    const set: Record<string, number> = {}
    const lines: any[] = doc.lines ?? []
    const kinds = lines.map(lineKind)
    kinds.forEach((kind, i) => {
      const l = lines[i]
      if (kind === 'net') {
        filter[`lines.${i}.lineTotal`] = l.lineTotal
        filter[`lines.${i}.taxAmount`] = l.taxAmount
        set[`lines.${i}.lineTotal`] = round2(num(l.lineTotal) + num(l.taxAmount))
        c.converted++
      } else if (kind === 'gross') c.gross++
      else if (kind === 'zeroVat') c.zeroVat++
      else c.neither++
    })
    if (kinds.includes('neither')) {
      c.neitherDocs++
      if (c.neitherIn.length < NAMED_PER_ORG) c.neitherIn.push(String(doc.invoiceNumber ?? doc._id))
    }
    if (Object.keys(set).length) {
      c.documents++
      writes.push({ filter, set })
    }
  }
  return { byOrg, writes }
}

/** The orgs' slugs, for the log: `orgId` → slug, the id where an org has none. */
async function slugs(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map(ids.map(id => [id, id]))
  if (!ids.length) return out
  const orgs = await db.collection('orgs').find({}, { projection: { slug: 1 } }).toArray()
  for (const o of orgs) if (out.has(String(o._id)) && o.slug) out.set(String(o._id), String(o.slug))
  return out
}

const summary = (slug: string, c: OrgCounts) =>
  `${slug}: ${c.documents} document(s), ${c.converted} line(s) net → gross; left alone: ${c.gross} already gross, ` +
  `${c.zeroVat} without VAT, ${c.neither} matching neither`

export const importedLineTotalsGross: Migration = {
  id: '0023-imported-line-totals-gross',
  description: "Imported invoices' and notes' lineTotal is gross, as every other document's: add taxAmount to the net lines the document import stored (#598)",
  async preview({ db, orgFilter }: MigrationContext) {
    const { byOrg } = await plan(db, orgFilter)
    const names = await slugs(db, [...byOrg.keys()])
    const lines: string[] = []
    for (const [id, c] of byOrg) {
      lines.push(summary(names.get(id)!, c))
      if (c.neither) lines.push(`${names.get(id)}: lines matching neither, in ${c.neitherIn.join(', ')}${c.neitherDocs > c.neitherIn.length ? ' …' : ''}`)
    }
    return lines.length ? lines : ['nothing to change']
  },
  async up({ db, log, orgFilter }) {
    const invoices = db.collection('invoices')
    const { byOrg, writes } = await plan(db, orgFilter)
    let written = 0
    for (let i = 0; i < writes.length; i += 500) {
      const r = await invoices.bulkWrite(
        writes.slice(i, i + 500).map(w => ({ updateOne: { filter: w.filter, update: { $set: w.set } } })),
        { ordered: false },
      )
      written += r.modifiedCount
    }
    const names = await slugs(db, [...byOrg.keys()])
    let documents = 0
    let converted = 0
    for (const [id, c] of byOrg) {
      documents += c.documents
      converted += c.converted
      log(summary(names.get(id)!, c), {
        orgId: id, documents: c.documents, converted: c.converted, gross: c.gross, zeroVat: c.zeroVat, neither: c.neither,
      })
    }
    log(`imported documents whose net lines now carry gross line totals: ${written} of ${documents} (${converted} line(s))`)
  },
}
