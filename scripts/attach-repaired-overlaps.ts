/**
 * Attach the till overlaps repaired by hand to the till day they belong to (FR-21 §11, #343).
 *
 * Before „Към касова продажба…" existed, an invoice that dispatched goods the day's till export had
 * already sold was repaired by hand: its dispatch reversed, then `stockSource.marker` set to the till
 * day's reference (`salesAnalysis:<date>`). The stock is right, but with no `cashSaleRef` every total
 * still counts the sale twice — once on the invoice, once on the day. On 2026-10-28: 83 such invoices
 * (82 in regal-sf, 1 in regal-pz).
 *
 * This attaches each through the button's own service (`attachInvoiceToCashSale`), so it does
 * exactly what the button does: the link, the till's payment, the tax event date. Nothing is reversed
 * again — the service checks that the dispatch is wholly back and refuses otherwise
 * (`attach_needs_attention`), and an invoice it refuses is left as it is and listed.
 *
 *   bun run scripts/attach-repaired-overlaps.ts [--execute] [--org <slug>] [--as <email>]
 *
 * Dry-run by default: for each such invoice, whether its till day is offered (`cashSaleCandidates`)
 * and, if not, why. Writes nothing. Idempotent: an attached invoice carries `cashSaleRef` and is not
 * found again, so a second run attaches nothing.
 *
 * `--as` names the person recorded as having done it (status history + audit log); default is each
 * org's earliest admin.
 *
 * On prod it needs the release that carries #343. ⚠ The pod's filesystem is read-only (2026-10-28):
 * a file cannot be copied into it. Run it on the build host from a checkout at the deployed commit,
 * through a port-forward, with `MONGODB_URI` pointing at it (the field check's way), and from
 * `packages/portal-api`, where the workspace packages resolve:
 *   cp scripts/attach-repaired-overlaps.ts packages/portal-api/.attach.ts
 *   cd packages/portal-api && bun .attach.ts            # then --execute; then rm .attach.ts
 */
// From db, not 'mongoose': portal-api (where this runs on prod) resolves db, not mongoose itself.
import { mongoose } from 'db/connection'
import { assertHomeIsHere, isHomeHere } from 'db/home/home'
import { Invoice, Org, User } from 'db/models'
import { initServiceContext } from 'services/context'
import { CashSaleInvoiceError, attachInvoiceToCashSale, cashSaleCandidates } from 'services/biz/cash-sale-invoice.service'

const EXECUTE = process.argv.includes('--execute')
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const ORG_SLUG = arg('--org')
const AS_EMAIL = arg('--as')?.toLowerCase()

async function actorFor(orgId: any): Promise<{ id: string; firstName?: string; lastName?: string }> {
  const filter: Record<string, any> = { orgId }
  if (AS_EMAIL) filter.email = AS_EMAIL
  else filter.role = 'admin'
  const u: any = await User.findOne(filter).sort({ createdAt: 1 }).select('_id firstName lastName').lean()
  if (!u) throw new Error(AS_EMAIL ? `no user ${AS_EMAIL} in org ${orgId}` : `no admin in org ${orgId}`)
  return { id: String(u._id), firstName: u.firstName, lastName: u.lastName }
}

/**
 * The invoices a hand repair gave back to a till day and nothing has attached: a sales invoice whose
 * stock marker names a till day (`salesAnalysis:<date>`), set by a person, not by R0.
 */
const repaired = (orgId: any) => Invoice.find({
  orgId, type: 'invoice', direction: 'outgoing',
  'stockSource.marker': { $regex: '^salesAnalysis:' },
  'stockSource.detectedBy': { $ne: 'cash_sale' },
  'cashSaleRef.cashSaleId': { $exists: false },
}).select('_id invoiceNumber stockSource.marker').sort({ issueDate: 1, _id: 1 }).lean()

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set')
  // Indexes and collections are the deployed app's business, not this script's.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false })
  const { createMongoRepositories } = await import('dal-mongo')
  initServiceContext(await createMongoRepositories({ backend: 'mongo' }))

  const found: any[] = await Org.find(ORG_SLUG ? { slug: ORG_SLUG } : {}).select('_id slug').lean()
  if (ORG_SLUG && !found.length) throw new Error(`org "${ORG_SLUG}" not found`)
  // FR-20.4: write only where the org's home is. Runs from portal-api in the pod, so it checks the
  // home directly rather than through scripts/lib/home-guard.
  const orgs: any[] = []
  for (const o of found) {
    if (ORG_SLUG) await assertHomeIsHere(String(o._id), { fresh: true })
    else if (!(await isHomeHere(o._id))) { console.log(`skip ${o.slug}: homed elsewhere`); continue }
    orgs.push(o)
  }

  let total = 0
  let attachable = 0
  let attached = 0
  const refusedAll: Record<string, number> = {}
  for (const org of orgs) {
    const orgId = String(org._id)
    const docs: any[] = await repaired(org._id)
    if (!docs.length) continue
    total += docs.length

    // Which of them the button would attach, and to which day: the till day the marker names.
    const plan: Array<{ id: string; number: string; cashSaleId: string; cashSaleNumber: string }> = []
    const why: Record<string, string[]> = {}
    const note = (code: string, number: string) => { (why[code] ||= []).push(number); refusedAll[code] = (refusedAll[code] || 0) + 1 }
    for (const d of docs) {
      const offer = await cashSaleCandidates(orgId, String(d._id))
      if (!offer.eligible) { note(offer.code || 'not_eligible', d.invoiceNumber); continue }
      // The service offers only the day the marker names; one candidate is the expected answer.
      if (offer.candidates.length !== 1) { note(offer.candidates.length ? 'several_candidates' : 'no_candidate', d.invoiceNumber); continue }
      const c = offer.candidates[0]
      plan.push({ id: String(d._id), number: d.invoiceNumber, cashSaleId: c.id, cashSaleNumber: c.number })
    }
    attachable += plan.length
    console.log(`${org.slug}: ${docs.length} repaired overlap(s), ${plan.length} attachable${Object.keys(why).length ? ` — not: ${Object.entries(why).map(([c, ns]) => `${c} ${ns.length} (e.g. ${ns.slice(0, 2).join(', ')})`).join('; ')}` : ''}`)
    if (!EXECUTE || !plan.length) continue

    const actor = await actorFor(org._id)
    let here = 0
    for (const p of plan) {
      try {
        await attachInvoiceToCashSale(orgId, actor, p.id, p.cashSaleId)
        here++
        attached++
      } catch (e: any) {
        // Refused at the attach itself (it changed since the plan, or a dispatch is not wholly back):
        // left as it is, and listed.
        const code = e instanceof CashSaleInvoiceError ? e.code : 'error'
        console.log(`  ${p.number} → ${p.cashSaleNumber}: refused, ${code}: ${e?.message}`)
        refusedAll[code] = (refusedAll[code] || 0) + 1
      }
    }
    // Verify: every one attached here is gone from the list; what is left is what was not attached.
    const left = (await repaired(org._id)).length
    console.log(`  ${here} attached; ${left} left unattached`)
    if (left !== docs.length - here) throw new Error(`${org.slug}: expected ${docs.length - here} left, found ${left}`)
  }
  console.log(`${EXECUTE ? 'ATTACHED' : 'DRY RUN — would attach'} ${EXECUTE ? attached : attachable} of ${total} repaired overlap(s)`
    + `${Object.keys(refusedAll).length ? `; refused: ${JSON.stringify(refusedAll)}` : ''}${EXECUTE ? '' : ' (pass --execute to write)'}`)
  // Audit entries are written fire-and-forget: give the last ones time before disconnecting.
  if (EXECUTE) await new Promise(r => setTimeout(r, 2000))
  await mongoose.disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
