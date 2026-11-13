/**
 * FR-25a: a contact's МОЛ, the person legally responsible for the company, has a field of its own
 * (`Contact.representative`). Before it, every importer kept it as a notes line, `МОЛ: <name>`, and the
 * notes of many contacts still hold exactly that. This is the one rule for reading such a line.
 *
 * Import-pure: the books import, the partner import, the backfill and its tests read it.
 */

/**
 * The name a notes field holds when it is exactly the old line, `МОЛ: <name>`, and nothing else: one line, no
 * second note joined to it (the partner import once wrote `МОЛ: <name> · <note>`). Undefined for any other notes.
 */
export function legacyRepresentativeOf(notes: unknown): string | undefined {
  if (typeof notes !== 'string') return undefined
  const m = /^МОЛ: (\S[^\n]*)$/.exec(notes.trim())
  if (!m) return undefined
  const name = m[1].trim()
  return name && !name.includes(' · ') ? name : undefined
}

/**
 * Whether a contact has a МОЛ already: in its field, or still in its notes as the old line, alone or with a note
 * joined to it. An import fills a blank one only, so it never gives a contact a second.
 */
export function hasRepresentative(contact: { representative?: unknown; notes?: unknown }): boolean {
  if (typeof contact.representative === 'string' && contact.representative.trim()) return true
  return typeof contact.notes === 'string' && /^МОЛ: \S/.test(contact.notes.trim())
}
