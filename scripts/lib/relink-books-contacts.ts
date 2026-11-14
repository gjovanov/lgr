/**
 * FR-25 R7: the contacts the first split import made a second time, and their relink
 * (`scripts/relink-books-contacts.ts`).
 *
 * Until `contact-match.ts` learned R7's rule, a store keeping a share of the books looked a partner up by its
 * numbers exactly as written, and only among contacts of the partner's own type. A store contact whose ЕИК was
 * spaced, prefixed `BG` or written with dashes, or held only as a VAT number or in the form's ЕИК field, was not
 * found, and neither was a company the shop had typed as a supplier when the books sell to it. The import then made
 * a Contact of its own for the partner. This finds those, and points what the books hold of them at the older one.
 *
 * A PAIR is a contact the import made and an older contact holding one of its numbers:
 * - **made by the import**: made since the books import began in this org (its first analytic, entry or import
 *   batch, the earliest of them), pointed at by a partner analytic (customer, supplier, partner), and named by
 *   nothing but the books (`namedOutsideBooks`): no document of any model whose schema points at contacts, no file,
 *   notification or e-mail about it, no audit row (an edit in the app makes it a person's), no document import's
 *   cached analysis or job. Whatever else names it is left alone, and counted.
 * - **the older contact**: made before the books import began, and the one R7's rule picks for the made one's
 *   numbers, as a fresh import picks it now (`ContactIndex#findByNumber`, typed as the made contact).
 *
 * For each pair: every analytic pointing at the made contact, and every journal line of the org carrying it, point
 * at the older one; then the made one is deleted, unless something names it after that (a re-count). A contact is
 * never matched by name: made contacts that share a name with an older contact holding no number are only counted,
 * and so are those whose numbers no older contact holds (with how many of them another made contact shares).
 *
 * ⚠ The contact on a line is part of an imported entry's stored hash (`journal-plan.ts#importHashOf`): the next
 * import of a month reports the relinked entries as `changed`, once, and writes them as they already are.
 */
import { mongoose } from '../../packages/db/src/connection.js'
import {
  AccountingAnalytic,
  AuditLog,
  BackgroundTask,
  BOOKS_IMPORT,
  Contact,
  DocFile,
  EmailLog,
  File,
  JournalEntry,
  Notification,
  Org,
} from '../../packages/db/src/models/index.js'
import { ContactIndex, numbersOf } from '../../packages/services/src/biz/accounting-books/contact-match.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import { pointersTo } from './books-leftovers.js'

export const SCRIPT = 'scripts/relink-books-contacts.ts'

/** The analytics that stand for a partner: the import makes a Contact only for these. */
export const PARTNER_KINDS: readonly string[] = ['customer', 'supplier', 'partner']

const EJSON = mongoose.mongo.BSON.EJSON
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id))
const madeAt = (c: any): number => new Date(c.createdAt ?? c._id.getTimestamp()).getTime()
const nameKey = (c: any): string =>
  String(c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export class RelinkError extends Error {
  constructor(readonly code: 'not_found' | 'not_split' | 'other_org' | 'not_a_manifest', message: string) {
    super(message)
    this.name = 'RelinkError'
  }
}

/** One line of an entry that carries the made contact: its place in `lines`, and its analytic. */
export interface RelinkLine { i: number; analyticId?: string }

export interface RelinkPair {
  duplicateId: string
  keepId: string
  duplicateType: string
  keepType: string
  keepActive: boolean
  /** Every analytic that points at the made contact, of any kind. */
  analyticIds: string[]
  entries: { entryId: string; lines: RelinkLine[] }[]
}

export interface RelinkCounts {
  /** Partner analytics pointing at a contact made since the import began. */
  partnerAnalytics: number
  /** The contacts they point at. */
  made: number
  noNumber: number
  /** With a number no older contact holds… */
  noOlder: number
  /** …of which another made contact holds one too. */
  madeTwice: number
  /** With a number an older contact holds… */
  withOlder: number
  /** …named by something besides the books: left alone. */
  namedElsewhere: number
  pairs: number
  /** Pairs whose older contact is deactivated. */
  keepDeactivated: number
  /** Unpaired made contacts that share a name with an older contact holding no number: never matched by name. */
  lookAlikes: number
  analytics: number
  entries: number
  lines: number
  /** `<made type><-<older type>`, per pair. */
  byType: Record<string, number>
}

export interface RelinkPlan {
  orgId: string
  /** When the books import began in this org. Unset: no books were imported here. */
  since?: Date
  pairs: RelinkPair[]
  counts: RelinkCounts
}

const zero = (): RelinkCounts => ({
  partnerAnalytics: 0, made: 0, noNumber: 0, noOlder: 0, madeTwice: 0, withOlder: 0, namedElsewhere: 0, pairs: 0,
  keepDeactivated: 0, lookAlikes: 0, analytics: 0, entries: 0, lines: 0, byType: {},
})

/** The org, refused unless it keeps a share of split books (FR-25 R7): a books org of its own is not this repair's. */
export async function splitOrg(slug: string): Promise<{ id: string; slug: string; ownerId?: string; role: 'home' | 'member' }> {
  const org: any = await Org.findOne({ slug }, { slug: 1, ownerId: 1, 'settings.accounting.books': 1 }).lean()
  if (!org) throw new RelinkError('not_found', `Org "${slug}" not found.`)
  const books = org.settings?.accounting?.books
  if (books?.mode !== 'books' || !books.split?.homeOrgId) {
    throw new RelinkError('not_split', `${slug} keeps no share of split books (settings.accounting.books.split): this repair is for the orgs of a split only.`)
  }
  return { id: String(org._id), slug: org.slug, ...(org.ownerId ? { ownerId: String(org.ownerId) } : {}), role: String(books.split.homeOrgId) === String(org._id) ? 'home' : 'member' }
}

/** When the books import began in this org: its first analytic, books entry or import batch, the earliest. */
export async function importBegan(orgId: string): Promise<Date | undefined> {
  const org = oid(orgId)
  const books = { orgId: org, ledger: 'books', sourceModule: BOOKS_IMPORT }
  const [analytic, entry, batch]: any[] = await Promise.all([
    AccountingAnalytic.findOne({ orgId: org }, { createdAt: 1 }).sort({ createdAt: 1 }).lean().exec(),
    JournalEntry.findOne(books, { createdAt: 1 }).sort({ createdAt: 1 }).lean().exec(),
    JournalEntry.findOne({ ...books, importBatchId: { $type: 'objectId' } }, { importBatchId: 1 }).sort({ importBatchId: 1 }).lean().exec(),
  ])
  const times = [analytic?.createdAt, entry?.createdAt, batch?.importBatchId?.getTimestamp()]
    .filter(Boolean)
    .map(d => new Date(d).getTime())
  return times.length ? new Date(Math.min(...times)) : undefined
}

/** What the relink re-points itself, so never a reason to keep a contact. */
const BOOKS_POINTERS = (model: string, path: string) =>
  (model === 'AccountingAnalytic' && path === 'contactId') || (model === 'JournalEntry' && path === 'lines.contactId')

/** Models naming any record by its id with no `ref`: a file attached to it, a notification or an e-mail about it. */
const ENTITY_POINTERS = [File, Notification, EmailLog]

/**
 * For each of `ids` that something besides the books names, what does. "Something" is every path of every model
 * whose schema points at contacts (`books-leftovers.ts#referencePaths`, the repo's own list, read off the schemas),
 * the models that name any record by id, the audit log (an edit in the app), and the free-form fields a document
 * import keeps what it matched in until it books it (a file's cached analysis, a job's parameters and result) since
 * `since`: those are booked later, and would name a contact that is gone.
 */
export async function namedOutsideBooks(orgId: string, ids: readonly string[], since: Date): Promise<Map<string, string[]>> {
  const named = await pointersTo('Contact', orgId, ids, BOOKS_POINTERS)
  if (!ids.length) return named
  const org = oid(orgId)
  const add = (id: unknown, by: string) => named.set(String(id), [...(named.get(String(id)) ?? []), by])
  const either = [...ids.map(oid), ...ids]
  for (const M of ENTITY_POINTERS) {
    for (const id of await (M as any).distinct('entityId', { orgId: org, entityId: { $in: ids.map(oid) } }).exec()) add(id, `${M.modelName}.entityId`)
  }
  for (const id of await AuditLog.distinct('entityId', { orgId: org, entityType: 'contact', entityId: { $in: either } } as any).exec()) add(id, 'AuditLog.entityId')

  const wanted = new Set(ids.map(String))
  const scan = async (cursor: AsyncIterable<any>, by: string, fields: string[]) => {
    for await (const doc of cursor) {
      // An id is 24 hex digits on its own: a checksum's 64 never yields one.
      const seen = new Set(JSON.stringify(fields.map(f => doc[f] ?? null)).match(/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g) ?? [])
      for (const hex of seen) if (wanted.has(hex)) add(hex, by)
    }
  }
  await scan(DocFile.find({ orgId: org, updatedAt: { $gte: since } }, { analysis: 1 }).lean().cursor(), 'DocFile.analysis', ['analysis'])
  await scan(BackgroundTask.find({ orgId: org, createdAt: { $gte: since } }, { params: 1, result: 1 }).lean().cursor(), 'BackgroundTask', ['params', 'result'])
  return named
}

/** Which entries carry which of `byDuplicate`'s contacts on a line, and on which lines. Fills each pair's `entries`. */
async function linesOf(orgId: string, byDuplicate: Map<string, RelinkPair>): Promise<void> {
  if (!byDuplicate.size) return
  const cursor = JournalEntry.find(
    { orgId: oid(orgId), 'lines.contactId': { $in: [...byDuplicate.keys()].map(oid) } },
    { 'lines.contactId': 1, 'lines.analyticId': 1 },
  ).sort({ _id: 1 }).lean().cursor()
  for await (const e of cursor as AsyncIterable<any>) {
    const found = new Map<string, RelinkLine[]>()
    ;(e.lines ?? []).forEach((l: any, i: number) => {
      const id = l?.contactId ? String(l.contactId) : ''
      if (!byDuplicate.has(id)) return
      found.set(id, [...(found.get(id) ?? []), { i, ...(l.analyticId ? { analyticId: String(l.analyticId) } : {}) }])
    })
    for (const [id, lines] of found) byDuplicate.get(id)!.entries.push({ entryId: String(e._id), lines })
  }
}

/** The pairs, and the counts the dry run prints. Reads only. */
export async function planRelink(orgId: string): Promise<RelinkPlan> {
  const org = oid(orgId)
  const counts = zero()
  const since = await importBegan(orgId)
  if (!since) return { orgId, pairs: [], counts }

  const analytics: any[] = await AccountingAnalytic.find({ orgId: org, contactId: { $ne: null } }, { contactId: 1, kind: 1 }).lean().exec()
  const contacts: any[] = await Contact.find(
    { orgId: org },
    { type: 1, taxId: 1, taxNumber: 1, vatNumber: 1, companyName: 1, firstName: 1, lastName: 1, isActive: 1, createdAt: 1 },
  ).lean().exec()
  const byId = new Map(contacts.map(c => [String(c._id), c]))
  const isMade = (c: any) => !!c && madeAt(c) >= since.getTime()

  const partners = analytics.filter(a => PARTNER_KINDS.includes(a.kind) && isMade(byId.get(String(a.contactId))))
  const made = [...new Set(partners.map(a => String(a.contactId)))].sort().map(id => byId.get(id))
  counts.partnerAnalytics = partners.length
  counts.made = made.length

  const older = contacts.filter(c => !isMade(c))
  const index = new ContactIndex<string>(true)
  for (const c of older) index.add(String(c._id), { ...c, createdAt: madeAt(c) })
  const namesWithoutNumber = new Set(older.filter(c => !numbersOf(c).length).map(nameKey).filter(Boolean))
  const madeHolding = new Map<string, number>()
  for (const c of made) for (const n of numbersOf(c)) madeHolding.set(n, (madeHolding.get(n) ?? 0) + 1)

  const candidates: { made: any; keep: any }[] = []
  const unpaired: any[] = []
  for (const c of made) {
    const numbers = numbersOf(c)
    if (!numbers.length) {
      counts.noNumber++
      unpaired.push(c)
      continue
    }
    const keepId = index.findByNumber({ type: c.type, taxId: c.taxId, taxNumber: c.taxNumber, vatNumber: c.vatNumber })
    if (!keepId) {
      counts.noOlder++
      if (numbers.some(n => (madeHolding.get(n) ?? 0) > 1)) counts.madeTwice++
      unpaired.push(c)
      continue
    }
    counts.withOlder++
    candidates.push({ made: c, keep: byId.get(keepId) })
  }

  const named = await namedOutsideBooks(orgId, candidates.map(p => String(p.made._id)), since)
  const pointing = new Map<string, string[]>()
  for (const a of analytics) pointing.set(String(a.contactId), [...(pointing.get(String(a.contactId)) ?? []), String(a._id)])
  const byDuplicate = new Map<string, RelinkPair>()
  for (const { made: c, keep } of candidates) {
    if (named.has(String(c._id))) {
      counts.namedElsewhere++
      continue
    }
    byDuplicate.set(String(c._id), {
      duplicateId: String(c._id),
      keepId: String(keep._id),
      duplicateType: c.type,
      keepType: keep.type,
      keepActive: keep.isActive !== false,
      analyticIds: (pointing.get(String(c._id)) ?? []).sort(),
      entries: [],
    })
  }
  counts.lookAlikes = unpaired.filter(c => namesWithoutNumber.has(nameKey(c))).length
  await linesOf(orgId, byDuplicate)

  const pairs = [...byDuplicate.values()]
  const entries = new Set<string>()
  for (const p of pairs) {
    counts.byType[`${p.duplicateType}<-${p.keepType}`] = (counts.byType[`${p.duplicateType}<-${p.keepType}`] ?? 0) + 1
    if (!p.keepActive) counts.keepDeactivated++
    counts.analytics += p.analyticIds.length
    for (const e of p.entries) {
      entries.add(e.entryId)
      counts.lines += e.lines.length
    }
  }
  counts.pairs = pairs.length
  counts.entries = entries.size
  return { orgId, since, pairs, counts }
}

// ── The manifest: what a run changed, so `--undo` can take it back ───────────────────────────────

export interface RelinkManifest {
  script: 'relink-books-contacts'
  version: 1
  orgId: string
  slug: string
  at: string
  since: string
  /** Each pair, with the whole made contact as it was: `--undo` makes it again from this. */
  pairs: (RelinkPair & { contact: Record<string, unknown> })[]
}

/** The manifest of `plan`, with each made contact read whole. Written BEFORE the first write. */
export async function manifestOf(plan: RelinkPlan, slug: string): Promise<RelinkManifest> {
  const docs = new Map((await Contact.find({ orgId: oid(plan.orgId), _id: { $in: plan.pairs.map(p => oid(p.duplicateId)) } }).lean().exec() as any[]).map(c => [String(c._id), c]))
  const gone = plan.pairs.filter(p => !docs.has(p.duplicateId)).length
  if (gone) throw new Error(`${gone} made contact(s) are gone since the plan read them: nothing was written; run the dry run again.`)
  return {
    script: 'relink-books-contacts',
    version: 1,
    orgId: plan.orgId,
    slug,
    at: new Date().toISOString(),
    since: plan.since!.toISOString(),
    pairs: plan.pairs.map(p => ({ ...p, contact: docs.get(p.duplicateId)! })),
  }
}

/** Types kept (ids, dates): a contact made again from it is the one deleted. */
export const manifestText = (m: RelinkManifest) => EJSON.stringify(m as any, { relaxed: false })

export function parseManifest(text: string, orgId: string): RelinkManifest {
  let m: any
  try {
    m = EJSON.parse(text, { relaxed: false })
  } catch {
    throw new RelinkError('not_a_manifest', 'Not a manifest of scripts/relink-books-contacts.ts.')
  }
  if (m?.script !== 'relink-books-contacts' || Number(m.version) !== 1 || !Array.isArray(m.pairs)) {
    throw new RelinkError('not_a_manifest', 'Not a manifest of scripts/relink-books-contacts.ts.')
  }
  if (m.orgId !== orgId) throw new RelinkError('other_org', 'This manifest is of another org.')
  // Read without loss, its numbers are BSON's (Int32): the contact keeps them so, the run's own become numbers.
  return {
    ...m,
    version: 1,
    pairs: m.pairs.map((p: any) => ({
      ...p,
      entries: (p.entries ?? []).map((e: any) => ({
        entryId: String(e.entryId),
        lines: (e.lines ?? []).map((l: any) => ({ i: Number(l.i), ...(l.analyticId ? { analyticId: String(l.analyticId) } : {}) })),
      })),
    })),
  } as RelinkManifest
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

export interface RelinkResult {
  analytics: number
  entries: number
  lines: number
  deleted: number
  /** Made contacts something still names after the re-point: kept. */
  kept: number
  failed: string[]
}

const repoint = (from: mongoose.Types.ObjectId, to: mongoose.Types.ObjectId) => ({
  update: { $set: { 'lines.$[l].contactId': to } },
  options: { arrayFilters: [{ 'l.contactId': from }] },
})

/** One audit row a run, the script's own (`via`): it acts as nobody in the org. It names the org, never a contact. */
async function audit(orgId: string, entityName: string, changes: Record<string, number>): Promise<void> {
  const written = await recordAuditEntry({
    orgId, userId: '', via: SCRIPT, action: 'update', module: 'accounting', entityType: 'contact', entityId: orgId, entityName,
    changes: Object.entries(changes).map(([field, newValue]) => ({ field, oldValue: null, newValue })),
  })
  if (!written) throw new Error('the audit row of the run was not written; the changes themselves were')
}

/**
 * Point each pair's analytics and lines at the older contact, then delete each made contact nothing names any more.
 * Every write is conditional on the made contact still being where the plan saw it.
 */
export async function applyRelink(plan: RelinkPlan): Promise<RelinkResult> {
  const result: RelinkResult = { analytics: 0, entries: 0, lines: 0, deleted: 0, kept: 0, failed: [] }
  if (!plan.pairs.length) return result
  const org = oid(plan.orgId)
  const done: RelinkPair[] = []
  for (const p of plan.pairs) {
    const made = oid(p.duplicateId)
    const keep = oid(p.keepId)
    // Never pointed at nothing: the older contact is read again first.
    if (!await Contact.exists({ _id: keep, orgId: org })) {
      result.failed.push(`pair ${p.duplicateId}: the older contact is gone; left alone`)
      continue
    }
    const a = await AccountingAnalytic.updateMany({ orgId: org, _id: { $in: p.analyticIds.map(oid) }, contactId: made }, { $set: { contactId: keep } }).exec()
    result.analytics += a.modifiedCount
    const { update, options } = repoint(made, keep)
    for (const ids of chunks(p.entries.map(e => oid(e.entryId)), 500)) {
      const r = await JournalEntry.updateMany({ orgId: org, _id: { $in: ids }, 'lines.contactId': made }, update, options).exec()
      result.entries += r.modifiedCount
    }
    result.lines += p.entries.reduce((n, e) => n + e.lines.length, 0)
    done.push(p)
  }

  // A line the plan did not see (an import since it read): every line of the org that carries a made contact.
  const late = new Map(done.map(p => [p.duplicateId, { ...p, entries: [] as RelinkPair['entries'] }]))
  await linesOf(plan.orgId, late)
  for (const p of late.values()) {
    if (!p.entries.length) continue
    const { update, options } = repoint(oid(p.duplicateId), oid(p.keepId))
    const r = await JournalEntry.updateMany({ orgId: org, _id: { $in: p.entries.map(e => oid(e.entryId)) }, 'lines.contactId': oid(p.duplicateId) }, update, options).exec()
    result.entries += r.modifiedCount
    result.lines += p.entries.reduce((n, e) => n + e.lines.length, 0)
  }

  // Counted again, now: a made contact goes only when nothing at all names it.
  const ids = done.map(p => p.duplicateId)
  const named = await namedOutsideBooks(plan.orgId, ids, plan.since ?? new Date(0))
  const still = new Set([
    ...(await AccountingAnalytic.distinct('contactId', { orgId: org, contactId: { $in: ids.map(oid) } }).exec()).map(String),
    ...(await JournalEntry.distinct('lines.contactId', { orgId: org, 'lines.contactId': { $in: ids.map(oid) } }).exec()).map(String),
  ])
  const free = ids.filter(id => !named.has(id) && !still.has(id))
  if (free.length) result.deleted = (await Contact.deleteMany({ orgId: org, _id: { $in: free.map(oid) } }).exec()).deletedCount ?? 0
  result.kept = ids.length - free.length

  await audit(plan.orgId, `books contacts relinked to the older contact (${SCRIPT})`, {
    pairs: done.length, analytics: result.analytics, entries: result.entries, lines: result.lines, deleted: result.deleted, kept: result.kept,
  })
  return result
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────

export interface UndoCounts {
  pairs: number
  /** Made contacts the run deleted: made again from the manifest. */
  contacts: number
  analytics: number
  entries: number
  lines: number
}

const lineFilter = (entryId: string, l: RelinkLine, keep: mongoose.Types.ObjectId) => ({
  _id: oid(entryId),
  [`lines.${l.i}.contactId`]: keep,
  ...(l.analyticId ? { [`lines.${l.i}.analyticId`]: oid(l.analyticId) } : {}),
})

/**
 * What `--undo` would take back, or takes back with `execute`: the made contacts deleted are made again, as they
 * were (same id, same fields, same dates), and the analytics and lines the run moved that still point at the older
 * contact point at the made one again. Only what still reads as the run left it is touched.
 */
export async function undoRelink(m: RelinkManifest, execute: boolean): Promise<UndoCounts> {
  const org = oid(m.orgId)
  const counts: UndoCounts = { pairs: m.pairs.length, contacts: 0, analytics: 0, entries: 0, lines: 0 }
  for (const p of m.pairs) {
    const made = oid(p.duplicateId)
    const keep = oid(p.keepId)
    if (p.contact && !await Contact.exists({ _id: made })) {
      counts.contacts++
      // The document as it was, byte for byte: Mongoose would stamp new dates on it.
      if (execute) await Contact.collection.insertOne({ ...p.contact, _id: made, orgId: org } as any)
    }
    const analytics = { orgId: org, _id: { $in: p.analyticIds.map(oid) }, contactId: keep }
    counts.analytics += execute
      ? (await AccountingAnalytic.updateMany(analytics, { $set: { contactId: made } }).exec()).modifiedCount
      : await AccountingAnalytic.countDocuments(analytics).exec()

    // The lines the run moved that still read as it left them: the older contact, on the same analytic.
    const todo: { entryId: string; lines: RelinkLine[] }[] = []
    for (const ids of chunks(p.entries.map(e => oid(e.entryId)), 500)) {
      const held = new Map((await JournalEntry.find({ orgId: org, _id: { $in: ids } }, { 'lines.contactId': 1, 'lines.analyticId': 1 }).lean().exec() as any[]).map(e => [String(e._id), e]))
      for (const e of p.entries) {
        const doc = held.get(e.entryId)
        if (!doc) continue
        const lines = e.lines.filter(l => {
          const line = doc.lines?.[l.i]
          return line && String(line.contactId) === p.keepId && (!l.analyticId || String(line.analyticId) === l.analyticId)
        })
        if (lines.length) todo.push({ entryId: e.entryId, lines })
      }
    }
    counts.entries += todo.length
    counts.lines += todo.reduce((n, e) => n + e.lines.length, 0)
    if (!execute) continue
    for (const batch of chunks(todo, 500)) {
      await JournalEntry.bulkWrite(batch.map(e => ({
        updateOne: {
          filter: Object.assign({ orgId: org }, ...e.lines.map(l => lineFilter(e.entryId, l, keep))),
          update: { $set: Object.fromEntries(e.lines.map(l => [`lines.${l.i}.contactId`, made])) },
        },
      })), { ordered: false })
    }
  }
  if (execute) await audit(m.orgId, `books contacts relink taken back (${SCRIPT} --undo)`, { ...counts })
  return counts
}
