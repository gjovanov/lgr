/**
 * FR-29.12 (#794): what the issue routes left half done before FR-29 slice B. Read-only.
 *
 *   MONGODB_URI=<database> bun run scripts/count-issue-leftovers.ts          # counts per org
 *   MONGODB_URI=<database> bun run scripts/count-issue-leftovers.ts --list   # and which documents
 *
 * Two counts per organization:
 * - **issued with a draft movement**: a document that is no longer a draft (sent, received, paid,
 *   voided…) while a stock movement carrying its id is still a draft. `/send` used to skip such a
 *   draft on a retry ("a movement with this id exists"), so the document was issued with its goods
 *   unmoved; confirmed later from the movements list, they move a second time (FR-29 §1.2).
 * - **draft with a booked movement**: a draft whose id is on a completed movement. An issue that booked
 *   and then failed before its status write left it so; the next Issue now keeps that movement for its
 *   warehouse, and the old one would have skipped every warehouse.
 *
 * A draft that books no stock itself (`stockSource`: made from receipts or stock notes, or for a cash
 * sale) is counted apart: the movements carrying its id may be the ones it was made from.
 *
 * ⚠ The native driver only, no model is loaded, so nothing is created, not even an index. It writes
 * nothing. What it lists names business documents: say the counts in public, the list to the owner.
 */
import { mongoose } from '../packages/db/src/connection.js'

const { MongoClient } = mongoose.mongo
type Db = ReturnType<InstanceType<typeof MongoClient>['db']>

const BOOKED = ['completed', 'confirmed']
const CHUNK = 1000

export interface LeftoverRow { documentId: string; documentNumber: string; status: string; movements: string[] }
export interface OrgLeftovers {
  orgId: string
  slug: string
  issuedWithDraftMovement: LeftoverRow[]
  draftWithBookedMovement: LeftoverRow[]
  /** Drafts with a booked movement that book no stock themselves (`stockSource`): probably what they were made from. */
  draftWithBookedSource: LeftoverRow[]
}

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export async function countIssueLeftovers(db: Db): Promise<OrgLeftovers[]> {
  const invoices = db.collection('invoices')
  const movements = db.collection('stockmovements')
  const byOrg = new Map<string, OrgLeftovers>()
  const of = (orgId: unknown): OrgLeftovers => {
    const key = String(orgId)
    if (!byOrg.has(key)) byOrg.set(key, { orgId: key, slug: '', issuedWithDraftMovement: [], draftWithBookedMovement: [], draftWithBookedSource: [] })
    return byOrg.get(key)!
  }

  // 1. Draft movements that carry a document's id, and their documents that are no longer drafts.
  const draftMovs = await movements
    .find({ status: 'draft', invoiceId: { $exists: true, $ne: null } }, { projection: { orgId: 1, invoiceId: 1, movementNumber: 1 } })
    .toArray()
  const draftMovsOf = new Map<string, string[]>()
  for (const m of draftMovs) {
    const key = String(m.invoiceId)
    draftMovsOf.set(key, [...(draftMovsOf.get(key) ?? []), String(m.movementNumber ?? m._id)])
  }
  for (const ids of chunks([...new Set(draftMovs.map(m => m.invoiceId))])) {
    const docs = await invoices
      .find({ _id: { $in: ids }, status: { $ne: 'draft' } }, { projection: { orgId: 1, status: 1, invoiceNumber: 1 } })
      .toArray()
    for (const d of docs) {
      of(d.orgId).issuedWithDraftMovement.push({
        documentId: String(d._id), documentNumber: String(d.invoiceNumber ?? ''), status: String(d.status), movements: draftMovsOf.get(String(d._id)) ?? [],
      })
    }
  }

  // 2. Drafts, and the booked movements that carry their ids.
  const drafts = await invoices
    .find({ status: 'draft' }, { projection: { orgId: 1, invoiceNumber: 1, 'stockSource.marker': 1 } })
    .toArray()
  const draftById = new Map(drafts.map(d => [String(d._id), d]))
  for (const ids of chunks(drafts.map(d => d._id))) {
    const booked = await movements
      .find({ invoiceId: { $in: ids }, status: { $in: BOOKED } }, { projection: { invoiceId: 1, movementNumber: 1 } })
      .toArray()
    const bookedOf = new Map<string, string[]>()
    for (const m of booked) bookedOf.set(String(m.invoiceId), [...(bookedOf.get(String(m.invoiceId)) ?? []), String(m.movementNumber ?? m._id)])
    for (const [docId, movs] of bookedOf) {
      const d: any = draftById.get(docId)
      const row = { documentId: docId, documentNumber: String(d.invoiceNumber ?? ''), status: 'draft', movements: movs }
      if (d.stockSource?.marker) of(d.orgId).draftWithBookedSource.push(row)
      else of(d.orgId).draftWithBookedMovement.push(row)
    }
  }

  const orgIds = [...byOrg.keys()]
  if (orgIds.length) {
    const orgs = await db.collection('orgs')
      .find({ _id: { $in: orgIds.map(id => new mongoose.mongo.ObjectId(id)) } }, { projection: { slug: 1 } })
      .toArray()
    for (const o of orgs) of(o._id).slug = String(o.slug ?? '')
  }
  return [...byOrg.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

if (import.meta.main) {
  const list = process.argv.includes('--list')
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.error('Set MONGODB_URI to the database to read.')
    process.exit(2)
  }
  const client = await MongoClient.connect(uri)
  try {
    const found = await countIssueLeftovers(client.db())
    if (!found.length) console.log('No organization has an issued document with a draft movement, or a draft with a booked one.')
    for (const o of found) {
      console.log(`${o.slug || o.orgId}: issued with a draft movement ${o.issuedWithDraftMovement.length}, draft with a booked movement ${o.draftWithBookedMovement.length}, draft made from booked movements ${o.draftWithBookedSource.length}`)
      if (!list) continue
      for (const [label, rows] of [['issued with a draft movement', o.issuedWithDraftMovement], ['draft with a booked movement', o.draftWithBookedMovement]] as const) {
        for (const r of rows) console.log(`  ${label}: ${r.documentNumber} (${r.status}) ← ${r.movements.join(', ')}`)
      }
    }
  } finally {
    await client.close()
  }
}
