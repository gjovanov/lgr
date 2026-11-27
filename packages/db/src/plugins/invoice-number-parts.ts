import type { Schema } from 'mongoose'

/**
 * #929: an invoice's running number, stored, so the next number of a series is read from an index instead of
 * from every number the org ever issued (`services/biz/invoice-numbering.service#currentMaxSuffix`).
 *
 * The number is cut at its LAST dash: `numberHead` is what stands before it, `numberSeq` the digits after it.
 * `INV-2026-0000123` is `{ numberHead: 'INV-2026', numberSeq: 123 }`, `INV-0000000124` is `{ 'INV', 124 }`,
 * `DRF-INV-2026-00007` is `{ 'DRF-INV-2026', 7 }`. A number with no `-<digits>` at its end (a till placeholder
 * `~pending:…`, a copied till row's transaction number, a number with letters at its end) has no running number:
 * `{ numberHead: '', numberSeq: null }`.
 *
 * ⚠ Why the head and not a series key: which series a number belongs to is decided by the org's prefixes WHEN THE
 * NUMBER IS ASKED FOR (the registry's defaults, the org's renamed prefix, the legacy aliases: `seriesPrefixes`), as
 * the scan always did. A key fixed when the document is written would go stale when a prefix is renamed. The head
 * is a pure function of the number, so every writer, the raw ones included, can compute it with no database read,
 * and the reader matches heads against the prefixes of the moment:
 * - a yearly series of `year` is the heads `<prefix>-<year>`;
 * - a continuous one is the heads `<prefix>` and `<prefix>-<4 digits>` (the yearly numbers issued before the switch).
 * That is exactly the set the scan's pattern matched (`^(?:P…)-<year>-(\d+)$`, `^(?:P…)-(?:\d{4}-)?(\d+)$`): the
 * pattern ends in `-<digits>`, so its running number is the piece after the last dash, and what stands before it is
 * a head of that form. The value is the same too: the scan converted that piece to a double, `Number` does here.
 *
 * ⚠ `numberHead` is ALWAYS a string on a document that went through this, `''` when there is no running number. A
 * document without it (written before #929, or by an older server and not yet backfilled) is what the reader's
 * fallback scans, so a missing head never hides a number (`numberHead: null` in a query finds exactly those).
 *
 * ⚠ The fields are the server's alone. Every write is re-derived from `invoiceNumber`: a save, an `insertMany`, an
 * update or a replace (this plugin, which also drops any value an update names for them), and every raw driver
 * write that stores an invoice calls {@link withNumberParts} itself (replication's apply, the fenced and kept
 * imports, a move's import, a backup restore, an org copy, the till's POS copy). Migration
 * `0024-invoice-number-parts` fills them on the documents written before. They never travel between servers: a
 * move's bundle leaves them out, and the digests that compare two servers' copies skip them
 * ({@link DERIVED_FIELDS}), so a server of an older version, which does not know them, compares equal.
 */
export interface InvoiceNumberParts {
  numberHead: string
  numberSeq: number | null
}

export const NUMBER_PART_FIELDS = ['numberHead', 'numberSeq'] as const

/** Fields every server derives for itself, by collection: never carried in a bundle, never compared. */
export const DERIVED_FIELDS: Readonly<Record<string, readonly string[]>> = { invoices: NUMBER_PART_FIELDS }

const DIGITS = /^[0-9]+$/

/** The ONE parse of a document number into its head and running number. Pure: no database, no org. */
export function numberPartsOf(invoiceNumber: unknown): InvoiceNumberParts {
  const none = { numberHead: '', numberSeq: null }
  // The scan matched a pattern on the stored value, which only a string matches.
  if (typeof invoiceNumber !== 'string') return none
  const cut = invoiceNumber.lastIndexOf('-')
  if (cut < 0) return none
  const tail = invoiceNumber.slice(cut + 1)
  if (!DIGITS.test(tail)) return none
  const n = Number(tail)
  // Digits past a double's range: the scan's conversion failed on them and counted 0, which is no number.
  if (!Number.isFinite(n)) return none
  return { numberHead: invoiceNumber.slice(0, cut), numberSeq: n }
}

/** A raw invoice with its parts derived from its own number: a new object, the original left as it was. */
export function withNumberParts<T extends Record<string, unknown>>(doc: T): T & InvoiceNumberParts {
  return { ...doc, ...numberPartsOf(doc.invoiceNumber) }
}

/** For a copier of any collection: the document with what this server derives for that collection. */
export function withDerivedFields<T extends Record<string, unknown>>(collection: string, doc: T): T {
  return collection === 'invoices' ? withNumberParts(doc) : doc
}

/** `doc` without the derived fields of its collection (a shallow copy when it has any). */
export function withoutDerivedFields<T extends Record<string, unknown>>(collection: string, doc: T): T {
  const drop = DERIVED_FIELDS[collection]
  if (!drop || !drop.some(f => f in doc)) return doc
  const out: Record<string, unknown> = { ...doc }
  for (const f of drop) delete out[f]
  return out as T
}

type Place = Record<string, unknown>
const isPlace = (v: unknown): v is Place => !!v && typeof v === 'object' && !Array.isArray(v)
const names = (place: unknown, field: string): place is Place => isPlace(place) && Object.prototype.hasOwnProperty.call(place, field)

/** Operators that could write a part by themselves; any of them naming one loses it. */
const OTHER_OPERATORS = ['$unset', '$inc', '$mul', '$min', '$max', '$rename', '$currentDate', '$push', '$addToSet', '$pull', '$pullAll', '$pop']

/**
 * An update's parts follow its number: what it names for the parts goes, and a number it sets gets its parts beside
 * it, in the same place (the top level, which Mongoose takes as a `$set`, `$set` or `$setOnInsert`). A number it
 * removes leaves no running number. An aggregation-pipeline update is left alone: nothing writes a number that way.
 */
export function ownNumberParts(update: unknown): void {
  if (!isPlace(update)) return
  for (const place of [update, update.$set, update.$setOnInsert]) {
    if (!isPlace(place)) continue
    for (const f of NUMBER_PART_FIELDS) delete place[f]
    if (names(place, 'invoiceNumber')) Object.assign(place, numberPartsOf(place.invoiceNumber))
  }
  for (const op of OTHER_OPERATORS) {
    const place = update[op]
    if (isPlace(place)) for (const f of NUMBER_PART_FIELDS) delete place[f]
  }
  if (names(update.$unset, 'invoiceNumber')) update.$set = { ...(isPlace(update.$set) ? update.$set : {}), ...numberPartsOf(undefined) }
}

/** Keeps `numberHead` / `numberSeq` on every Mongoose write of the schema (see the header). */
export function invoiceNumberPartsPlugin(schema: Schema): void {
  schema.pre('save', function () {
    this.set(numberPartsOf(this.get('invoiceNumber')))
  })

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: unknown) {
    if (Array.isArray(docs)) {
      for (const doc of docs) if (isPlace(doc)) Object.assign(doc, numberPartsOf(doc.invoiceNumber))
    }
    next()
  })

  schema.pre('findOneAndUpdate', onUpdate)
  schema.pre('updateOne', onUpdate)
  schema.pre('updateMany', onUpdate)
  schema.pre('replaceOne', onReplace)
  schema.pre('findOneAndReplace', onReplace)
}

/** The part of a Mongoose query these hooks use. */
interface UpdateQueryLike {
  getUpdate(): unknown
  setUpdate(update: unknown): void
}

function onUpdate(this: UpdateQueryLike): void {
  const update = this.getUpdate()
  if (!isPlace(update)) return
  ownNumberParts(update)
  this.setUpdate(update)
}

function onReplace(this: UpdateQueryLike): void {
  const replacement = this.getUpdate()
  if (!isPlace(replacement)) return
  for (const f of NUMBER_PART_FIELDS) delete replacement[f]
  Object.assign(replacement, numberPartsOf(replacement.invoiceNumber))
  this.setUpdate(replacement)
}
