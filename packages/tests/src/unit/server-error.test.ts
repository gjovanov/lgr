import { describe, it, expect } from 'bun:test'
import { mongoose } from 'db/connection'
const { Schema } = mongoose
import { errorRef, INTERNAL_MESSAGE, isInternalError, serverErrorMessage } from '../../../portal-api/src/lib/server-error.js'

/**
 * S-12: what a 500 may say. The server's own words pass; the machinery's (the database, the
 * schema layer, the runtime, the disk) never do, except a schema rejection and a duplicate key,
 * which are said plainly because a person can act on them.
 */

const REF = 'abc1234567'

/** A real Mongoose schema rejection, of the kinds a document can fail with. */
function schemaRejection(): any {
  const address = new Schema({ street: String, postalCode: { type: String, required: true } }, { _id: false })
  const schema = new Schema({
    status: { type: String, enum: ['draft', 'sent'] },
    quantity: { type: Number, min: 1 },
    productId: Schema.Types.ObjectId,
    billingAddress: address,
    code: { type: String, validate: { validator: (v: string) => /^\d{4}$/.test(v), message: 'an operator code is four digits' } },
  })
  const Model = mongoose.models.ServerErrorProbe || mongoose.model('ServerErrorProbe', schema)
  return new Model({ status: 'zzz', quantity: 0, productId: 'nope', billingAddress: { street: 'x' }, code: '12' }).validateSync()
}

/** The driver's duplicate key, as `MongoServerError` carries it. */
function duplicateKey(keyPattern: Record<string, number> = { orgId: 1, sku: 1 }): any {
  return Object.assign(
    new Error('E11000 duplicate key error collection: lgr.products index: orgId_1_sku_1 dup key: { orgId: ObjectId(\'6a8d0000\'), sku: "PRD-1" }'),
    { name: 'MongoServerError', code: 11000, keyPattern, keyValue: { orgId: 'x', sku: 'PRD-1' } },
  )
}

describe('S-12: what a 500 says', () => {
  it('passes the server\'s own words as they are', () => {
    expect(serverErrorMessage(new Error('Insufficient stock for Болт М8'), REF)).toBe('Insufficient stock for Болт М8')
    class RegisterRefusal extends Error {}
    expect(serverErrorMessage(new RegisterRefusal('The session is closed'), REF)).toBe('The session is closed')
  })

  it('says only the reference for the runtime\'s own errors', () => {
    const typeError = new TypeError("Cannot read properties of undefined (reading 'lines')")
    expect(isInternalError(typeError)).toBe(true)
    expect(serverErrorMessage(typeError, REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    expect(serverErrorMessage(new RangeError('ISL SEQ out of range: 0x1f'), REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
  })

  it('says only the reference for the database and the schema layer', () => {
    const cast = new mongoose.Error.CastError('ObjectId', 'nope', '_id')
    expect(serverErrorMessage(cast, REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    for (const name of ['MongoServerError', 'MongoNetworkTimeoutError', 'MongooseServerSelectionError', 'BSONError', 'VersionError']) {
      const e = Object.assign(new Error(`${name}: connection 4 to 192.0.2.10:27017 closed`), { name })
      expect(serverErrorMessage(e, REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    }
  })

  it('says only the reference for a file or socket the server could not use', () => {
    const fileError = Object.assign(new Error("ENOENT: no such file or directory, open '/app/uploads/x.pdf'"), { code: 'ENOENT', errno: -2, syscall: 'open' })
    expect(serverErrorMessage(fileError, REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    const refused = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' })
    expect(serverErrorMessage(refused, REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
  })

  it('says only the reference when a message quotes a path on the server', () => {
    for (const m of [
      'Cannot open /app/packages/reporting/fonts/x.ttf',
      'Template missing at C:\\dev\\lgr\\packages\\reporting\\x.md',
      'Failed to launch the browser process: /home/bun/.cache/puppeteer/chrome/linux',
      'Cannot find module node_modules/exceljs/dist/es5',
      'Could not load file:///tmp/render-1.html',
    ]) {
      expect(serverErrorMessage(new Error(m), REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    }
    // A sentence with a slash in it is not a path.
    expect(serverErrorMessage(new Error('Quantity 3/4 is more than the 2 in stock'), REF)).toBe('Quantity 3/4 is more than the 2 in stock')
  })

  it('names the fields a schema refused, without the model, the cast or the values', () => {
    const said = serverErrorMessage(schemaRejection(), REF)
    expect(said.startsWith('Not saved: ')).toBe(true)
    expect(said).toContain('"billingAddress.postalCode" is required')
    expect(said).toContain('"status" is not one of the allowed values')
    expect(said).toContain('"quantity" is too small')
    expect(said).toContain('"productId" is not valid')
    expect(said).toContain('"code": an operator code is four digits')
    for (const internal of ['ServerErrorProbe', 'validation failed', 'Cast to ObjectId', 'BSONError', 'zzz', 'nope', 'Path `']) {
      expect(said).not.toContain(internal)
    }
  })

  it('counts the fields past the fifth instead of naming them', () => {
    const errors: Record<string, any> = {}
    for (let i = 0; i < 8; i++) errors[`lines.${i}.quantity`] = { kind: 'required' }
    const e = Object.assign(new Error('Invoice validation failed'), { name: 'ValidationError', errors })
    const said = serverErrorMessage(e, REF)
    expect(said).toContain('"lines.4.quantity" is required')
    expect(said).not.toContain('"lines.5.quantity"')
    expect(said.endsWith('(and 3 more)')).toBe(true)
  })

  it('says a duplicate key plainly: which field, never the database, collection, index or values', () => {
    const said = serverErrorMessage(duplicateKey(), REF)
    expect(said).toBe('Not saved: another record already has the same "sku"')
    expect(serverErrorMessage(duplicateKey({ orgId: 1, contactId: 1, number: 1 }), REF))
      .toBe('Not saved: another record already has the same "contactId" and "number"')
    // A bulk write's, and one with no key pattern at all.
    const bulk = Object.assign(new Error('E11000 duplicate key error'), { name: 'MongoBulkWriteError', writeErrors: [{ code: 11000, err: { keyPattern: { orgId: 1, movementNumber: 1 } } }] })
    expect(serverErrorMessage(bulk, REF)).toBe('Not saved: another record already has the same "movementNumber"')
    expect(serverErrorMessage(Object.assign(new Error('E11000 duplicate key error'), { name: 'MongoServerError', code: 11000 }), REF))
      .toBe('Not saved: another record already has the same value')
  })

  it('treats a thrown value that is not an Error as internal, and an empty message too', () => {
    expect(serverErrorMessage('boom', REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    expect(serverErrorMessage({ message: 'collection lgr.products is locked' }, REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
    expect(serverErrorMessage(new Error(''), REF)).toBe(`${INTERNAL_MESSAGE} (ref ${REF})`)
  })

  it('gives each failure its own short reference', () => {
    const refs = new Set(Array.from({ length: 50 }, () => errorRef()))
    expect(refs.size).toBe(50)
    for (const r of refs) expect(r).toMatch(/^[0-9a-f]{10}$/)
  })
})
