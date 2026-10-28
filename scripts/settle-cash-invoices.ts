/**
 * Settle the invoices paid at the counter that were issued before such an invoice was paid on
 * issue.
 *
 * Until 2026-10 nothing recorded the money a cash invoice was paid with, so every one of them
 * stayed `sent` with its whole total due — on prod 501 (regal-pz 387, regal-sf 114), €35.7k
 * shown as owed in the aging report and in the clients' open balances. This applies the rule the
 * app now runs when it issues an invoice (`services/biz/cash-settlement.service.ts`) to those
 * documents: each gets one payment by its method, dated its issue date, and becomes `paid`.
 *
 * A card sale follows the same rule since FR-22.19 (D-3), so the card invoices issued before that
 * release need the same run: on 2026-10-26, regal-pz 173 (€9,694.72) and regal-sf 195 (€14,082.76).
 * `--method cash|card` limits a run to one method; without it, every method settled on issue
 * (`SETTLED_ON_ISSUE`).
 *
 *   bun run scripts/settle-cash-invoices.ts [--execute] [--org <slug>] [--method cash|card] [--as <email>]
 *
 * Dry-run by default: lists what would be settled and how much, writes nothing. Idempotent: a
 * document paid in full is left alone, so a second run settles nothing.
 *
 * `--as` names the person recorded as having done it (status history + audit log); default is
 * each org's earliest admin.
 *
 * On prod it needs the release that carries cash-settlement.service (and the payments' `origin`
 * field). ⚠ The pod's filesystem is read-only (2026-10-28): a file cannot be copied into it. Run it
 * on the build host from a checkout at the deployed commit, through a port-forward, with
 * `MONGODB_URI` pointing at it (the field check's way), and from `packages/portal-api`, where the
 * workspace packages resolve:
 *   cp scripts/settle-cash-invoices.ts packages/portal-api/.settle.ts
 *   cd packages/portal-api && bun .settle.ts            # then --execute; then rm .settle.ts
 */
// From db, not 'mongoose': portal-api (where this runs on prod) resolves db, not mongoose itself.
import { mongoose } from 'db/connection'
import { assertHomeIsHere, isHomeHere } from 'db/home/home'
import { Invoice, Org, User } from 'db/models'
import { initServiceContext } from 'services/context'
import { syncCashSettlement, SETTLED_ON_ISSUE } from 'services/biz/cash-settlement.service'

const EXECUTE = process.argv.includes('--execute')
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const ORG_SLUG = arg('--org')
const AS_EMAIL = arg('--as')?.toLowerCase()
const METHOD = arg('--method')
const METHODS = METHOD ? [METHOD] : Object.keys(SETTLED_ON_ISSUE)
if (METHODS.some(m => !SETTLED_ON_ISSUE[m])) throw new Error(`--method must be one of: ${Object.keys(SETTLED_ON_ISSUE).join(', ')}`)

/** The states in which an invoice paid at the counter can still show money due. */
const UNSETTLED = ['sent', 'overdue', 'partially_paid']
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

async function actorFor(orgId: any): Promise<string> {
  const filter: Record<string, any> = { orgId }
  if (AS_EMAIL) filter.email = AS_EMAIL
  else filter.role = 'admin'
  const u: any = await User.findOne(filter).sort({ createdAt: 1 }).select('_id email').lean()
  if (!u) throw new Error(AS_EMAIL ? `no user ${AS_EMAIL} in org ${orgId}` : `no admin in org ${orgId}`)
  return String(u._id)
}

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set')
  // Indexes and collections are the deployed app's business, not this script's.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false })
  const { createMongoRepositories } = await import('dal-mongo')
  initServiceContext(await createMongoRepositories({ backend: 'mongo' }))

  const found: any[] = await Org.find(ORG_SLUG ? { slug: ORG_SLUG } : {}).select('_id slug').lean()
  if (ORG_SLUG && !found.length) throw new Error(`org "${ORG_SLUG}" not found`)
  // FR-20.4: settle only where the org's home is. Runs from portal-api in the pod, so it checks the
  // home directly rather than through scripts/lib/home-guard.
  const orgs: any[] = []
  for (const o of found) {
    if (ORG_SLUG) await assertHomeIsHere(String(o._id), { fresh: true })
    else if (!(await isHomeHere(o._id))) { console.log(`skip ${o.slug}: homed elsewhere`); continue }
    orgs.push(o)
  }

  /**
   * This org's invoices paid at the counter that still show money due (a zero-total one is never
   * "due"). An invoice for a cash sale is the cash sale's to settle (#171): the rule skips it.
   */
  async function unsettled(orgId: any) {
    const docs: any[] = await Invoice.find({
      orgId, direction: 'outgoing', type: 'invoice', paymentMethod: { $in: METHODS }, status: { $in: UNSETTLED },
      'cashSaleRef.cashSaleId': { $exists: false },
    }).select('_id invoiceNumber total payments issueDate paymentMethod').sort({ issueDate: 1 }).lean()
    return docs
      .map(d => ({ id: String(d._id), number: d.invoiceNumber, method: d.paymentMethod as string, outstanding: round2(d.total - (d.payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)) }))
      .filter(d => d.outstanding > 0)
  }

  let grandCount = 0
  let grandAmount = 0
  for (const org of orgs) {
    const due = await unsettled(org._id)
    if (!due.length) continue
    const amount = round2(due.reduce((s, d) => s + d.outstanding, 0))
    grandCount += due.length
    grandAmount += amount
    const byMethod = METHODS.map(m => { const ds = due.filter(d => d.method === m); return ds.length ? `${m} ${ds.length} (${round2(ds.reduce((s, d) => s + d.outstanding, 0)).toFixed(2)})` : '' }).filter(Boolean).join(', ')
    console.log(`${org.slug}: ${due.length} invoice(s), ${amount.toFixed(2)} outstanding — ${byMethod} — e.g. ${due.slice(0, 3).map(d => d.number).join(', ')}`)
    if (!EXECUTE) continue

    const actor = await actorFor(org._id)
    const tally: Record<string, number> = {}
    let recorded = 0
    for (const d of due) {
      const res = await syncCashSettlement(String(org._id), d.id, actor)
      tally[res.action] = (tally[res.action] || 0) + 1
      recorded += res.amount
    }
    console.log(`  settled: ${JSON.stringify(tally)}, ${round2(recorded).toFixed(2)} recorded`)
    // Verify: none of this org's counter-paid invoices may still show money due.
    const left = await unsettled(org._id)
    if (left.length) throw new Error(`${org.slug}: ${left.length} invoice(s) still unsettled after the run (${left.slice(0, 3).map(d => d.number).join(', ')})`)
  }
  console.log(`${EXECUTE ? 'SETTLED' : 'DRY RUN — would settle'} ${grandCount} invoice(s), ${round2(grandAmount).toFixed(2)} in total${EXECUTE ? '' : ' (pass --execute to write)'}`)
  // Audit entries are written fire-and-forget; disconnecting at once cut the last one off
  // ("Operation interrupted because client was closed") in the first trial run.
  if (EXECUTE) await new Promise(r => setTimeout(r, 2000))
  await mongoose.disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
