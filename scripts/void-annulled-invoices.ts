#!/usr/bin/env bun
/**
 * Mark invoices that PlusMinus ANNULLED as `voided` in LGR, when the API's own void will not (it refuses a
 * `paid` / `partially_paid` / `overdue` invoice). See `scripts/lib/void-annulled.ts` for the why and for
 * exactly what changes: status, `voidedAt`, one history entry, one AuditLog row. Stock is NOT reversed.
 *
 * Found by `audit-coverage-api.ts` ("annulled-but-live"): the pulled `invoicem_<n>.fea.json` is a `-ФЕА`
 * document with the invoice's own number and negated amounts. Check that file (and what replaced the
 * invoice) before naming a number here: this does not look at PlusMinus.
 *
 *   bun scripts/void-annulled-invoices.ts --org regal-pz --only 3000200001,3000200003
 *       the dry run: for each number, the invoice, its stock movements, and every reason it would refuse.
 *   bun scripts/void-annulled-invoices.ts --org regal-pz --only 3000200001,3000200003 \
 *       --execute --expect 2 [--backup <file.ndjson>] [--as <userId>] [--reason "<text>"]
 *
 * It refuses, and on --execute then writes nothing at all if ANY named number is refused:
 * - a number LGR does not hold as exactly one outgoing `invoice` (a credit note is a valid document);
 * - a draft / sent / received invoice: POST /invoices/:id/void does that properly, stock included;
 * - an invoice that a live credit note already cancels (voiding it too would cancel it twice);
 * - `--execute` without `--expect`, or with a count that is not the dry run's;
 * - any node that is not the org's home (FR-20, P0b-6).
 * An invoice that is already voided is reported and skipped.
 *
 * Before the first write every document it will touch goes to an NDJSON backup. The update is
 * conditional on the status the dry run saw, and each result is read back.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Invoice, Org } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { applyVoid, planVoid, type VoidPlan } from './lib/void-annulled.js'

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
const orgSlug = String(args.org || 'regal-pz')
const execute = !!args.execute
const only = args.only ? String(args.only).split(',').map(s => s.trim()).filter(Boolean) : []
const reason = String(args.reason || 'annulled in PlusMinus (-ФЕА); marked voided by scripts/void-annulled-invoices.ts, stock left as the snapshot true-up settled it')

if (!only.length) { console.error('Required: --only <PlusMinus invoice numbers>, comma separated. See the header.'); process.exit(2) }

const fmt = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : '?')

function show(p: VoidPlan) {
  if (!p.invoice) { console.log(`✗ ${p.number}: ${p.reason}`); return }
  const i = p.invoice
  const head = `${i.invoiceNumber} [${i.status}] ${fmt(i.issueDate)} · total ${i.total} ${i.currency ?? ''}, paid ${i.amountPaid}`
  if (p.already) { console.log(`· ${p.number}: ${head} — already voided, skipped`); return }
  if (!p.ok) { console.log(`✗ ${p.number}: ${head}\n     refused: ${p.reason}`); return }
  const mv = (p.movements ?? []).map(m => `${m.number} ${m.type} ${m.status} Σ${m.quantity}`).join('; ') || 'none'
  console.log(`✓ ${p.number}: ${head}\n     stock movements (left as they are): ${mv}`)
}

await connectDB()
try {
  const org: any = await Org.findOne({ slug: orgSlug }).lean()
  if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
  await assertScriptHome(org._id, orgSlug)
  console.log(`Org ${orgSlug} (${org._id}) — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const plans: VoidPlan[] = []
  for (const n of only) plans.push(await planVoid(org._id, n))
  plans.forEach(show)

  const todo = plans.filter(p => p.ok)
  const already = plans.filter(p => p.already)
  const refused = plans.filter(p => !p.ok && !p.already)
  console.log(`\n${execute ? 'Plan' : 'Would void'}: ${todo.length} | already voided: ${already.length} | refused: ${refused.length}`)

  if (!execute) {
    console.log(`Dry-run — nothing written. Re-run with --execute --expect ${todo.length}.`)
  } else {
    if (refused.length) { console.error('Refused: a named number cannot be voided, so nothing was written.'); process.exit(2) }
    if (Number(args.expect) !== todo.length) { console.error(`Refused: --expect must be ${todo.length} (the dry run's count), got ${String(args.expect)}.`); process.exit(2) }
    if (!todo.length) { console.log('Nothing to do.') } else {
      const by = String(args.as || org.ownerId || '')
      if (!by) { console.error('Refused: no user to record the void under (--as <userId>, or an org owner).'); process.exit(2) }
      const backup = String(args.backup || join(tmpdir(), `void-annulled-${orgSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`))
      writeFileSync(backup, `${JSON.stringify({ kind: 'header', script: 'void-annulled-invoices', org: orgSlug, at: new Date(), reason })}\n`)
      for (const p of todo) appendFileSync(backup, `${JSON.stringify({ collection: 'invoices', doc: await Invoice.findById(p.invoice!.id).lean().exec() })}\n`)
      console.log(`Backup: ${backup}`)

      let failed = 0
      for (const p of todo) {
        const done = await applyVoid(org._id, p, by, reason)
        const after: any = await Invoice.findById(p.invoice!.id).lean().exec()
        const ok = done && after?.status === 'voided'
        console.log(`${ok ? '✓' : '✗ FAILED'} ${p.invoice!.invoiceNumber}: now ${after?.status}`)
        if (!ok) failed++
      }
      console.log(`\nVoided: ${todo.length - failed} | failed: ${failed}`)
      if (failed) process.exitCode = 1
    }
  }
} finally {
  await disconnectDB()
}
