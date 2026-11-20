#!/usr/bin/env bun
/**
 * FR-25 R3, slice 3: the posting rules of one org that keeps books (§3.7), the patterns of §1.4 for its own sales
 * invoices, debit and credit notices. What they are: `packages/services/src/biz/accounting-books/posting-rule-seed.ts`.
 *
 *   bun scripts/seed-posting-rules.ts --org <slug>             the dry run: how many it would add, how many it has
 *   bun scripts/seed-posting-rules.ts --org <slug> --execute   adds them, and one audit row when it did
 *
 * ⚠ Adds only the rules the org lacks, by code, and never changes one it has: a rule the accountant changed or turned
 * off stays. Refuses an org whose chart or analytic tree lacks an account or root the rules name. Writes only on the
 * org's home (FR-20, P0b-6), connects without building indexes (#546), and refuses to write without the unique index of
 * what it writes. Idempotent: a second run adds nothing.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AuditLog, Org, PostingRule } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { PostingRulesError, seedPostingRules } from '../packages/services/src/biz/accounting-books/posting-rule.service.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'

const SCRIPT = 'scripts/seed-posting-rules.ts'
const FLAGS = new Set(['org', 'execute'])

const argv = process.argv.slice(2)
const args: Record<string, string | boolean> = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i++ } else args[argv[i].slice(2)] = true
}
const slug = typeof args.org === 'string' ? args.org : ''
const execute = args.execute === true
const unknown = Object.keys(args).filter(k => !FLAGS.has(k))
if (!slug || unknown.length || typeof args.execute === 'string') {
  console.error(`Usage: bun ${SCRIPT} --org <slug> [--execute]${unknown.length ? ` (unknown: --${unknown.join(', --')})` : ''}`)
  process.exit(2)
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await Org.findOne({ slug }).select('_id').lean<{ _id: unknown }>()
  if (!org) {
    console.error(`No org ${slug}.`)
    code = 2
  } else {
    const orgId = String(org._id)
    await assertScriptHome(orgId, slug)
    if (execute) await requireUniqueIndexes([PostingRule, AuditLog])
    const r = await seedPostingRules(orgId, { execute })
    console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
    console.log(`${String(r.rules).padStart(7)}  posting rules this slice seeds`)
    console.log(`${String(r.kept).padStart(7)}  the org holds already, left as they are`)
    console.log(`${String(r.create).padStart(7)}  to add`)
    if (r.written !== undefined) console.log(`${String(r.written).padStart(7)}  added`)
    if (r.written) {
      const audited = await recordAuditEntry({
        orgId, userId: '', via: SCRIPT, action: 'create', module: 'accounting', entityType: 'posting_rule', entityId: orgId,
        entityName: `posting rules seeded (${SCRIPT})`,
        changes: [{ field: 'added', oldValue: null, newValue: r.written }],
      })
      if (!audited) throw new Error('the audit row of the run was not written; the rules themselves were')
    }
    if (!execute) console.log('\nDry run — nothing written. Re-run with --execute to add them.')
    code = 0
  }
} catch (e) {
  if (!(e instanceof PostingRulesError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
