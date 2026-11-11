import { describe, it, expect } from 'bun:test'
import { mongoose } from 'db/connection'
import { refLeaves, refsInDocument, refsInUpdate } from 'db/plugins/reference-guard'
const { Schema } = mongoose

/**
 * Which fields of a write are references (`db/plugins/reference-guard.ts`): read from the schema,
 * at any depth, and from every way an update can set them. The guard asks the database about
 * exactly these, so a field missed here is a field it never checks.
 */

const oid = () => String(new mongoose.Types.ObjectId())

const line = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  description: String,
  orderRef: { reservationId: { type: Schema.Types.ObjectId, ref: 'Reservation' }, note: String },
})
const address = new Schema({ street: String, regionId: { type: Schema.Types.ObjectId, ref: 'Region' } }, { _id: false })
const schema = new Schema({
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  plainId: { type: Schema.Types.ObjectId }, // no ref: not a reference
  byFunction: { type: Schema.Types.ObjectId, ref: () => 'Contact' }, // decided per document: not knowable
  invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
  lines: [line],
  billing: address,
  meta: { warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' } },
})

const paths = (refs: Array<{ path: string; id: string }>) => refs.map(r => `${r.path}=${r.id}`).sort()

describe('reference fields come from the schema', () => {
  it('top level, arrays of ids, document arrays, nested objects and single subdocuments; nothing without a named ref', () => {
    expect(refLeaves(schema).map(l => `${l.path.join('.')}→${l.ref}`).sort()).toEqual([
      'billing.regionId→Region',
      'contactId→Contact',
      'createdBy→User',
      'invoiceIds.*→Invoice',
      'lines.*.orderRef.reservationId→Reservation',
      'lines.*.productId→Product',
      'meta.warehouseId→Warehouse',
    ])
  })
})

describe('refsInDocument', () => {
  it('collects every id a document carries, cast the way the write would cast it', () => {
    const [c, i1, i2, p1, p2, r1, w, g] = Array.from({ length: 8 }, oid)
    const refs = refsInDocument(schema, {
      contactId: c, plainId: oid(), invoiceIds: [i1, i2],
      lines: [{ productId: p1, orderRef: { reservationId: r1 } }, { productId: { _id: p2, name: 'populated' } }, { description: 'service line' }],
      billing: { regionId: g }, meta: { warehouseId: w },
    })
    expect(paths(refs)).toEqual([
      `billing.regionId=${g}`, `contactId=${c}`, `invoiceIds=${i1}`, `invoiceIds=${i2}`,
      `lines.orderRef.reservationId=${r1}`, `lines.productId=${p1}`, `lines.productId=${p2}`, `meta.warehouseId=${w}`,
    ].sort())
  })

  it('skips what is no id at all (the write fails on its own), and empty values', () => {
    expect(refsInDocument(schema, { contactId: 'not-an-id', createdBy: '', lines: [{ productId: null }], invoiceIds: [] })).toEqual([])
  })

  it('only the top-level fields a save changes, when told which', () => {
    const [c, p] = [oid(), oid()]
    expect(paths(refsInDocument(schema, { contactId: c, lines: [{ productId: p }] }, new Set(['lines'])))).toEqual([`lines.productId=${p}`])
  })
})

describe('refsInUpdate', () => {
  it('reads $set (dotted, numeric and positional paths), $setOnInsert, $push / $addToSet with or without $each, and plain fields', () => {
    const ids = Array.from({ length: 9 }, oid)
    const refs = refsInUpdate(schema, {
      $set: { 'lines.3.productId': ids[0], 'lines.$[l].orderRef.reservationId': ids[1], 'meta.warehouseId': ids[2] },
      $setOnInsert: { createdBy: ids[3] },
      $push: { lines: { $each: [{ productId: ids[4] }, { productId: ids[5] }] } },
      $addToSet: { invoiceIds: ids[6] },
      contactId: ids[7],
      billing: { regionId: ids[8] },
    })
    expect(paths(refs)).toEqual([
      `lines.productId=${ids[0]}`, `lines.orderRef.reservationId=${ids[1]}`, `meta.warehouseId=${ids[2]}`, `createdBy=${ids[3]}`,
      `lines.productId=${ids[4]}`, `lines.productId=${ids[5]}`, `invoiceIds=${ids[6]}`, `contactId=${ids[7]}`, `billing.regionId=${ids[8]}`,
    ].sort())
  })

  it('a whole array element set by index, and a whole array replaced', () => {
    const [a, b, c] = [oid(), oid(), oid()]
    expect(paths(refsInUpdate(schema, { $set: { 'lines.0': { productId: a }, invoiceIds: [b, c] } }))).toEqual(
      [`invoiceIds=${b}`, `invoiceIds=${c}`, `lines.productId=${a}`].sort(),
    )
  })

  it('ignores what sets no reference: $inc, $unset, a pipeline update, a field that is no reference', () => {
    expect(refsInUpdate(schema, { $inc: { n: 1 }, $unset: { contactId: '' } })).toEqual([])
    expect(refsInUpdate(schema, [{ $set: { contactId: oid() } }])).toEqual([])
    expect(refsInUpdate(schema, { $set: { plainId: oid(), description: 'x' } })).toEqual([])
  })
})
