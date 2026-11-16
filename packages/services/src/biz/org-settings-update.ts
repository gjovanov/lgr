/**
 * What a save of an org's settings writes (`PUT /org/:orgId`): one path for each value sent, never a block.
 *
 * ⚠ A block written whole takes with it every key of the block the caller did not name. The Organization page sends,
 * of the tax block, whether VAT is on and its rates. Written as a block, each save removed the org's default VAT rate
 * and its tax number's label. The same went for the inventory block (whether stock entries post, and the accounts
 * they post to) and for the digest's sections the page does not list (Backups, which an operator turns on).
 * Nothing said so: the model's defaults fill a missing key on the next read through mongoose, so the org read like one
 * that had never set it, and the default rate of an org on 18 % read as 20.
 *
 * So every value goes to its own path, and what a save does not name stays as it is stored:
 *
 * - a list (VAT rates, digest recipients, modules) is a value: one sent replaces the stored one;
 * - a block sent empty names nothing, and writes nothing;
 * - a path of `CLEARED_WHEN_EMPTY` sent as `''` is removed, so the org reads like one that never set it;
 * - a key that could not be a setting's name (empty, holding a `.`, or starting with `$`) is not written. Only the
 *   digest's sections take free keys (the route's body lists every other key), and a path built from such a key
 *   would name another setting, or be read by the database as an operator.
 *
 * Import-pure: no models, no database.
 */

/** Paths a save clears by sending them empty. The digest's own language: empty is "use the org's". */
const CLEARED_WHEN_EMPTY: ReadonlySet<string> = new Set(['settings.dailyDigest.locale'])

/** A block of settings, as a request's JSON holds one: not a list, and not a value such as a date or an id. */
function isBlock(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const isName = (key: string) => key !== '' && !key.includes('.') && !key.startsWith('$')

export interface OrgSettingsUpdate {
  /** Dotted path → the value to store there. */
  set: Record<string, unknown>
  /** Dotted paths to remove. */
  unset: string[]
}

/** The update a `settings` object of a request body asks for. Anything that is not a block of settings asks for none. */
export function orgSettingsUpdate(settings: unknown): OrgSettingsUpdate {
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  const walk = (value: unknown, path: string) => {
    if (isBlock(value)) {
      for (const [key, inner] of Object.entries(value)) if (isName(key)) walk(inner, `${path}.${key}`)
      return
    }
    // Not given.
    if (value === undefined || value === null) return
    if (value === '' && CLEARED_WHEN_EMPTY.has(path)) unset.push(path)
    else set[path] = value
  }
  if (isBlock(settings)) walk(settings, 'settings')
  return { set, unset }
}
