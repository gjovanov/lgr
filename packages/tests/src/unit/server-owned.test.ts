import { describe, it, expect } from 'bun:test'
import { Glob } from 'bun'
import { mongoose } from 'db/connection'
import 'db/models'
import { ALWAYS_SERVER_OWNED, SERVER_OWNED, ServerOwnedFieldError, clientCreate, clientUpdate, type OwnedModel } from 'services/biz/server-owned'

/**
 * A body may restate a field the server sets, never choose it (`services/biz/server-owned.ts`).
 *
 * The rule itself, the table against the schemas, and the two static checks that keep a
 * thirteenth "store the body as the document" controller from arriving unnoticed.
 */

const refused = (fn: () => unknown): any => {
  try { fn() } catch (e) { return e }
  return null
}

const A = '6a0000000000000000000001'
const ME = '6a00000000000000000000aa'
const OTHER = '6a00000000000000000000bb'

describe('a new document', () => {
  it('keeps every field that is the body\'s to give', () => {
    const body = { type: 'receipt', amount: 12.5, party: 'Иван', accountId: A, lines: [{ a: 1 }] }
    expect(clientCreate('CashOrder', body, { orgId: A, createdBy: ME })).toEqual(body)
  })

  it('takes a server-set field left empty, and drops it', () => {
    const out = clientCreate('CashOrder', { type: 'receipt', orderNumber: '', journalEntryId: null, _id: '', createdBy: undefined }, { orgId: A, createdBy: ME })
    expect(out).toEqual({ type: 'receipt' })
  })

  it('takes a server-set field that says what the server is about to set, and drops it', () => {
    const out = clientCreate('PaymentOrder', { amount: 1, status: 'draft', createdBy: ME, orgId: A }, { orgId: A, createdBy: ME, status: 'draft' })
    expect(out).toEqual({ amount: 1 })
  })

  it.each([
    ['PaymentOrder', 'status', 'executed'],
    ['PaymentOrder', 'orderNumber', 'PO-2026-00001'],
    ['PaymentOrder', 'createdBy', OTHER],
    ['PaymentOrder', 'executedAt', '2026-01-01T00:00:00.000Z'],
    ['InventoryCount', 'status', 'completed'],
    ['InventoryCount', 'adjustmentMovementId', OTHER],
    ['InventoryCount', 'completedBy', ME],
    ['Payslip', 'sealed', 'v1:abc'],
    ['Payslip', 'engine', 'bg'],
    ['Timesheet', 'approvedBy', ME],
    ['BankReconciliation', 'reconciledBy', ME],
    ['PriceList', 'deactivatedAt', '2020-01-01'],
    ['FiscalYear', 'closingEntryId', OTHER],
    // On every model: its identity, its org, its timestamps.
    ['BankAccount', '_id', OTHER],
    ['BankAccount', 'id', OTHER],
    ['BankAccount', 'orgId', OTHER],
    ['BankAccount', 'createdAt', '2020-01-01T00:00:00.000Z'],
    ['BankAccount', 'updatedAt', '2020-01-01T00:00:00.000Z'],
    ['BankAccount', '__v', 7],
  ] as Array<[OwnedModel, string, unknown]>)('%s: a body that chooses %s is refused', (model, field, value) => {
    const err = refused(() => clientCreate(model, { name: 'x', [field]: value }, { orgId: A, createdBy: ME, status: model === 'InventoryCount' ? 'in_progress' : 'draft' }))
    expect(err).toBeInstanceOf(ServerOwnedFieldError)
    expect(err.path).toBe(field)
    expect(err.code).toBe('server_owned_field')
    expect(err.statusCode).toBe(422)
  })

  it('an object where a word belongs is never "the same"', () => {
    expect(refused(() => clientCreate('PaymentOrder', { status: { $ne: 'x' } }, { status: 'draft' }))).toBeInstanceOf(ServerOwnedFieldError)
    expect(refused(() => clientCreate('PaymentOrder', { status: ['draft'] }, { status: 'draft' }))).toBeInstanceOf(ServerOwnedFieldError)
  })
})

describe('a stored document', () => {
  const stored = {
    id: A, _id: A, orgId: OTHER, orderNumber: 'PO-2026-00007', createdBy: ME, status: 'draft', amount: 5,
    createdAt: new Date('2026-11-01T10:00:00.000Z'), updatedAt: new Date('2026-11-02T10:00:00.000Z'),
  }

  it('keeps every field that is the body\'s to change', () => {
    expect(clientUpdate('PaymentOrder', { amount: 9, description: 'x' }, stored)).toEqual({ amount: 9, description: 'x' })
  })

  it('a document sent back as it was loaded still saves: restated fields are dropped, not refused', () => {
    const loaded = JSON.parse(JSON.stringify(stored)) // what a client holds: ids and dates as strings
    delete loaded.orgId // S-25: a PUT's schema refuses any `orgId` before the handler
    expect(clientUpdate('PaymentOrder', { ...loaded, amount: 6 }, stored)).toEqual({ amount: 6 })
  })

  it('`updatedAt` is never an ask: it moves under a caller who sends the document back', () => {
    expect(clientUpdate('PaymentOrder', { updatedAt: '2001-01-01T00:00:00.000Z', amount: 6 }, stored)).toEqual({ amount: 6 })
  })

  it.each([
    ['status', 'executed'],
    ['status', ''], // clearing is a change too
    ['status', null],
    ['orderNumber', 'PO-2026-00001'],
    ['createdBy', OTHER],
    ['executedAt', '2026-01-01T00:00:00.000Z'],
    ['journalEntryId', OTHER],
    ['_id', OTHER],
    ['id', OTHER],
    ['createdAt', '2020-01-01T00:00:00.000Z'],
    ['__v', 3],
  ] as Array<[string, unknown]>)('a body that changes %s to %p is refused', (field, value) => {
    const err = refused(() => clientUpdate('PaymentOrder', { amount: 6, [field]: value }, stored))
    expect(err).toBeInstanceOf(ServerOwnedFieldError)
    expect(err.path).toBe(field)
  })

  it('a date is compared as a moment, whatever its spelling', () => {
    expect(clientUpdate('PaymentOrder', { createdAt: '2026-11-01T12:00:00.000+02:00' }, stored)).toEqual({})
    expect(clientUpdate('PaymentOrder', { createdAt: stored.createdAt.getTime() }, stored)).toEqual({})
    expect(refused(() => clientUpdate('PaymentOrder', { createdAt: 'yesterday' }, stored))).toBeInstanceOf(ServerOwnedFieldError)
  })
})

describe('a body is data, never an update document', () => {
  it.each([
    [{ $set: { status: 'executed' } }],
    [{ $unset: { createdBy: 1 } }],
    [{ 'lines.0.varianceCost': 999 }],
    [{ 'period.from': '2020-01-01' }],
  ])('%j is refused on a save and on a create', (body) => {
    for (const run of [() => clientUpdate('InventoryCount', body, { id: A }), () => clientCreate('InventoryCount', body)]) {
      const err = refused(run)
      expect(err?.name).toBe('ValidationError')
      expect(err?.code).toBe('VALIDATION') // what `spaErrorHandler` answers 422 for
      expect(String(err?.message)).toContain(Object.keys(body)[0])
    }
  })

  it.each([[undefined], [null], ['{"a":1}'], [[{ a: 1 }]], [42]])('%p is not a document body', (body) => {
    expect(refused(() => clientCreate('BankAccount', body))?.code).toBe('VALIDATION')
    expect(refused(() => clientUpdate('BankAccount', body, { id: A }))?.code).toBe('VALIDATION')
  })

  it('a field inside a line may carry a dot-free name of its own: only the top level is the document\'s', () => {
    const body = { lines: [{ productId: A, countedQuantity: 2 }] }
    expect(clientUpdate('InventoryCount', body, { id: A })).toEqual(body)
  })
})

describe('the table and the schemas', () => {
  it('every model named is a model, and every field named is a path of its schema', () => {
    const missing: string[] = []
    for (const [name, fields] of Object.entries(SERVER_OWNED)) {
      const model = mongoose.models[name]
      if (!model) { missing.push(`${name}: no such model`); continue }
      for (const f of fields) if (!model.schema.path(f)) missing.push(`${name}.${f}`)
    }
    expect(missing).toEqual([])
  })

  it('on these models, a field that says who did something or when is the server\'s, or is listed here as the body\'s', () => {
    // A stamp added to one of these schemas next year is caught the day it is added: it is the
    // server's (list it in SERVER_OWNED) or deliberately the body's (list it here, with why).
    const BODYS: Record<string, string> = {
      'BankAccount.lastReconciledDate': 'no server path sets it yet; the screens do not send it',
      'Payslip.sentAt': 'no server path sets it; a hand-made slip says when it was sent',
      'Payslip.paidAt': 'no server path sets it; a hand-made slip says when it was paid',
    }
    const STAMP = /(By|At|edDate)$/
    const loose: string[] = []
    const seen = new Set<string>()
    for (const [name, fields] of Object.entries(SERVER_OWNED)) {
      const ownedHere = new Set<string>([...ALWAYS_SERVER_OWNED, ...fields])
      mongoose.models[name].schema.eachPath((path) => {
        if (path.includes('.') || !STAMP.test(path) || ownedHere.has(path)) return
        seen.add(`${name}.${path}`)
        if (!BODYS[`${name}.${path}`]) loose.push(`${name}.${path}`)
      })
    }
    expect(loose).toEqual([])
    // A waiver for a field that is gone, or the server's by now, is removed with it.
    expect(Object.keys(BODYS).filter(k => !seen.has(k))).toEqual([])
  })
})

describe('no controller stores a body as the document unguarded', () => {
  const root = new URL('../../../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
  const controllers = async () => {
    const out: Array<{ file: string; text: string }> = []
    for await (const f of new Glob('*-api/src/controllers/*.ts').scan(root)) out.push({ file: f.replace(/\\/g, '/'), text: await Bun.file(root + f).text() })
    return out.sort((a, b) => a.file.localeCompare(b.file))
  }
  // A store call handed the body itself: spread, or cast, with nothing in between.
  const RAW_STORE = /\.(create|createMany|update|updateInOrg|updateMany|findOneAndUpdate)\([^\n]*(\.\.\.\(?body\b|\bbody as any\b)/

  /**
   * The controllers that hand a body straight to the store, each reviewed: its routes declare
   * the body's fields, and Elysia drops what a schema does not declare (the integration test
   * `server-owned-fields.flow` proves that on a real route).
   */
  const DECLARED = [
    'accounting-api/src/controllers/fiscal-position.controller.ts',
    'accounting-api/src/controllers/journal-config.controller.ts',
    'accounting-api/src/controllers/payment-term.controller.ts',
    'accounting-api/src/controllers/tax-return.controller.ts',
    'invoicing-api/src/controllers/contact.controller.ts',
    'invoicing-api/src/controllers/invoice.controller.ts',
    'payroll-api/src/controllers/run.controller.ts',
    'portal-api/src/controllers/fiscal-device.controller.ts',
    'portal-api/src/controllers/pos-payment-method.controller.ts',
    'warehouse-api/src/controllers/movement.controller.ts',
    'warehouse-api/src/controllers/operation-type.controller.ts',
    'warehouse-api/src/controllers/product-category.controller.ts',
    'warehouse-api/src/controllers/stock-location.controller.ts',
    'warehouse-api/src/controllers/stock-lot.controller.ts',
    'warehouse-api/src/controllers/warehouse.controller.ts',
  ]

  it('a store call takes the body itself only in a controller reviewed for it', async () => {
    const raw = (await controllers()).filter(c => c.text.split('\n').some(l => RAW_STORE.test(l))).map(c => c.file)
    expect(raw).toEqual(DECLARED)
  })

  it('a body schema that keeps undeclared fields belongs to a controller that goes through the guard, both ways', async () => {
    // `{ additionalProperties: true }` on a body is what "takes any field" looks like. Two
    // schemas keep it for other reasons: neither is stored as a document.
    const NOT_A_DOCUMENT = new Set([
      'payroll-api/src/controllers/import.controller.ts', // rows of an import file, mapped field by field
      'portal-api/src/controllers/node-v1.controller.ts', // a node's report, read field by field
    ])
    const open = (await controllers()).filter(c => /additionalProperties:\s*true/.test(c.text) && !NOT_A_DOCUMENT.has(c.file))
    expect(open.length).toBe(Object.keys(SERVER_OWNED).length)
    const unguarded: string[] = []
    const named = new Set<string>()
    for (const c of open) {
      const made = c.text.match(/clientCreate\('(\w+)'/)
      const saved = c.text.match(/clientUpdate\('(\w+)'/)
      if (!made || !saved || made[1] !== saved[1] || !(made[1] in SERVER_OWNED)) unguarded.push(c.file)
      else named.add(made[1])
      if (RAW_STORE.test(c.text)) unguarded.push(`${c.file}: still stores the body itself`)
    }
    expect(unguarded).toEqual([])
    expect([...named].sort()).toEqual(Object.keys(SERVER_OWNED).sort())
  })
})
