/**
 * FR-11 (#21) — configure an org's daily digest from the command line.
 *
 * The settings card in Settings → Organization is the normal way to do this. This script
 * exists for the first setup on an org that already has data (and for prod, where clicking
 * through the UI to set a recipient list is slower than saying it once).
 *
 * ⚠ It also sets `settings.timezone` when asked, because that field — untouched by anything
 * until FR-11 — is what the send hour is interpreted in. An org that never set it would get
 * its digest on UTC's clock, which at regal is 3 hours early in summer.
 *
 * Recipients are given as EMAILS and resolved to userIds, since that is how a human thinks
 * about it; an address with no matching active user is reported and skipped rather than
 * silently dropped.
 *
 * Usage:
 *   bun --env-file=.env scripts/configure-daily-digest.ts --org regal-pz \
 *     --recipients a@x.com,b@y.com [--hour 7] [--timezone Europe/Sofia] [--locale bg]
 *     [--disable] [--execute]
 *
 * Dry-run by default.
 */

import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, User } from '../packages/db/src/models/index.js'

const args = process.argv.slice(2)
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}
const execute = args.includes('--execute')
const disable = args.includes('--disable')

const orgSlug = arg('org')
const recipientsArg = arg('recipients')
const hourArg = arg('hour')
const tzArg = arg('timezone')
const localeArg = arg('locale')

if (!orgSlug) {
  console.error('--org <slug> is required')
  process.exit(1)
}

await connectDB()

const org: any = await Org.findOne({ slug: orgSlug }).lean()
if (!org) {
  console.error(`No org with slug "${orgSlug}"`)
  await disconnectDB()
  process.exit(1)
}

const current = org.settings?.dailyDigest || {}
const emails = (recipientsArg || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

let recipients = current.recipients || []
if (emails.length) {
  const users: any[] = await User.find(
    { orgId: org._id, email: { $in: emails }, isActive: true },
    { email: 1, firstName: 1, lastName: 1, username: 1, role: 1 },
  ).lean()

  const found = new Map(users.map(u => [String(u.email).toLowerCase(), u]))
  const missing = emails.filter(e => !found.has(e))
  if (missing.length) {
    console.error(`\n⚠ No active user in "${orgSlug}" for: ${missing.join(', ')}`)
    console.error('  The digest sends to ORG USERS, so these addresses need an account first.')
  }
  recipients = users.map(u => ({ userId: u._id }))
  for (const u of users) {
    console.log(`  recipient: ${u.email} → ${u.username} [${u.role}]`)
  }
}

const next = {
  enabled: !disable,
  hour: hourArg !== undefined ? Number(hourArg) : (current.hour ?? 7),
  locale: localeArg || current.locale || undefined,
  recipients,
  sections: current.sections || undefined, // undefined ⇒ schema defaults (everything on)
}

const timezone = tzArg || org.settings?.timezone
console.log(`\norg        : ${org.slug} (${org.name})`)
console.log(`timezone   : ${org.settings?.timezone || '(unset)'}${tzArg ? ` → ${tzArg}` : ''}`)
console.log(`enabled    : ${current.enabled ?? false} → ${next.enabled}`)
console.log(`hour       : ${current.hour ?? 7} → ${next.hour}  (${timezone || 'UTC'} local)`)
console.log(`locale     : ${current.locale || org.settings?.locale || 'en'}${localeArg ? ` → ${localeArg}` : ''}`)
console.log(`recipients : ${recipients.length}`)

if (!execute) {
  console.log('\nDRY RUN — re-run with --execute to apply.')
} else {
  const $set: Record<string, any> = { 'settings.dailyDigest': next }
  if (tzArg) $set['settings.timezone'] = tzArg
  await Org.updateOne({ _id: org._id }, { $set })
  console.log('\nApplied.')
  console.log('The scheduler picks it up on its next tick (DIGEST_CHECK_INTERVAL_MS, default 10 min).')
}

await disconnectDB()
