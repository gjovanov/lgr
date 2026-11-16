#!/usr/bin/env bun
/**
 * Test copies of real orgs: `test-regal-pz` and `test-regal-sf` are `regal-pz` and `regal-sf` with
 * their data, where nothing can print a fiscal receipt, mail a customer or move a real shelf.
 * The engine is `packages/services/src/biz/org-clone`; read its header for what a copy holds and
 * what it never does. This is its command line, and the daily job's (`k8s` CronJob in lgr-deploy).
 *
 *   bun scripts/org-clone.ts status --pairs regal-pz:test-regal-pz,regal-sf:test-regal-sf
 *       counts per collection, real org against its copy
 *
 *   bun scripts/org-clone.ts leaks --pairs regal-pz:test-regal-pz,regal-sf:test-regal-sf
 *       READ-ONLY. Does any document of a copy still name an id of its real org (the org's own, or any
 *       document it holds)? Counts per collection and the copy's own document ids, never the real org's.
 *       Exit 1 if any does. It walks every collection on its own rule, not the engine's: run it on the real
 *       copies after a change to the rewrite (`remap.ts`), a new model with an `orgId`, or a doubt.
 *       For a real org that keeps a company's books (FR-25 R7) it also looks for a copy of any row of
 *       them in the test org, which the first check cannot see (a copy names nothing of the real org).
 *
 *   bun scripts/org-clone.ts mark   --org regal-pz --env prod [--execute]
 *       the PROD / DEV badge beside an org's name (`settings.environment`)
 *
 *   bun scripts/org-clone.ts create --source regal-sf --target test-regal-sf --name "Test Regal SF OOD" [--execute]
 *       a new, empty test org with the real one's identity and settings (marked dev)
 *
 *   bun scripts/org-clone.ts convert --org regal --to test-regal-pz --name "Test Regal PZ OOD" --source regal-pz [--execute]
 *       an EXISTING org becomes a test copy: renamed, marked dev, digest and backup off, the
 *       company's identity from the real org. Its other settings, people and devices are kept.
 *
 *   bun scripts/org-clone.ts reset  --org test-regal-pz [--no-bundle] [--execute]
 *       empties a dev org of its data before the first copy. Keeps its people, permission sets,
 *       invites, desktops and fiscal devices. Takes a backup bundle of the org first unless told not to.
 *
 *   bun scripts/org-clone.ts sync --pairs regal-pz:test-regal-pz,regal-sf:test-regal-sf [--execute]
 *   bun scripts/org-clone.ts sync --source regal-pz --target test-regal-pz [--execute]
 *       brings each copy up to date: inserts what is new, rewrites what changed, leaves what only the
 *       copy holds. Safe to run any number of times. The daily job runs exactly this.
 *       --insert-only        add what is missing; never touch a document the copy holds
 *       --activate-admins    the FIRST copy only: admin memberships keep their access to the copy
 *       --relink-hardware pz after a reset: point kept fiscal devices at the copy's warehouse with this code
 *       --only Product,Invoice  limit to these models
 *       --json               the whole report as JSON on stdout (logs go to stderr)
 *
 * Everything writes only with --execute; without it the run reads and compares and says what it would do.
 * The pairs may also come from ORG_SYNC_PAIRS. Exit code 1 if anything failed; 0 otherwise (conflicts are reported, not failures).
 */
import { connectDB, disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'
import {
  OrgCloneError,
  cloneOrgData,
  compareOrgs,
  convertToTestOrg,
  createTestOrgFrom,
  markOrgEnvironment,
  resetOrgData,
  scanCopyForBooks,
  scanCopyForLeaks,
  type CloneReport,
} from '../packages/services/src/biz/org-clone/clone.service.js'
import { BOOKS_NEVER_CLONED, keepsBooks } from '../packages/services/src/biz/org-clone/policy.js'
import { buildBundle, verifyBundle } from '../packages/services/src/biz/backup/backup-bundle.service.js'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name: string) => argv.includes(`--${name}`)
function value(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}
const execute = flag('execute')
const asJson = flag('json')
/** Progress goes to stderr so `--json` leaves stdout for the report alone. */
const say = (m: string) => console.error(m)
const out = (m: string) => (asJson ? console.error(m) : console.log(m))

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

function pairs(): { source: string; target: string }[] {
  const raw = value('pairs') ?? process.env.ORG_SYNC_PAIRS ?? ''
  const fromPairs = raw.split(',').map(s => s.trim()).filter(Boolean).map(p => {
    const [source, target] = p.split(':').map(s => s.trim())
    if (!source || !target) fail(`not a source:target pair: ${p}`)
    return { source, target }
  })
  const source = value('source')
  const target = value('target')
  if (source || target) {
    if (!source || !target) fail('--source and --target go together')
    fromPairs.push({ source, target })
  }
  if (!fromPairs.length) fail('give --pairs a:b,c:d (or --source and --target, or ORG_SYNC_PAIRS)')
  return fromPairs
}

/** Thrown, not exited: one pair that names a missing org must not stop the pairs after it. */
async function orgBySlug(slug: string): Promise<any> {
  const org: any = await Org.collection.findOne({ slug })
  if (!org) throw new OrgCloneError('no_such_org', `no org with slug "${slug}"`)
  return org
}

function printReport(report: CloneReport) {
  const would = report.execute ? '' : ' (would)'
  out(`\n${report.source.slug} -> ${report.target.slug}${report.execute ? '' : '   DRY RUN: nothing was written'}  [${(report.durationMs / 1000).toFixed(1)} s]`)
  out('model'.padEnd(24) + 'read'.padStart(8) + `inserted${would}`.padStart(19) + `updated${would}`.padStart(18) + 'same'.padStart(8) + 'merged'.padStart(8) + 'clash'.padStart(7))
  for (const c of report.collections) {
    if (!c.scanned && !c.errors.length) continue
    out(c.model.padEnd(24) + String(c.scanned).padStart(8) + String(c.inserted).padStart(19) + String(c.updated).padStart(18) + String(c.unchanged).padStart(8) + String(c.merged).padStart(8) + String(c.conflicts).padStart(7))
    for (const s of c.conflictSamples) out(`    clash: ${s}`)
    for (const e of c.errors) out(`    ERROR: ${e}`)
  }
  const t = report.totals
  out(`total: ${t.scanned} read, ${t.inserted} inserted, ${t.updated} updated, ${t.unchanged} unchanged, ${t.merged} already there, ${t.conflicts} clashes, ${t.errors} errors`)
  if (report.notCloned.length) out(`not copied, by design: ${report.notCloned.map(n => `${n.model} (${n.rows})`).join(', ')}`)
  for (const w of report.warnings) out(`warning: ${w}`)
}

async function main(): Promise<number> {
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  await connectDB({ readOnly: true })

  if (command === 'status') {
    for (const p of pairs()) {
      const [s, t] = [await orgBySlug(p.source), await orgBySlug(p.target)]
      out(`\n${p.source} (${s.settings?.environment ?? 'unmarked'}) vs ${p.target} (${t.settings?.environment ?? 'unmarked'})`)
      out('model'.padEnd(24) + 'real'.padStart(10) + 'copy'.padStart(10))
      for (const r of await compareOrgs(String(s._id), String(t._id))) out(r.model.padEnd(24) + String(r.source).padStart(10) + String(r.target).padStart(10) + (r.target < r.source ? '   <- behind' : ''))
      if (keepsBooks(s)) {
        // Never copied: the copy's count is what the test org keeps of its own. `leaks` says whether any is a copy.
        out(`the company's books (${p.source} keeps them), never copied:`)
        for (const name of Object.keys(BOOKS_NEVER_CLONED)) {
          const coll = mongoose.models[name]!.collection
          const [real, copy] = await Promise.all([coll.countDocuments({ orgId: s._id }), coll.countDocuments({ orgId: t._id })])
          if (real || copy) out(name.padEnd(24) + String(real).padStart(10) + String(copy).padStart(10))
        }
      }
    }
    return 0
  }

  if (command === 'leaks') {
    let leaking = 0
    let failed = 0
    for (const p of pairs()) {
      try {
        const [s, t] = [await orgBySlug(p.source), await orgBySlug(p.target)]
        out('')
        out(`${p.source} (${s.settings?.environment ?? 'unmarked'}) vs ${p.target} (${t.settings?.environment ?? 'unmarked'})`)
        const scan = await scanCopyForLeaks(String(s._id), String(t._id))
        out(`${scan.copyDocs} documents of the copy read against ${scan.sourceIds} ids of the real org: ${scan.leaking} name one`)
        for (const [collection, n] of Object.entries(scan.byCollection)) out(`    ${collection}: ${n}   (copy documents ${scan.samples[collection]!.join(', ')})`)
        leaking += scan.leaking
        const books = await scanCopyForBooks(String(s._id), String(t._id))
        if (books.keepsBooks) {
          const copied = Object.values(books.copied).reduce((a, b) => a + b, 0)
          out(`the company's books: ${books.checked} rows of the real org looked for in the copy: ${copied} copied`)
          for (const [model, n] of Object.entries(books.copied)) out(`    ${model}: ${n}`)
          leaking += copied
        }
      } catch (e: any) {
        failed++
        console.error(`${p.source} -> ${p.target}: ${e instanceof OrgCloneError ? `[${e.code}] ` : ''}${e?.message ?? e}`)
      }
    }
    out(leaking ? 'LEAKS FOUND' : failed ? 'NOT CHECKED' : 'NO LEAKS')
    return leaking || failed ? 1 : 0
  }

  if (command === 'mark') {
    const slug = value('org') ?? fail('--org <slug>')
    const env = value('env')
    if (env !== 'prod' && env !== 'dev') fail('--env prod|dev')
    const org = await orgBySlug(slug)
    await assertScriptHome(org._id, slug)
    await markOrgEnvironment({ orgId: String(org._id), expectSlug: slug, environment: env, execute })
    out(`${slug}: environment ${org.settings?.environment ?? 'unmarked'} -> ${env}${execute ? '' : '   (dry run)'}`)
    return 0
  }

  if (command === 'create') {
    const source = await orgBySlug(value('source') ?? fail('--source <slug>'))
    await assertScriptHome(source._id, source.slug)
    const made = await createTestOrgFrom({
      sourceOrgId: String(source._id),
      slug: value('target') ?? fail('--target <slug>'),
      name: value('name') ?? fail('--name "<org name>"'),
      execute,
      log: say,
    })
    out(`${value('target')}: ${made.created ? (execute ? 'created' : 'would be created') : 'already exists'}  ${made.orgId}`)
    return 0
  }

  if (command === 'convert') {
    const slug = value('org') ?? fail('--org <slug>')
    const org = await orgBySlug(slug)
    const source = await orgBySlug(value('source') ?? fail('--source <slug>'))
    await assertScriptHome(org._id, slug)
    await assertScriptHome(source._id, source.slug)
    const { changes } = await convertToTestOrg({
      orgId: String(org._id),
      expectSlug: slug,
      newSlug: value('to') ?? fail('--to <new slug>'),
      newName: value('name') ?? fail('--name "<new name>"'),
      sourceOrgId: String(source._id),
      execute,
      log: say,
    })
    out(`${execute ? 'changed' : 'would change'}: ${Object.keys(changes).join(', ')}`)
    return 0
  }

  if (command === 'reset') {
    const slug = value('org') ?? fail('--org <slug>')
    const org = await orgBySlug(slug)
    await assertScriptHome(org._id, slug)
    if (execute) {
      if (!flag('no-bundle')) {
        // The way back: a verified bundle of everything about to go.
        const date = new Date().toISOString().slice(0, 10)
        const bundle = await buildBundle(String(org._id), { kind: 'full', date, subdir: 'pre-test-org-reset', filenameSuffix: 'pre-reset' })
        const verified = await verifyBundle(bundle.absolutePath, bundle.sha256)
        if (!verified.ok) fail(`the pre-reset bundle did not verify (${verified.problems.slice(0, 2).join('; ')}): nothing was deleted`)
        out(`backup bundle: ${bundle.absolutePath}  (${bundle.manifest.documentCount} documents, sha256 ${bundle.sha256.slice(0, 12)})`)
      }
    }
    const report = await resetOrgData({ orgId: String(org._id), expectSlug: slug, execute, log: say })
    out(`\n${slug}: ${execute ? 'deleted' : 'would delete'} ${Object.values(report.deleted).reduce((a, b) => a + b, 0)} documents in ${Object.keys(report.deleted).length} collections`)
    out(`kept: ${Object.entries(report.kept).map(([m, n]) => `${m} (${n})`).join(', ') || 'nothing'}`)
    return 0
  }

  if (command === 'sync') {
    let failures = 0
    const reports: CloneReport[] = []
    for (const p of pairs()) {
      try {
        const [s, t] = [await orgBySlug(p.source), await orgBySlug(p.target)]
        await assertScriptHome(s._id, p.source)
        await assertScriptHome(t._id, p.target)
        if (execute) {
          // The unique index of every model this pair will INSERT into is the safety net against a duplicate, and
          // the deployed app is what builds it. Only the models the real org holds rows of are asked for: an index
          // the app never managed to build on a model with no rows here (production's leave balances, 2026-11-10:
          // a schema index it could not build over the old data) must not stop the copy of a shop that has none.
          const only = value('only')?.split(',').map(x => x.trim()).filter(Boolean)
          const holding = (await compareOrgs(String(s._id), String(t._id))).filter(r => r.source > 0 && (!only?.length || only.includes(r.model)))
          await requireUniqueIndexes(holding.map(r => mongoose.models[r.model]!))
        }
        const report = await cloneOrgData({
          sourceOrgId: String(s._id),
          targetOrgId: String(t._id),
          execute,
          insertOnly: flag('insert-only'),
          activateAdmins: flag('activate-admins'),
          relinkHardwareTo: value('relink-hardware'),
          only: value('only')?.split(',').map(x => x.trim()).filter(Boolean),
          log: say,
        })
        reports.push(report)
        printReport(report)
        if (report.totals.errors) failures++
      } catch (e: any) {
        failures++
        console.error(`${p.source} -> ${p.target}: ${e instanceof OrgCloneError ? `[${e.code}] ` : ''}${e?.message ?? e}`)
      }
    }
    if (asJson) console.log(JSON.stringify(reports, null, 2))
    return failures ? 1 : 0
  }

  return fail('commands: status | leaks | mark | create | convert | reset | sync   (see the header of scripts/org-clone.ts)', 2)
}

let code = 1
try {
  code = await main()
} catch (e: any) {
  console.error(`${e instanceof OrgCloneError ? `[${e.code}] ` : ''}${e?.message ?? e}`)
} finally {
  await disconnectDB().catch(() => {})
}
process.exit(code)
