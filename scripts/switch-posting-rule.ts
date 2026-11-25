#!/usr/bin/env bun
/**
 * FR-25 R3: turns one of a books org's posting rules on or off (§3.7), the accountant's switch over a rule.
 *
 *   bun scripts/switch-posting-rule.ts --org <slug> --code <code> --off             the dry run: the rule, and what it would become
 *   bun scripts/switch-posting-rule.ts --org <slug> --code <code> --off --execute   switches it, with an audit row (--on likewise)
 *
 * A rule that is off is ignored by the shadow posting (`shadow-sales.ts`): a document that needs it for an amount it has
 * waits, counted, except a наложен платеж, which posts as LGR holds it, with nothing paid. The rule is marked the
 * accountant's, and a seed run never turns it back.
 *
 * ⚠ What is already posted changes only when a run covers its day: run scripts/post-shadow-sales.ts over the periods
 * after, dry run first. Writes only on the org's home (FR-20, P0b-6) and connects without building indexes (#546).
 * Idempotent: a rule already as asked is left alone.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AuditLog, Org } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { PostingRulesError, setPostingRuleActive } from '../packages/services/src/biz/accounting-books/posting-rule.service.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'

const SCRIPT = 'scripts/switch-posting-rule.ts'
const FLAGS = new Set(['org', 'code', 'on', 'off', 'execute'])

const argv = process.argv.slice(2)
const args: Record<string, string | boolean> = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i++ } else args[argv[i].slice(2)] = true
}
const slug = typeof args.org === 'string' ? args.org : ''
const code = typeof args.code === 'string' ? args.code : ''
const execute = args.execute === true
const unknown = Object.keys(args).filter(k => !FLAGS.has(k))
const switches = [args.on === true, args.off === true].filter(Boolean).length
if (!slug || !code || switches !== 1 || unknown.length || ['execute', 'on', 'off'].some(k => typeof args[k] === 'string')) {
  console.error(`Usage: bun ${SCRIPT} --org <slug> --code <code> --on|--off [--execute]${unknown.length ? ` (unknown: --${unknown.join(', --')})` : ''}`)
  process.exit(2)
}
const active = args.on === true
const word = (on: boolean) => (on ? 'on' : 'off')

await connectDB({ readOnly: true })
let exit = 1
try {
  const org = await Org.findOne({ slug }).select('_id').lean<{ _id: unknown }>()
  if (!org) {
    console.error(`No org ${slug}.`)
    exit = 2
  } else {
    const orgId = String(org._id)
    await assertScriptHome(orgId, slug)
    if (execute) await requireUniqueIndexes([AuditLog])
    const r = await setPostingRuleActive(orgId, code, active, { execute })
    console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
    console.log(`${r.code}  ${r.label}`)
    console.log(r.wasActive === active ? `already ${word(active)}: nothing to change` : `${word(r.wasActive)} → ${word(active)}`)
    if (r.changed) {
      const audited = await recordAuditEntry({
        orgId, userId: '', via: SCRIPT, action: 'update', module: 'accounting', entityType: 'posting_rule', entityId: r.id,
        entityName: r.code, changes: [{ field: 'isActive', oldValue: r.wasActive, newValue: active }],
      })
      if (!audited) throw new Error('the audit row was not written; the rule itself was switched')
      console.log('switched. What is posted changes only when a run covers its day: run scripts/post-shadow-sales.ts, dry run first.')
    }
    if (!execute && r.wasActive !== active) console.log('\nDry run — nothing written. Re-run with --execute to switch it.')
    exit = 0
  }
} catch (e) {
  if (!(e instanceof PostingRulesError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  exit = 2
} finally {
  await disconnectDB()
}
process.exit(exit)
