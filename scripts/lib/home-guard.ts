/**
 * Scripts write only where the org's home is (FR-20.4, plan step P0b-6).
 *
 * The write guard in `tenantPlugin` already refuses a Mongoose write to an org homed elsewhere,
 * but a script would learn that half-way through, after its first writes, and its raw driver
 * writes (`Model.collection.*`, `db.collection(...)`) are not guarded at all. So a script checks
 * the home BEFORE it writes:
 * - a script given one org (`--org`) calls `assertScriptHome(org._id)`, which stops it with a
 *   clear message (exit 2) when that org lives elsewhere — a named org is never skipped silently;
 * - a script that walks every org filters the list with `keepHomeOrgs(orgs)`, which drops the
 *   orgs homed elsewhere and says how many it dropped;
 * - a script that sweeps a collection across orgs merges `tenantHomeScope()` into its filter.
 *
 * `unit/scripts-home-guard.test.ts` fails any writing script in `scripts/` that does not import this.
 */
import { assertHomeIsHere, HomeElsewhereError, homeScope, isHomeHere } from '../../packages/db/src/home/home.js'

/** Stop the script unless `orgId`'s home is this node. Fresh read: a move freezes the org first. */
export async function assertScriptHome(orgId: unknown, label?: string): Promise<void> {
  try {
    await assertHomeIsHere(String(orgId), { fresh: true })
  } catch (e) {
    if (e instanceof HomeElsewhereError) {
      console.error(
        `Org ${label ?? String(orgId)} is not homed on this node (${e.message}). ` +
        'Run the script on its home, or move the org back first. Nothing was written.',
      )
      process.exit(2)
    }
    throw e
  }
}

/**
 * The orgs of `orgs` whose home is here. With `named` (the caller asked for these orgs by name), an
 * org homed elsewhere stops the script instead of being skipped.
 */
export async function keepHomeOrgs<T extends { _id: unknown; slug?: string }>(
  orgs: T[],
  opts: { named?: boolean } = {},
): Promise<T[]> {
  const kept: T[] = []
  const skipped: string[] = []
  for (const org of orgs) {
    if (opts.named) {
      await assertScriptHome(org._id, org.slug)
      kept.push(org)
    } else if (await isHomeHere(org._id)) {
      kept.push(org)
    } else {
      skipped.push(org.slug ?? String(org._id))
    }
  }
  if (skipped.length) console.log(`Skipping ${skipped.length} org(s) homed elsewhere: ${skipped.join(', ')}`)
  return kept
}

/**
 * Stop the script unless every org is homed here — for a migration that cannot be split by org
 * (the identity migration links one person's memberships across orgs). On global today, and on any
 * global where no org has moved, this passes.
 */
export async function assertAllOrgsHome(what: string): Promise<void> {
  if (Object.keys(await homeScope()).length) {
    console.error(`${what} runs only while every org is homed on this node, and some org is not. Nothing was written.`)
    process.exit(2)
  }
}

/** A filter fragment for a sweep over tenant data: only the orgs homed here (`{}` on global today). */
export function tenantHomeScope(): Promise<Record<string, unknown>> {
  return homeScope()
}
