#!/usr/bin/env bun
/**
 * FR-25a §3.5: give each contact's МОЛ the search mirror the contact search reads it through (`representativeLower`).
 * The rules are `scripts/lib/contact-representative-mirror.ts`: only the mirror is written, `updatedAt` is left alone,
 * each write is conditional on what the dry run read. Run it once after the release that makes the search read the МОЛ;
 * from that release on the model's plugin keeps the mirror on every write.
 *
 *   bun scripts/backfill-contact-representative-lower.ts [--org <slug>]
 *       the dry run. Counts per org, no names: contacts read, mirrors to write, mirrors to drop.
 *   bun scripts/backfill-contact-representative-lower.ts [--org <slug>] --execute
 *       writes.
 *
 * Without `--org` it walks every org homed on this node and says how many it skipped; a named org homed elsewhere stops
 * it (FR-20, P0b-6). It connects without building indexes (#546), and adds none: the mirror has no index.
 * Idempotent: a second run finds nothing to write.
 *
 * ⚠ After `scripts/backfill-contact-representative.ts` there is nothing more to do: that one writes the mirror with
 * each МОЛ it moves out of the notes. This one is for the МОЛs written before the mirror existed.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { assertScriptHome, keepHomeOrgs } from './lib/home-guard.js'
import { applyMirrorWrites, contactsWithRepresentative, planRepresentativeMirror } from './lib/contact-representative-mirror.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const slugAt = args.indexOf('--org')
const slug = slugAt >= 0 ? args[slugAt + 1] : ''
if (slugAt >= 0 && (!slug || slug.startsWith('--'))) {
  console.error('--org takes a slug. See the header.')
  process.exit(2)
}

// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
try {
  let orgs: any[]
  if (slug) {
    const org: any = await Org.findOne({ slug }).select('slug').lean()
    if (!org) { console.error(`Org "${slug}" not found`); process.exit(1) }
    await assertScriptHome(org._id, slug)
    orgs = [org]
  } else {
    orgs = await keepHomeOrgs(await Org.find({}).select('slug').lean() as any[])
  }
  console.log(`${execute ? 'EXECUTE' : 'DRY-RUN'} — ${orgs.length} org(s)\n`)

  const total = { scanned: 0, set: 0, unset: 0, written: 0 }
  for (const org of orgs) {
    const { ops, counts } = planRepresentativeMirror(await contactsWithRepresentative(org._id))
    total.scanned += counts.scanned
    total.set += counts.set
    total.unset += counts.unset
    if (!ops.length) continue
    const written = execute ? await applyMirrorWrites(ops) : 0
    total.written += written
    console.log(`  ${org.slug}: read ${counts.scanned}, mirror to write ${counts.set}, mirror to drop ${counts.unset}${execute ? `, written ${written}` : ''}`)
  }
  console.log(`\nTotal: read ${total.scanned}, mirror to write ${total.set}, mirror to drop ${total.unset}${execute ? `, written ${total.written}` : ''}`)
  if (!execute) console.log('Dry-run — nothing written. Re-run with --execute.')
  else if (total.written < total.set + total.unset) console.log('The rest changed since the plan read them; the plugin wrote their mirror. A rerun finds nothing.')
} finally {
  await disconnectDB()
}
