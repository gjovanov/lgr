/**
 * FR-25a: a contact's МОЛ moves out of its notes into `Contact.representative`.
 *
 * Every importer kept it as a notes line, `МОЛ: <name>` (the books import, the partner import, `seed-contacts`), because
 * the contact had no field for it. What this moves is a notes field that is EXACTLY that line
 * (`config/contact-representative#legacyRepresentativeOf`); anything else in the notes is somebody's, and is left:
 *
 *   - `move`: no representative yet. It takes the name, and the notes line goes.
 *   - `clear`: the representative is already that name (a newer importer filled it). Only the notes line goes.
 *   - `conflict`: the representative names someone else. Both stay, for a person to look at.
 *
 * Each write is conditional on what the plan read (the same notes, the same representative), so a contact edited
 * between the dry run and the run is skipped, never overwritten. Nothing else on the contact changes, but the МОЛ's
 * search mirror (`representativeLower`), which the model's plugin keeps and a bulk write bypasses.
 */
import { mongoose } from '../../packages/db/src/connection.js'
import { legacyRepresentativeOf } from '../../packages/config/src/contact-representative.js'
import { Contact } from '../../packages/db/src/models/index.js'

export interface ContactNotesRow {
  _id: unknown
  notes?: unknown
  representative?: unknown
}

export type RepresentativeMove =
  | { kind: 'move'; id: string; notes: string; name: string }
  | { kind: 'clear'; id: string; notes: string; name: string }
  | { kind: 'conflict'; id: string }

export interface RepresentativePlan {
  moves: RepresentativeMove[]
  counts: { withNotes: number; otherNotes: number; move: number; clear: number; conflict: number }
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function planRepresentativeMoves(rows: readonly ContactNotesRow[]): RepresentativePlan {
  const counts = { withNotes: 0, otherNotes: 0, move: 0, clear: 0, conflict: 0 }
  const moves: RepresentativeMove[] = []
  for (const row of rows) {
    if (typeof row.notes !== 'string' || !row.notes.trim()) continue
    counts.withNotes++
    const name = legacyRepresentativeOf(row.notes)
    if (!name) { counts.otherNotes++; continue }
    const id = String(row._id)
    const held = text(row.representative)
    const move: RepresentativeMove = !held ? { kind: 'move', id, notes: row.notes, name } : held === name ? { kind: 'clear', id, notes: row.notes, name } : { kind: 'conflict', id }
    counts[move.kind]++
    moves.push(move)
  }
  return { moves, counts }
}

const oid = (id: string) => new mongoose.Types.ObjectId(id)
/** The search mirror, as `loweredFieldsPlugin` (locale `bg`) writes it. */
const lowered = (name: string) => name.toLocaleLowerCase('bg')
const NO_REPRESENTATIVE = [{ representative: { $exists: false } }, { representative: null }, { representative: '' }]

/** The writes of a plan, each conditional on the contact still being as the plan read it. */
export function representativeWrites(orgId: string, moves: readonly RepresentativeMove[]): any[] {
  const ops: any[] = []
  for (const m of moves) {
    if (m.kind === 'move') {
      ops.push({ updateOne: { filter: { _id: oid(m.id), orgId: oid(orgId), notes: m.notes, $or: NO_REPRESENTATIVE }, update: { $set: { representative: m.name, representativeLower: lowered(m.name) }, $unset: { notes: 1 } } } })
    } else if (m.kind === 'clear') {
      ops.push({ updateOne: { filter: { _id: oid(m.id), orgId: oid(orgId), notes: m.notes, representative: m.name }, update: { $unset: { notes: 1 } } } })
    }
  }
  return ops
}

/** A run taken back: the notes line returns, and a representative the run set goes, where nobody changed them since. */
export function undoWrites(orgId: string, moves: readonly RepresentativeMove[]): any[] {
  const ops: any[] = []
  for (const m of moves) {
    if (m.kind === 'conflict') continue
    const filter = { _id: oid(m.id), orgId: oid(orgId), representative: m.name, notes: { $exists: false } }
    ops.push({ updateOne: { filter, update: m.kind === 'move' ? { $set: { notes: m.notes }, $unset: { representative: 1, representativeLower: 1 } } : { $set: { notes: m.notes } } } })
  }
  return ops
}

/** Every contact of the org that has notes, with what the plan reads. No `$regex`: a Cyrillic pattern from Bun breaks Mongo's. */
export async function contactsWithNotes(orgId: string): Promise<ContactNotesRow[]> {
  return Contact.find({ orgId: oid(orgId), notes: { $exists: true, $nin: [null, ''] } }, { notes: 1, representative: 1 }).lean() as any
}

/** Writes in batches; answers how many contacts changed. */
export async function applyWrites(ops: readonly any[]): Promise<number> {
  let modified = 0
  for (let i = 0; i < ops.length; i += 500) {
    const r = await Contact.bulkWrite(ops.slice(i, i + 500) as any[], { ordered: false })
    modified += r.modifiedCount
  }
  return modified
}
