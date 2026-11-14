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

/** The old line, alone on a line of the notes: `МОЛ: <name>`. The same shape `legacyRepresentativeOf` reads. */
const LINE_RE = /^МОЛ: (\S.*)$/

/** What the contact form's "move to the field" does: the field and the notes after it. */
export interface RepresentativeMove {
  /** The name the line held, and the field takes. */
  name: string
  /** The notes without that line, every other line as it was. */
  notes: string
}

/**
 * The move the contact form offers on a contact that still keeps its МОЛ as a notes line (FR-25a §3.5). The backfill
 * moves only notes that are the line and nothing else; a person at the form can take the line out of longer notes,
 * so here it may stand among other lines. Exactly that line leaves the notes, and its name fills the field.
 *
 * Offered only when it is unambiguous and loses nothing; undefined otherwise:
 *  - exactly one line of the notes is `МОЛ: <name>` (two would be two people);
 *  - no note is joined to it (`МОЛ: <name> · <note>`, which the partner import once wrote): a person splits that;
 *  - the field is empty, or already holds that name (then only the line goes). Another name there is a person's call.
 */
export function representativeMoveOf(notes: unknown, representative: unknown): RepresentativeMove | undefined {
  if (typeof notes !== 'string' || !notes.trim()) return undefined
  const lines = notes.split(/\r?\n/)
  const hits = lines.flatMap((line, i) => {
    const m = LINE_RE.exec(line.trim())
    return m ? [{ i, name: m[1].trim() }] : []
  })
  if (hits.length !== 1) return undefined
  const { i, name } = hits[0]
  if (name.includes(' · ')) return undefined
  const held = typeof representative === 'string' ? representative.trim() : ''
  if (held && held !== name) return undefined
  return { name, notes: lines.filter((_, j) => j !== i).join('\n').trim() }
}

/**
 * Whether a contact has a МОЛ already: in its field, or still in its notes as the old line, alone or with a note
 * joined to it. An import fills a blank one only, so it never gives a contact a second.
 */
export function hasRepresentative(contact: { representative?: unknown; notes?: unknown }): boolean {
  if (typeof contact.representative === 'string' && contact.representative.trim()) return true
  return typeof contact.notes === 'string' && /^МОЛ: \S/.test(contact.notes.trim())
}
