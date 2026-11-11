/**
 * A contact's other names („Also known as", FR-28.12): the names a company is written under on documents besides
 * its own. A short form the staff use („REYHER" for „F.REYHER Nchfg.GMBH"), the spelling another list keeps it by,
 * a name before a rename. A rule must not guess that two such names are one company; a person says so here, once,
 * and every import that looks a contact up by name then takes the other name for that contact.
 *
 * Import-pure, and shared by the contact form (`ui-shared/composables/contact-payload`) and the API
 * (`invoicing-api/controllers/contact.controller`), so both store the same thing for the same typing.
 */

/** The most other names one contact keeps. */
export const MAX_CONTACT_ALIASES = 50
/** The longest one. */
export const MAX_CONTACT_ALIAS_LENGTH = 200

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Case folded the way the `*Lower` mirrors are (`bg` locale), so „Севан" and „СЕВАН" are one name. */
const keyOf = (s: unknown) => tidy(String(s ?? '')).toLocaleLowerCase('bg')

/**
 * The names as they are stored: each trimmed, its runs of whitespace collapsed to one space; none empty; none
 * twice, whatever its case; and none that is the contact's own name (`ownName`), which would say nothing. The
 * order a person gave is kept. Anything that is not a list of strings gives an empty list.
 */
export function cleanContactAliases(list: unknown, ownName?: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>(['', keyOf(ownName)])
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const name = tidy(raw)
    const key = keyOf(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** False when a cleaned list cannot be saved: too many names, or one too long. The form says so before the API does. */
export function contactAliasesFit(list: readonly string[]): boolean {
  return list.length <= MAX_CONTACT_ALIASES && list.every((a) => a.length <= MAX_CONTACT_ALIAS_LENGTH)
}
