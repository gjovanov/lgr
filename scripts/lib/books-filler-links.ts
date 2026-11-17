/**
 * FR-25 R7: the partner links the first split import made on a number that is no number, and their repair
 * (`scripts/relink-books-filler-links.ts`).
 *
 * Until `contact-match.ts` learned R7's rule, a store keeping a share of the books looked a partner up by ONE key
 * exactly as written: its ЕИК (or the digits of its VAT number), else its VAT number, else its name. The books give
 * a partner abroad a number typed to fill the box, and several share one. The first import linked every one of
 * them to the single contact of the store that held that filler: another partner's. Today a filler is no number
 * and such a partner is found by its name, but a link once stored is never looked at again
 * (`import.service.ts#ensureAnalytics` takes only the analytics with no contact). So those links stayed, and every
 * journal line on such an analytic carries the other partner's contact: its ledger shows their entries.
 *
 * A link is WRONG when all of these hold:
 * - today's rule does not make it (`agrees`): the contact holds none of the partner's numbers, or, for a partner
 *   with no number, is not of the partner's exact name;
 * - the first import's one key explains it (`onFiller`): that key is no number, and the contact holds it as written;
 * - the contact is another partner's: some other partner analytic of the org is linked to it, and today's rule
 *   agrees with that link.
 * The last is what tells a wrong link from a contact someone renamed, or whose number someone retyped, since:
 * those are left alone, and counted.
 *
 * Each wrong link gets what a fresh import would give the partner today (`ContactIndex#find`, over the org's
 * contacts as they are, in the order of the analytics' paths):
 * - `repoint`: the contact found by the partner's own number, or by its name;
 * - `create`: none is found and the org's own entries book on the partner: the Contact the journal import makes
 *   for such a partner, made here the same way, from what the analytic keeps of the file;
 * - `unlink`: none is found and no entry books on it: the link is removed. A store keeps no contact for a partner
 *   only the sister store, or the supplier list, names.
 * The analytic, and every journal line of the org on that analytic that carries the wrong contact, change together.
 * No contact is changed or deleted: the one they pointed at is a real contact of the store, and another partner's.
 *
 * ⚠ The contact on a line is part of an imported entry's stored hash (`journal-plan.ts#importHashOf`): the next
 * import of a month reports the re-pointed entries as `changed`, once, and writes them as they already are.
 */
import { mongoose } from '../../packages/db/src/connection.js'
import { AccountingAnalytic, Contact, JournalEntry } from '../../packages/db/src/models/index.js'
import { ContactIndex, numberOf, numbersOf } from '../../packages/services/src/biz/accounting-books/contact-match.js'
import { CONTACT_TYPE, newContact } from '../../packages/services/src/biz/accounting-books/import.service.js'
import { itemOfRow } from '../../packages/services/src/biz/accounting-books/plusminus-exports.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import { PARTNER_KINDS, RelinkError, namedOutsideBooks } from './relink-books-contacts.js'

export const SCRIPT = 'scripts/relink-books-filler-links.ts'
const NAME = 'relink-books-filler-links'

const EJSON = mongoose.mongo.BSON.EJSON
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id))

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** The contact the import would make for a partner: what it is found by, and what is written when none is. */
type Made = ReturnType<typeof newContact>

/** The numbers and the name a stored contact is found by. */
interface Held {
  _id: mongoose.Types.ObjectId
  type: string
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  companyName?: string
  createdAt?: Date
}

/** How today's rule agrees with a link, if it does: the contact holds a number of the partner's, or has its exact name. */
export function agrees(partner: Made, held: Pick<Held, 'taxId' | 'taxNumber' | 'vatNumber' | 'companyName'>): 'byNumber' | 'byName' | undefined {
  const wanted = numbersOf(partner)
  if (wanted.length) {
    const has = numbersOf(held)
    return wanted.some(n => has.includes(n)) ? 'byNumber' : undefined
  }
  return partner.companyName && held.companyName === partner.companyName ? 'byName' : undefined
}

/**
 * Whether the first split import's one key explains a link: the partner's ЕИК, else its VAT number, exactly as
 * written, is no number (`numberOf`), and the contact holds it in the field that import looked in.
 */
export function onFiller(partner: Made, held: Pick<Held, 'taxId' | 'vatNumber'>): boolean {
  const [field, value] = partner.taxId ? (['taxId', partner.taxId] as const) : (['vatNumber', partner.vatNumber] as const)
  return !!value && !numberOf(value) && held[field] === value
}

export type FillerAction = 'repoint' | 'create' | 'unlink'
const ACTIONS: readonly string[] = ['repoint', 'create', 'unlink']

export interface FillerLink {
  analyticId: string
  /** The contact it is linked to: another partner's. */
  fromId: string
  action: FillerAction
  /** `repoint`: the contact today's rule finds. `create`: the id the made contact gets. */
  toId?: string
  /** `create` only: the contact, as the journal import would make it. */
  contact?: Record<string, unknown>
  /** The lines of the org on this analytic that carry `fromId`: each entry, and their places in its `lines`. */
  entries: { entryId: string; lines: number[] }[]
}

export interface FillerCounts {
  /** Partner analytics linked to a contact. */
  partnerAnalytics: number
  /** …that holds one of the partner's numbers. */
  byNumber: number
  /** …of the partner's exact name, for a partner with no number. */
  byName: number
  /** …that is gone. */
  dangling: number
  /** …that today's rule would not pick, with no filler to explain the link. */
  unexplained: number
  /** …on a filler, to a contact no other partner is rightly linked to. */
  noOwner: number
  /** …on a filler, to a contact that is another partner's. */
  wrong: number
  /** The contacts the wrong links point at. */
  holders: number
  repoint: number
  create: number
  unlink: number
  entries: number
  lines: number
}

export interface FillerPlan {
  orgId: string
  links: FillerLink[]
  counts: FillerCounts
}

const zero = (): FillerCounts => ({
  partnerAnalytics: 0, byNumber: 0, byName: 0, dangling: 0, unexplained: 0, noOwner: 0, wrong: 0, holders: 0,
  repoint: 0, create: 0, unlink: 0, entries: 0, lines: 0,
})

/** The wrong links, what each gets, and the counts the dry run prints. Reads only. */
export async function planFillerLinks(orgId: string): Promise<FillerPlan> {
  const org = oid(orgId)
  const counts = zero()
  const rows: any[] = await AccountingAnalytic.find(
    { orgId: org, kind: { $in: [...PARTNER_KINDS] }, contactId: { $ne: null } },
    { path: 1, kind: 1, params: 1, contactId: 1 },
  ).lean().exec()
  const contacts: Held[] = await Contact.find(
    { orgId: org },
    { type: 1, taxId: 1, taxNumber: 1, vatNumber: 1, companyName: 1, createdAt: 1 },
  ).lean().exec() as any[]
  const byId = new Map(contacts.map(c => [String(c._id), c]))

  // A root on its own is no one: only a path under it is a partner (as the import has it).
  const partners = rows
    .filter(a => String(a.path).includes(':') && CONTACT_TYPE[a.kind as keyof typeof CONTACT_TYPE])
    .map(a => ({
      a,
      made: newContact(orgId, CONTACT_TYPE[a.kind as keyof typeof CONTACT_TYPE]!, itemOfRow(a.path, a.params ?? [])),
      held: byId.get(String(a.contactId)),
    }))
  counts.partnerAnalytics = partners.length

  // A contact today's rule agrees some partner is linked to is that partner's.
  const owned = new Set<string>()
  const disputed: typeof partners = []
  for (const p of partners) {
    if (!p.held) {
      counts.dangling++
      continue
    }
    const how = agrees(p.made, p.held)
    if (!how) {
      disputed.push(p)
      continue
    }
    counts[how]++
    owned.add(String(p.held._id))
  }
  const wrong: typeof partners = []
  for (const p of disputed) {
    if (!onFiller(p.made, p.held!)) counts.unexplained++
    else if (!owned.has(String(p.held!._id))) counts.noOwner++
    else wrong.push(p)
  }
  wrong.sort((x, y) => (x.a.path < y.a.path ? -1 : x.a.path > y.a.path ? 1 : 0))

  // Which of them the org's entries book on, and the lines that carry the wrong contact.
  const fromOf = new Map(wrong.map(p => [String(p.a._id), String(p.a.contactId)]))
  const booked = new Set<string>()
  const lines = new Map<string, FillerLink['entries']>()
  if (wrong.length) {
    // No sort here: one by `_id` can take the planner off the org's indexes and over every org's entries.
    const cursor = JournalEntry.find(
      { orgId: org, 'lines.analyticId': { $in: wrong.map(p => p.a._id) } },
      { 'lines.analyticId': 1, 'lines.contactId': 1 },
    ).lean().cursor()
    for await (const e of cursor as AsyncIterable<any>) {
      const found = new Map<string, number[]>()
      ;(e.lines ?? []).forEach((l: any, i: number) => {
        const id = l?.analyticId ? String(l.analyticId) : ''
        const from = fromOf.get(id)
        if (!from) return
        booked.add(id)
        if (l.contactId && String(l.contactId) === from) found.set(id, [...(found.get(id) ?? []), i])
      })
      for (const [id, at] of found) lines.set(id, [...(lines.get(id) ?? []), { entryId: String(e._id), lines: at }])
    }
  }

  // What a fresh import would give each of them, over the contacts as they are and the ones made on the way.
  const index = new ContactIndex<string>(true)
  for (const c of contacts) index.add(String(c._id), { ...c, createdAt: c.createdAt ?? c._id.getTimestamp() })
  const links: FillerLink[] = []
  for (const p of wrong) {
    const analyticId = String(p.a._id)
    const fromId = String(p.a.contactId)
    const entries = (lines.get(analyticId) ?? []).sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
    const found = index.find(p.made)
    if (found === fromId) {
      // Today's rule picks the contact it is linked to after all: nothing to put right.
      counts.unexplained++
    } else if (found) {
      links.push({ analyticId, fromId, action: 'repoint', toId: found, entries })
    } else if (booked.has(analyticId)) {
      const _id = new mongoose.Types.ObjectId()
      index.add(String(_id), p.made)
      links.push({ analyticId, fromId, action: 'create', toId: String(_id), contact: { _id, ...p.made }, entries })
    } else {
      links.push({ analyticId, fromId, action: 'unlink', entries })
    }
  }

  const entries = new Set<string>()
  for (const l of links) {
    counts[l.action]++
    for (const e of l.entries) {
      entries.add(e.entryId)
      counts.lines += e.lines.length
    }
  }
  counts.wrong = links.length
  counts.holders = new Set(links.map(l => l.fromId)).size
  counts.entries = entries.size
  return { orgId, links, counts }
}

// ── The manifest: what a run changed, so `--undo` can take it back ───────────────────────────────

export interface FillerManifest {
  script: typeof NAME
  version: 1
  orgId: string
  slug: string
  at: string
  links: FillerLink[]
}

/** The manifest of `plan`. Written BEFORE the first write. */
export const manifestOf = (plan: FillerPlan, slug: string): FillerManifest =>
  ({ script: NAME, version: 1, orgId: plan.orgId, slug, at: new Date().toISOString(), links: plan.links })

/** Types kept (ids, dates): a made contact reads here as it was written. */
export const manifestText = (m: FillerManifest) => EJSON.stringify(m as any, { relaxed: false })

export function parseManifest(text: string, orgId: string): FillerManifest {
  const refused = () => new RelinkError('not_a_manifest', `Not a manifest of ${SCRIPT}.`)
  let m: any
  try {
    m = EJSON.parse(text, { relaxed: false })
  } catch {
    throw refused()
  }
  if (m?.script !== NAME || Number(m.version) !== 1 || !Array.isArray(m.links)) throw refused()
  if (m.links.some((l: any) => !ACTIONS.includes(l?.action) || !l.analyticId || !l.fromId || (l.action !== 'unlink' && !l.toId))) throw refused()
  if (m.orgId !== orgId) throw new RelinkError('other_org', 'This manifest is of another org.')
  // Read without loss, its numbers are BSON's (Int32): the run's own become numbers.
  return {
    script: NAME,
    version: 1,
    orgId: String(m.orgId),
    slug: String(m.slug),
    at: String(m.at),
    links: m.links.map((l: any) => ({
      analyticId: String(l.analyticId),
      fromId: String(l.fromId),
      action: l.action as FillerAction,
      ...(l.toId ? { toId: String(l.toId) } : {}),
      ...(l.contact ? { contact: l.contact } : {}),
      entries: (l.entries ?? []).map((e: any) => ({ entryId: String(e.entryId), lines: (e.lines ?? []).map(Number) })),
    })),
  }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

export interface FillerResult {
  analytics: number
  entries: number
  lines: number
  /** Contacts made, for partners the org's entries book on. */
  created: number
  /** Links removed, for partners nothing books on. */
  unlinked: number
  failed: string[]
}

/** One audit row a run, the script's own (`via`): it acts as nobody in the org. It names the org, never a contact. */
async function audit(orgId: string, entityName: string, changes: Record<string, number>): Promise<void> {
  const written = await recordAuditEntry({
    orgId, userId: '', via: SCRIPT, action: 'update', module: 'accounting', entityType: 'contact', entityId: orgId, entityName,
    changes: Object.entries(changes).map(([field, newValue]) => ({ field, oldValue: null, newValue })),
  })
  if (!written) throw new Error('the audit row of the run was not written; the changes themselves were')
}

/**
 * Give each wrong link what the plan found for it. Every write is conditional on the link still being as the plan
 * saw it: one changed since is left as it was set, and reported.
 */
export async function applyFillerLinks(plan: FillerPlan): Promise<FillerResult> {
  const result: FillerResult = { analytics: 0, entries: 0, lines: 0, created: 0, unlinked: 0, failed: [] }
  if (!plan.links.length) return result
  const org = oid(plan.orgId)
  const changed = (l: FillerLink) => result.failed.push(`analytic ${l.analyticId}: no longer linked as the dry run saw it; left alone`)
  for (const l of plan.links) {
    const analytic = oid(l.analyticId)
    const from = oid(l.fromId)
    const linked = { _id: analytic, orgId: org, contactId: from }

    if (l.action === 'unlink') {
      // Booked on since the plan read it: it needs a contact now, and only a new plan gives it one.
      if (await JournalEntry.exists({ orgId: org, 'lines.analyticId': analytic })) {
        result.failed.push(`analytic ${l.analyticId}: booked on since the dry run; left alone, run the dry run again`)
        continue
      }
      const r = await AccountingAnalytic.updateOne(linked, { $unset: { contactId: 1 } }).exec()
      if (!r.modifiedCount) {
        changed(l)
        continue
      }
      result.analytics++
      result.unlinked++
      continue
    }

    const to = oid(l.toId)
    // Never pointed at nothing: a contact to make is made first, one found is read again.
    if (l.action === 'create') {
      await Contact.insertMany([l.contact])
    } else if (!await Contact.exists({ _id: to, orgId: org })) {
      result.failed.push(`analytic ${l.analyticId}: the contact found for it is gone; left alone`)
      continue
    }
    const r = await AccountingAnalytic.updateOne(linked, { $set: { contactId: to } }).exec()
    if (!r.modifiedCount) {
      // Nothing names the contact just made: it goes again.
      if (l.action === 'create') await Contact.deleteOne({ _id: to, orgId: org }).exec()
      changed(l)
      continue
    }
    result.analytics++
    if (l.action === 'create') result.created++

    // Every line of the org on this analytic that carries the other partner's contact: the plan's, and any an
    // import wrote since it read.
    const moved = await JournalEntry.updateMany(
      { orgId: org, lines: { $elemMatch: { analyticId: analytic, contactId: from } } },
      { $set: { 'lines.$[l].contactId': to } },
      { arrayFilters: [{ 'l.analyticId': analytic, 'l.contactId': from }] },
    ).exec()
    result.entries += moved.modifiedCount
    result.lines += l.entries.reduce((n, e) => n + e.lines.length, 0)
  }

  if (result.analytics) {
    await audit(plan.orgId, `books partner links made on a filler number put right (${SCRIPT})`, {
      links: result.analytics, analytics: result.analytics, entries: result.entries, lines: result.lines, created: result.created, unlinked: result.unlinked,
    })
  }
  return result
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────

export interface FillerUndoCounts {
  links: number
  analytics: number
  entries: number
  lines: number
  /** Contacts the run made that nothing names any more: removed. */
  contacts: number
  /** Contacts the run made that something names by now: kept. */
  kept: number
  /** Links whose former contact is gone: never pointed at nothing, left alone. */
  gone: number
}

/**
 * What `--undo` would take back, or takes back with `execute`: the analytics and lines the run changed that still
 * read as it left them point at the contact they pointed at before, and a contact the run made goes when nothing
 * names it after that.
 */
export async function undoFillerLinks(m: FillerManifest, execute: boolean): Promise<FillerUndoCounts> {
  const org = oid(m.orgId)
  const counts: FillerUndoCounts = { links: m.links.length, analytics: 0, entries: 0, lines: 0, contacts: 0, kept: 0, gone: 0 }
  for (const l of m.links) {
    const analytic = oid(l.analyticId)
    const from = oid(l.fromId)
    if (!await Contact.exists({ _id: from, orgId: org })) {
      counts.gone++
      continue
    }
    // As the run left it: the contact it gave, or none.
    const now = l.toId ? oid(l.toId) : null
    const left = { _id: analytic, orgId: org, contactId: now }
    counts.analytics += execute
      ? (await AccountingAnalytic.updateOne(left, { $set: { contactId: from } }).exec()).modifiedCount
      : await AccountingAnalytic.countDocuments(left).exec()
    if (!now) continue

    // The lines the run moved that still read as it left them: the contact it gave, on the same analytic.
    for (const batch of chunks(l.entries, 500)) {
      const held = new Map((await JournalEntry.find(
        { orgId: org, _id: { $in: batch.map(e => oid(e.entryId)) } },
        { 'lines.contactId': 1, 'lines.analyticId': 1 },
      ).lean().exec() as any[]).map(e => [String(e._id), e]))
      const todo = batch
        .map(e => ({
          entryId: e.entryId,
          lines: e.lines.filter(i => {
            const line = held.get(e.entryId)?.lines?.[i]
            return line && String(line.contactId) === l.toId && String(line.analyticId) === l.analyticId
          }),
        }))
        .filter(e => e.lines.length)
      counts.entries += todo.length
      counts.lines += todo.reduce((n, e) => n + e.lines.length, 0)
      if (!execute || !todo.length) continue
      await JournalEntry.bulkWrite(todo.map(e => ({
        updateOne: {
          filter: Object.assign(
            { orgId: org, _id: oid(e.entryId) },
            ...e.lines.map(i => ({ [`lines.${i}.contactId`]: now, [`lines.${i}.analyticId`]: analytic })),
          ),
          update: { $set: Object.fromEntries(e.lines.map(i => [`lines.${i}.contactId`, from])) },
        },
      })), { ordered: false })
    }
  }

  // A contact the run made goes when nothing names it. In a dry run the books still do, and would not after it.
  const made = m.links.filter(l => l.action === 'create' && l.toId).map(l => l.toId!)
  const there = made.length
    ? (await Contact.find({ orgId: org, _id: { $in: made.map(oid) } }, { _id: 1 }).lean().exec() as any[]).map(c => String(c._id))
    : []
  if (there.length) {
    const named = await namedOutsideBooks(m.orgId, there, new Date(m.at))
    const still = execute
      ? new Set([
          ...(await AccountingAnalytic.distinct('contactId', { orgId: org, contactId: { $in: there.map(oid) } }).exec()).map(String),
          ...(await JournalEntry.distinct('lines.contactId', { orgId: org, 'lines.contactId': { $in: there.map(oid) } }).exec()).map(String),
        ])
      : new Set<string>()
    const free = there.filter(id => !named.has(id) && !still.has(id))
    counts.contacts = free.length
    counts.kept = there.length - free.length
    if (execute && free.length) await Contact.deleteMany({ orgId: org, _id: { $in: free.map(oid) } }).exec()
  }

  if (execute && (counts.analytics || counts.lines || counts.contacts)) {
    await audit(m.orgId, `books partner links made on a filler number taken back (${SCRIPT} --undo)`, { ...counts })
  }
  return counts
}
