/**
 * FR-29.18 (#794): what was never posted. Read-only.
 *
 *   MONGODB_URI=<database> bun run scripts/report-unposted.ts                 # counts per org
 *   MONGODB_URI=<database> bun run scripts/report-unposted.ts --org <slug>    # one org
 *   MONGODB_URI=<database> bun run scripts/report-unposted.ts --list          # and which documents
 *
 * Before FR-29 slice D a journal entry rode an in-process event: a handler that threw, or a process that stopped
 * between a document's commit and its handler, left the document without its entry and one log line. This lists, per
 * organization that posts each kind, what has none:
 *
 * - **issued documents**: an invoice, a credit or a debit note no longer a draft (and not voided or cancelled), with no
 *   `journalEntryId`. Not a quote, not an invoice for a cash sale: those post nothing. A bill is counted apart, since a
 *   bill received with `/receive` posts no entry by design (FR-29 §10);
 * - **payments**: a payment row with no `journalEntryId`;
 * - **completed movements** of a valued type (receipt, dispatch, return, production) with no `journalEntryId`;
 * - **closed till sessions** with no `journalEntryId`.
 *
 * "Posts" is the rule the postings themselves apply (`services/biz/postings/posting-rules.ts#postsEvent`): the journal
 * the entry goes to is set, and for a movement the inventory accounts.
 *
 * It is dry by default, and has no other mode: it writes nothing. Posting what it lists is the accountant's decision
 * and a separate run. ⚠ The native driver only, no model is loaded, so nothing is created, not even an index. What
 * `--list` prints names business documents: say the counts in public, the list to the owner.
 */
import { mongoose } from '../packages/db/src/connection.js'

const { MongoClient } = mongoose.mongo
type Db = ReturnType<InstanceType<typeof MongoClient>['db']>

const VALUED_MOVEMENT_TYPES = ['dispatch', 'production_out', 'receipt', 'production_in', 'return']
const ISSUED_TYPES = ['invoice', 'credit_note', 'debit_note']
const NOT_ISSUED = ['draft', 'voided', 'cancelled']
const NO_ENTRY = { $in: [null, undefined] as unknown[] }
const LIST_CAP = 500

export interface UnpostedOrg {
  orgId: string
  slug: string
  /** Which kinds this org posts; a kind it does not post is not counted. */
  posts: { documents: boolean; payments: boolean; movements: boolean; sessions: boolean }
  documents: string[]
  bills: string[]
  payments: string[]
  movements: string[]
  sessions: string[]
  /** How many of each, when the lists are capped. */
  counts: { documents: number; bills: number; payments: number; movements: number; sessions: number }
}

export async function reportUnposted(db: Db, opts: { slug?: string } = {}): Promise<UnpostedOrg[]> {
  const orgs = await db.collection('orgs')
    .find(opts.slug ? { slug: opts.slug } : {}, { projection: { slug: 1, 'settings.accounting': 1, 'settings.inventory': 1 } })
    .toArray()
  const out: UnpostedOrg[] = []
  for (const org of orgs) {
    const a = org.settings?.accounting ?? {}
    const inv = org.settings?.inventory ?? {}
    const posts = {
      documents: !!(a.defaultSaleJournalId || a.defaultPurchaseJournalId),
      payments: !!(a.defaultCashJournalId || a.defaultBankJournalId),
      movements: !!(inv.defaultInventoryAccountId && inv.defaultCOGSAccountId),
      sessions: !!a.defaultSaleJournalId,
    }
    if (!posts.documents && !posts.payments && !posts.movements && !posts.sessions) continue
    const orgId = org._id
    const row: UnpostedOrg = {
      orgId: String(orgId), slug: String(org.slug ?? ''), posts,
      documents: [], bills: [], payments: [], movements: [], sessions: [],
      counts: { documents: 0, bills: 0, payments: 0, movements: 0, sessions: 0 },
    }
    const invoices = db.collection('invoices')
    if (posts.documents) {
      const base = {
        orgId, type: { $in: ISSUED_TYPES }, status: { $nin: NOT_ISSUED }, journalEntryId: NO_ENTRY,
        'cashSaleRef.cashSaleId': { $exists: false },
      }
      for (const [key, direction] of [['documents', 'outgoing'], ['bills', 'incoming']] as const) {
        const filter = { ...base, direction }
        row.counts[key] = await invoices.countDocuments(filter)
        row[key] = (await invoices.find(filter, { projection: { invoiceNumber: 1 } }).limit(LIST_CAP).toArray()).map(d => String(d.invoiceNumber ?? d._id))
      }
    }
    if (posts.payments) {
      const unposted = await invoices.aggregate([
        { $match: { orgId, 'payments.0': { $exists: true } } },
        { $unwind: '$payments' },
        { $match: { 'payments.journalEntryId': NO_ENTRY } },
        { $project: { invoiceNumber: 1 } },
      ]).toArray()
      row.counts.payments = unposted.length
      row.payments = unposted.slice(0, LIST_CAP).map(p => String(p.invoiceNumber ?? p._id))
    }
    if (posts.movements) {
      const filter = { orgId, status: 'completed', type: { $in: VALUED_MOVEMENT_TYPES }, journalEntryId: NO_ENTRY, recordOnly: { $ne: true } }
      const movements = db.collection('stockmovements')
      row.counts.movements = await movements.countDocuments(filter)
      row.movements = (await movements.find(filter, { projection: { movementNumber: 1 } }).limit(LIST_CAP).toArray()).map(m => String(m.movementNumber ?? m._id))
    }
    if (posts.sessions) {
      const filter = { orgId, status: 'closed', journalEntryId: NO_ENTRY }
      const sessions = db.collection('possessions')
      row.counts.sessions = await sessions.countDocuments(filter)
      row.sessions = (await sessions.find(filter, { projection: { sessionNumber: 1 } }).limit(LIST_CAP).toArray()).map(s => String(s.sessionNumber ?? s._id))
    }
    out.push(row)
  }
  return out.sort((x, y) => x.slug.localeCompare(y.slug))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const list = args.includes('--list')
  const at = args.indexOf('--org')
  const slug = at >= 0 ? args[at + 1] : undefined
  if (args.includes('--execute') || args.includes('--post')) {
    console.error('This report writes nothing. Posting what it lists is a separate run, the accountant\'s decision.')
    process.exit(2)
  }
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.error('Set MONGODB_URI to the database to read.')
    process.exit(2)
  }
  const client = await MongoClient.connect(uri)
  try {
    const found = await reportUnposted(client.db(), { slug })
    if (!found.length) console.log(slug ? `No organization "${slug}" that posts.` : 'No organization posts journal entries.')
    for (const o of found) {
      const c = o.counts
      console.log(`${o.slug || o.orgId}: documents ${c.documents}, bills ${c.bills}, payments ${c.payments}, movements ${c.movements}, till sessions ${c.sessions}`)
      if (!list) continue
      for (const key of ['documents', 'bills', 'payments', 'movements', 'sessions'] as const) {
        if (o[key].length) console.log(`  ${key}: ${o[key].join(', ')}${c[key] > o[key].length ? ` (and ${c[key] - o[key].length} more)` : ''}`)
      }
    }
  } finally {
    await client.close()
  }
}

