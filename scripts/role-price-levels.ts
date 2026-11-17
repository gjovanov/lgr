/**
 * #529 (FR-27.11.B) — set the price levels a built-in role may see, in one org: what the role editor's Products row
 * ("Prices it may see") does, for a sys-admin who does it on the store's behalf. A sys-admin's tool, run on the org's
 * home, and audited (`via: scripts/role-price-levels.ts`).
 *
 *   bun scripts/role-price-levels.ts --org <slug> --roles seller,sales_consultant --show selling,1,2,other            # what it would do
 *   bun scripts/role-price-levels.ts --org <slug> --roles seller,sales_consultant --show selling,1,2,other --execute
 *
 * `--roles` names built-in roles by their template key. `--show` names the levels the roles keep: `selling`,
 * `wholesale`, `0` … `10`, `other`, and `costs` for the cost figures. Every other price level is taken away, and
 * everything else the role holds stays.
 *
 * The save is the editor's own (`role.service#setRoleCapsBySystem`): the implied helpers, the legacy projection, a new
 * version (open tabs read their access again), and the audit row. On an org on `roles` it reaches every pod within a
 * minute and signs nobody out; on the legacy model the people on the role sign in again, and price levels are not
 * enforced there at all, so switch the org first (`scripts/access-model.ts --set roles`).
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, Role, User } from '../packages/db/src/models/index.js'
import { PRICE_CAPS, grantOfRole, withPriceLevels, type CapabilityId } from '../packages/config/src/access/index.js'
import { setRoleCapsBySystem } from '../packages/services/src/biz/access/role.service.js'
import { keepHomeOrgs } from './lib/home-guard.js'

const VIA = 'scripts/role-price-levels.ts'
const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const list = (value: string | undefined) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
const orgSlug = arg('--org')
const roleKeys = list(arg('--roles'))
const levels = list(arg('--show'))
const execute = args.includes('--execute')

const priceCaps = (caps: Iterable<string>) => [...caps].filter(c => PRICE_CAPS.includes(c as CapabilityId)).sort()
const named = (caps: string[]) => (caps.length ? caps.map(c => c.replace(/^products\./, '')).join(', ') : '(none)')

async function main() {
  if (!orgSlug || !roleKeys.length || !args.includes('--show')) {
    throw new Error('--org <slug>, --roles <key,…> and --show <level,…> are required')
  }
  await connectDB({ readOnly: true })
  const [org] = await keepHomeOrgs((await Org.find({ slug: orgSlug }).lean()) as any[], { named: true })
  if (!org) return console.log(`No org with slug "${orgSlug}" is written here`)
  const model = org.settings?.access?.model ?? 'legacy'

  // Everything is checked before anything is written: one role that cannot take the levels stops them all.
  const plans: { role: any; caps: CapabilityId[]; people: number }[] = []
  for (const key of roleKeys) {
    const role: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: key }).lean()
    if (!role) throw new Error(`${org.slug}: no built-in role "${key}"`)
    if (role.all) throw new Error(`${org.slug}: "${key}" is the Administrator role, which sees every price`)
    const current = grantOfRole(role)
    const edit = withPriceLevels(current.all ? [] : current.caps, levels)
    if (edit.unknown.length) throw new Error(`unknown level(s): ${edit.unknown.join(', ')}`)
    if (edit.cameBack.length) {
      const why = edit.cameBack.map(b => `${b.cap} (implied by ${b.from.join(', ')})`).join('; ')
      throw new Error(`${org.slug}: ${role.name} would still see ${why}. Nothing changed.`)
    }
    const people = await User.countDocuments({ orgId: org._id, roleId: role._id, isActive: { $ne: false } })
    plans.push({ role, caps: edit.caps, people })
  }

  console.log(`${execute ? 'EXECUTING' : 'DRY RUN'}: ${org.slug} (access model: ${model})`)
  if (model !== 'roles') console.log(`  ⚠ price levels are enforced on \`roles\` only, and on ${model} the people on these roles sign in again`)
  for (const { role, caps, people } of plans) {
    console.log(`  ${role.name} (${people} active): ${named(priceCaps(grantOfRole(role).all ? PRICE_CAPS : grantOfRole(role).caps))} → ${named(priceCaps(caps))}`)
  }
  if (!execute) return

  for (const { role, caps } of plans) {
    const { after, role: saved } = await setRoleCapsBySystem(String(org._id), String(role._id), caps, VIA)
    console.log(`  ${saved.name}: saved, version ${saved.version}: ${named(priceCaps(after))}`)
  }
}

main()
  .catch((err) => {
    console.error(err?.message ?? err)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
