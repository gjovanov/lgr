/**
 * One-off migration: fix invoices whose `invoiceNumber` prefix doesn't match their `type`.
 *
 * Background: The invoice grid filter change (Phase 1) now filters by `type`. Any legacy
 * rows where e.g. `type === 'proforma'` but `invoiceNumber` starts with `INV-` will vanish
 * from the proforma list, and any rows where `type === 'invoice'` but the number starts
 * with `PRF-` / `CRN-` / `DBN-` / `CS-` will vanish from the invoices list.
 *
 * This script audits all invoices per org and lists those whose number does not carry the
 * prefix their series renders for that org (`resolveDocPrefix`). It writes nothing: its
 * `--execute` renumbering is retired (#325, see below).
 *
 * Usage:
 *   bun run scripts/migrate-invoice-numbering.ts                    # audit
 *   bun run scripts/migrate-invoice-numbering.ts --org regal        # single org
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'
import { Invoice, Org } from '../packages/db/src/models/index.js'
import { resolveDocPrefix } from '../packages/services/src/biz/invoice-numbering.service.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

/**
 * ⚠ #325: the audit still runs, `--execute` does not. This script predates the shared counters of
 * `sequence-registry.ts`: it drew from a counter per display prefix (`Sequence{prefix:'INV'}`),
 * which nothing else reads, so the numbers it gave could repeat ones the app issues. And an issued
 * number is a legal record (Н-18): a mismatched document is corrected, never renumbered.
 */
if (execute) {
  console.error('migrate-invoice-numbering: --execute is retired (#325). Run it without --execute to audit; correct a mismatched document by hand.')
  process.exit(2)
}

/**
 * The prefix this org renders for the document's series and state (`resolveDocPrefix`: the
 * registry default or the org's override). A draft is numbered in its draft series (`DRF-INV`), a
 * storno in the cash-sale series; a note in its side's series (FR-01).
 */
const expected = new Map<string, string | null>()
async function expectedPrefix(orgId: string, inv: any): Promise<string | null> {
  const variant = inv.status === 'draft' ? 'draft' : 'issued'
  const k = `${orgId}|${inv.type}|${inv.direction}|${variant}`
  if (!expected.has(k)) expected.set(k, await resolveDocPrefix(orgId, inv.type, inv.direction, variant))
  return expected.get(k)!
}

/** Everything before `-YYYY-NNNN`: a prefix may itself hold a dash (`DRF-INV`). */
function currentPrefix(num: string): string {
  const m = String(num || '').match(/^(.+)-\d{4}-\d+$/)
  return m ? m[1] : ''
}

/** Numbers a series no longer gives but its documents keep (FR-01 notes, FR-21's TXN receipts). */
const LEGACY_OK = new Set(['CRN', 'DBN', 'DRF-CN', 'DRF-DN', 'TXN'])

async function main() {
  await connectDB()
  console.log('Mode: AUDIT (read-only)')
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgFilter = orgSlug ? { slug: orgSlug } : {}
  const orgs = await keepHomeOrgs(await Org.find(orgFilter).lean() as any[], { named: !!orgSlug })
  console.log(`Orgs: ${orgs.length}`)

  let totalAudited = 0
  let totalMismatched = 0

  for (const org of orgs) {
    const orgId = String(org._id)
    const invoices = await Invoice.find({ orgId: org._id }, { invoiceNumber: 1, type: 1, direction: 1, status: 1 }).lean()
    totalAudited += invoices.length

    const mismatched: Array<{ inv: any; want: string | null; have: string }> = []
    for (const inv of invoices as any[]) {
      // A keyed cash sale holds `~pending:<key>` until its number is drawn.
      if (String(inv.invoiceNumber || '').startsWith('~pending:')) continue
      const want = await expectedPrefix(orgId, inv)
      const have = currentPrefix(inv.invoiceNumber)
      if (have === want || LEGACY_OK.has(have)) continue
      mismatched.push({ inv, want, have })
    }

    if (mismatched.length === 0) {
      console.log(`  [${org.slug}] ${invoices.length} invoices, 0 mismatches`)
      continue
    }

    console.log(`  [${org.slug}] ${invoices.length} invoices, ${mismatched.length} mismatches:`)
    for (const { inv, want, have } of mismatched) {
      console.log(`    ${inv.invoiceNumber}  type=${inv.type} dir=${inv.direction} status=${inv.status}  have=${have} want=${want}`)
      totalMismatched++
    }
  }

  console.log('')
  console.log(`Summary: audited=${totalAudited} mismatched=${totalMismatched}`)

  await disconnectDB()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
