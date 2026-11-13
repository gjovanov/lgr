/**
 * Daily contacts import DIRECTLY from PlusMinus's own partner directory — no PDF, no OCR, no export.
 *
 * `pull-plusminus-api --families partners` writes `partners.json` into the day folder: the shop's whole analytic
 * partner list with the properties PlusMinus keeps on each (ЕИК, VAT number, address, city, МОЛ, phone). This reads it
 * together with the day's documents and settles, BEFORE the receipts and invoices are booked, the contacts those
 * documents name:
 *
 *   - a sales invoice's customer, a goods receipt's supplier (when it brings stock in);
 *   - found in LGR by the same ЕИК/VAT number, else the same name or another name the contact keeps („Also known as"),
 *     else the same words with other punctuation. A name that a contact with ANOTHER ЕИК holds is left to a person;
 *   - one nobody holds is CREATED with what PlusMinus knows; one somebody holds is only FILLED where it is empty, given
 *     the name the documents use as one of its other names, and widened to `both` when it plays the other role too.
 *
 * Afterwards the receipt importer finds its suppliers (`receive-stock-api.ts`, FR-28.12) and the invoice import finds its
 * customers by name, instead of creating them name-only. The rules are `map-plusminus-partner.ts`, with tests.
 *
 * ⚠ Nothing a person typed in LGR is overwritten, nothing is deleted, no contact is deactivated. The civil number (ЕГН)
 * of a sole trader is never read. A partner with nothing to identify it (no ЕИК, no VAT number, no address) is left to the
 * document import, which still creates it by name when it must.
 *
 * Usage:
 *   bun run scripts/import-contacts-api.ts --dir <day folder with partners.json> --org regal-pz            # plan only
 *   bun run scripts/import-contacts-api.ts --dir <day folder> --org regal-pz --execute                      # write
 *
 * Options:
 *   --dir <dir>        (required) the day folder: partners.json, invoicem_*.json, stokrazp_*.json
 *   --org <slug>       org slug (default: regal-pz)
 *   --api <url>        API base (default: https://lgrai.app)
 *   --all-clients      also settle EVERY `КЛИЕНТИ` entry PlusMinus identifies (a one-off catch-up, not the daily run)
 *   --max-create <n>   refuse to create more than n contacts in one run (default 80; the catch-up needs a larger one)
 *   --execute          create and fill (the default only plans)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signIn } from './lib/lgr-api.js'
import {
  collectPartnerUses, idsOf, planPartnerContacts,
  type ContactBody, type LgrContact, type PartnerDirectory, type PlanItem, type UsedDocument,
} from '../packages/services/src/biz/doc-import/map-plusminus-partner.js'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}
const args = parseArgs(process.argv.slice(2))
const dir = args.dir as string
const orgSlug = (args.org as string) || 'regal-pz'
const api = ((args.api as string) || 'https://lgrai.app').replace(/\/$/, '')
const execute = !!args.execute
const allClients = !!args['all-clients']
const maxCreate = Number(args['max-create'] ?? 80)
if (!dir) { console.error('Required: --dir <day folder with partners.json>. See the header for options.'); process.exit(2) }
if (!Number.isFinite(maxCreate) || maxCreate < 0) { console.error('--max-create must be a number'); process.exit(2) }

/** The day's documents that name a partner: sales invoices and goods receipts. */
function readDocuments(folder: string): UsedDocument[] {
  const out: UsedDocument[] = []
  for (const f of readdirSync(folder)) {
    const m = /^(invoicem|stokrazp)_(\d+)\.json$/i.exec(f)
    if (!m) continue
    const doc = JSON.parse(readFileSync(join(folder, f), 'utf8'))
    out.push({ family: m[1].toLowerCase() as UsedDocument['family'], number: String(doc?.header?.docNumber ?? m[2]), header: { partner: doc?.header?.partner }, lines: doc?.lines })
  }
  return out
}

const money = (s: string | undefined) => (s ? ` ${s}` : '')
function describe(i: PlanItem): string {
  const from = i.docs.length ? `   ← ${[...new Set(i.docs)].slice(0, 3).join(', ')}${i.docs.length > 3 ? ` +${i.docs.length - 3}` : ''}` : ''
  switch (i.kind) {
    case 'create': {
      const b = i.body
      const where = b.addresses?.[0] ? `, ${[b.addresses[0].street, b.addresses[0].city].filter(Boolean).join(', ')}` : ''
      const advice = `${i.nameOnly ? ' [name only: PlusMinus holds nothing else]' : ''}${i.similar?.length ? ` [similar on file: ${i.similar.map((s) => `„${s}"`).join(' | ')}]` : ''}`
      return `  + CREATE ${b.type} „${b.companyName}" (ЕИК ${b.taxId ?? '-'}${money(b.vatNumber)}${where})${b.aliases?.length ? ` also known as ${b.aliases.map((a) => `„${a}"`).join(', ')}` : ''}${advice}${from}`
    }
    case 'update': return `  ~ UPDATE „${i.contactName}" ← „${i.name}" by ${i.by}: ${i.changes.join(', ')}${from}`
    case 'same': return `  = same „${i.contactName}" ← „${i.name}" by ${i.by}`
    case 'ambiguous': return `  ? AMBIGUOUS „${i.name}": ${i.reason}: ${i.candidates.slice(0, 4).map((c) => `„${c}"`).join(' | ')}${from}`
    case 'conflict': return `  ! CONFLICT „${i.name}": ${i.reason} („${i.contactName}")${from}`
    case 'inactive': return `  ! INACTIVE „${i.name}": only the deactivated contact „${i.contactName}" fits${from}`
    case 'skip': return `  - skip „${i.name}": ${({ internal: 'one of the org\'s own stores', correction: 'the КОРЕКЦИЯ placeholder', 'no-data': 'PlusMinus holds nothing that identifies it (left to the document import: a customer is created by name when an invoice needs it)', 'not-in-directory': 'not in the partner directory' })[i.why]}`
  }
}

async function main() {
  console.log(`Contacts from PlusMinus (direct API) | dir: ${dir}`)
  console.log(`Org: ${orgSlug} | API: ${api} | mode: ${execute ? 'EXECUTE' : 'DRY RUN'}${allClients ? ' | scope: the day + every КЛИЕНТИ entry' : ' | scope: the partners the day names'}`)

  const file = join(dir, 'partners.json')
  if (!existsSync(file)) { console.error(`No partners.json in ${dir}: pull it with pull-api.ts --families partners --no-snapshot.`); process.exit(1) }
  const directory: PartnerDirectory = JSON.parse(readFileSync(file, 'utf8'))
  const groups = new Map<string, number>()
  for (const k of Object.keys(directory)) { const g = k.includes(':') ? k.slice(0, k.indexOf(':')) : '(no group)'; groups.set(g, (groups.get(g) ?? 0) + 1) }
  console.log(`Directory: ${Object.keys(directory).length} entries (${[...groups].map(([g, n]) => `${g} ${n}`).join(', ')})`)

  const docs = readDocuments(dir)
  const uses = collectPartnerUses(docs)
  const customers = [...uses.values()].filter((u) => u.roles.has('customer')).length
  const suppliers = [...uses.values()].filter((u) => u.roles.has('supplier')).length
  console.log(`Documents: ${docs.length} (${docs.filter((d) => d.family === 'invoicem').length} invoices, ${docs.filter((d) => d.family === 'stokrazp').length} receipts) name ${uses.size} partner(s): ${customers} as customer, ${suppliers} as supplier`)

  const s = await signIn(api, orgSlug)
  const me = await s.me()
  const ownEik = idsOf(me?.org?.taxNumber, me?.org?.vatNumber)[0]
  console.log(`auth: → org ${orgSlug} (${s.orgId})`)

  const listed = await s.get('/invoicing/contact?size=0&sortBy=createdAt&sortOrder=asc')
  const contacts: LgrContact[] = (listed.contacts ?? listed.items ?? []).map((c: any) => ({
    id: String(c._id ?? c.id), type: c.type, companyName: c.companyName, aliases: c.aliases, isActive: c.isActive,
    taxId: c.taxId, taxNumber: c.taxNumber, vatNumber: c.vatNumber, phone: c.phone, notes: c.notes, representative: c.representative,
    addresses: (c.addresses ?? []).map((a: any) => ({ street: a.street, city: a.city })),
  }))
  console.log(`LGR holds ${contacts.length} contact(s)`)
  console.log()

  const plan = planPartnerContacts({ directory, uses, contacts, ownEik, allClients })
  const order: PlanItem['kind'][] = ['create', 'update', 'ambiguous', 'conflict', 'inactive', 'skip', 'same']
  for (const kind of order) for (const i of plan.items.filter((x) => x.kind === kind)) console.log(describe(i))
  const c = plan.counts
  console.log()
  console.log(`Planned: ${c.create} to create, ${c.update} to update (${c.aliases} other name(s), ${c.roles} role(s), ${c.fills} field(s) to fill), ${c.same} unchanged, ${c.ambiguous} ambiguous, ${c.conflict} conflict(s), ${c.inactive} inactive, ${c.skip} skipped, ${c.merged} merged`)

  if (c.create > maxCreate) {
    console.log(`⚠ ${c.create} contacts to create is more than --max-create ${maxCreate}: nothing is written. Read the list; if it is right, raise --max-create.`)
    process.exitCode = 1
    return
  }
  if (!execute) { console.log('\nDry-run complete — no writes. Re-run with --execute.'); return }

  // Creates first, then the updates; each on its own, so one refusal does not abandon the rest.
  let created = 0, updated = 0, failed = 0
  for (const i of plan.items) {
    if (i.kind !== 'create' && i.kind !== 'update') continue
    try {
      if (i.kind === 'create') {
        const r = await s.post('/invoicing/contact', i.body satisfies ContactBody)
        created++
        console.log(`  ✓ created ${i.body.type} „${i.body.companyName}" → ${r?.contact?._id ?? r?.contact?.id ?? '?'}`)
      } else {
        await s.put(`/invoicing/contact/${i.contactId}`, i.body)
        updated++
        console.log(`  ✓ updated „${i.contactName}": ${i.changes.join(', ')}`)
      }
    } catch (e: any) {
      failed++
      console.log(`  ✗ ${i.kind === 'create' ? `create „${i.body.companyName}"` : `update „${i.contactName}"`}: ${String(e?.message ?? e).slice(0, 240)}`)
    }
  }
  console.log(`\nDone: created ${created} | updated ${updated} | failed ${failed}`)
  if (failed) process.exitCode = 1
}

await main()
