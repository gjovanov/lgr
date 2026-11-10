import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse,
  createTestStockLevel, createTestStockMovement, createTestTag, createTestFiscalDevice, createTestInvite,
  createTestNotification,
} from '../helpers/factories'
import { mongoose } from 'db/connection'
import { AuditLog, Identity, Invoice, LeaveBalance, Org, OrgApp, OrgLogo, PermissionSet, Product, Role, Sequence, StockLevel, Tag, User } from 'db/models'
import { tenantCollections } from 'services/biz/backup/backup-bundle.service'
import {
  OrgCloneError, assertCloneAllowed, cloneOrgData, compareOrgs, convertToTestOrg, createTestOrgFrom,
  markOrgEnvironment, resetOrgData, scanCopyForLeaks,
} from 'services/biz/org-clone/clone.service'
import { cloneIdHex } from 'services/biz/org-clone/ids'
import { contentHash } from 'services/biz/org-clone/canonical'

/**
 * A test copy of a real org (`services/biz/org-clone`).
 *
 * The things that must hold, each a hazard on a real shop's data:
 *  - the copy is written only into an org marked dev, and never from one;
 *  - nothing that reaches outward (hardware, invites, mail logs, credentials, files) is copied,
 *    and the daily digest and nightly backup are off on the copy;
 *  - every reference in the copy points at a document of the COPY: not one id of the real org
 *    is left in it (that would be a link into another tenant), and the real org is not changed;
 *  - a second run changes nothing; a later run brings across what is new and what changed, leaves
 *    what only the test org holds, and survives a unique-index clash;
 *  - people who are already members of the test org are matched by who they are, not copied twice,
 *    and a membership the copy adds is switched off unless it is an admin's on the first copy.
 */

beforeAll(async () => {
  await setupTestDB()
  await Promise.all([Identity.init(), User.init(), Invoice.init(), Product.init(), Sequence.init(), PermissionSet.init(), Role.init(), StockLevel.init()])
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

let seq = 0
const slugOf = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`
const coll = (name: string) => mongoose.models[name].collection
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id))

async function person(label: string) {
  return Identity.create({
    email: `${label}-${Date.now()}-${++seq}@x.test`,
    firstName: label,
    lastName: 'Person',
    password: await Bun.password.hash(crypto.randomUUID()),
    passwordSetBy: 'self',
  })
}

/** A real shop: two warehouses, an admin and a seller, stock, documents, numbering, and the things that must not be copied. */
async function realShop(label = 'real') {
  const org = await createTestOrg({ slug: slugOf(label), name: `Real ${label}` } as any)
  await Org.updateOne({ _id: org._id }, {
    $set: {
      'settings.environment': 'prod',
      'settings.accounting.books': { mode: 'branch', branchCode: 'PZ' },
      'settings.dailyDigest': { enabled: true, hour: 7, recipients: [] },
      'settings.backup': { enabled: true },
      'settings.integrations': { googleDrive: { accessToken: 'tok', refreshToken: 'ref', email: 'a@b.c' } },
      taxNumber: 'BG123456789',
      vatNumber: 'BG123456789',
      addresses: [{ type: 'billing', street: '1 Main', city: 'Pazardzhik', postalCode: '4400', country: 'BG' }],
      bankDetails: [{ bankName: 'A Bank', iban: 'BG00AAAA11112222333344' }],
    },
  })
  const wh1 = await createTestWarehouse(org._id, { code: 'pz', isDefault: true })
  const wh2 = await createTestWarehouse(org._id, { code: 'sf' })

  const adminPerson = await person('admin')
  const sellerPerson = await person('seller')
  const admin = await createTestUser(org._id, { identityId: adminPerson._id, role: 'admin', username: `admin-${seq}`, email: `admin-${seq}@x.test` } as any)
  const seller = await createTestUser(org._id, { identityId: sellerPerson._id, role: 'seller', username: `seller-${seq}`, email: `seller-${seq}@x.test`, operatorCode: '0002' } as any)
  const sellerSet = await PermissionSet.create({ orgId: org._id, name: 'Seller', description: 'the counter', permissions: ['invoicing.read'], isSystem: true } as any)
  const sellerRole = await Role.create({ orgId: org._id, name: 'Seller', isBuiltin: true, templateKey: 'seller', caps: [], legacy: { role: 'seller', permissions: [] } } as any)
  await User.updateOne({ _id: seller._id }, { $set: { permissionSetIds: [sellerSet._id], roleId: sellerRole._id } })
  await Org.updateOne({ _id: org._id }, { $set: { ownerId: admin._id } })

  const contact = await createTestContact(org._id)
  const products = [
    await createTestProduct(org._id, { name: 'Bolt M8', sku: `B-${seq}-1` } as any),
    await createTestProduct(org._id, { name: 'Nut M8', sku: `B-${seq}-2` } as any),
    await createTestProduct(org._id, { name: 'Washer', sku: `B-${seq}-3` } as any),
  ]
  await createTestStockLevel(org._id, products[0]._id, wh1._id, { quantity: 40, availableQuantity: 40 } as any)
  await createTestStockLevel(org._id, products[1]._id, wh1._id, { quantity: 7, availableQuantity: 7 } as any)

  // A file the invoice attaches: the copy carries no file store, so this row is never copied.
  const fileId = new mongoose.Types.ObjectId()
  await coll('File').insertOne({ _id: fileId, orgId: org._id, name: 'scan.pdf', storagePath: `${org._id}/docs/scan.pdf`, module: 'invoicing' })

  const invoices = [
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: `INV-2026-${String(seq).padStart(5, '0')}1`,
      status: 'sent',
      createdBy: admin._id,
      attachments: [fileId],
      // A tag that names the document it came from: the id is INSIDE the text.
      tags: [`converted-from:${products[0]._id}`, 'plain'],
      lines: [{
        description: 'Bolt', quantity: 3, unit: 'pcs', unitPrice: 5, discount: 0, taxRate: 20, taxAmount: 3, lineTotal: 18,
        productId: products[0]._id, warehouseId: wh1._id,
      }],
    } as any),
    await createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-2026-${String(seq).padStart(5, '0')}2`, createdBy: seller._id } as any),
  ]
  const movement = await createTestStockMovement(org._id, {
    type: 'dispatch', status: 'completed', toWarehouseId: wh1._id, invoiceId: invoices[0]._id, createdBy: admin._id,
    lines: [{ productId: products[0]._id, quantity: 3, unitCost: 5, totalCost: 15 }],
  } as any)
  await createTestTag(org._id)
  await OrgApp.create({ orgId: org._id, appId: 'accounting', enabled: true })
  await OrgApp.create({ orgId: org._id, appId: 'invoicing', enabled: true })
  await Sequence.create({ orgId: org._id, prefix: 'INV', year: 2026, lastNumber: 5 })
  await Sequence.create({ orgId: org._id, prefix: 'SM', year: 2026, lastNumber: 9, displayPrefix: 'SKL' })
  await AuditLog.create({
    orgId: org._id, userId: admin._id, action: 'create', module: 'invoicing', entityType: 'invoice',
    entityId: invoices[0]._id, entityName: 'an invoice',
  } as any)

  const png = Buffer.from('not really a png')
  await OrgLogo.create({ orgId: org._id, data: png, mimeType: 'image/png', size: png.length, width: 1, height: 1, hash: 'abc123', uploadedBy: admin._id } as any)
  await Org.updateOne({ _id: org._id }, { $set: { logo: `/api/org/${org._id}/logo?v=abc123` } })

  // An operational record the copy never holds, and an audit entry that names it.
  const backupRun = await coll('BackupRun').insertOne({ orgId: org._id, status: 'completed', kind: 'full' })
  await AuditLog.create({
    orgId: org._id, userId: admin._id, action: 'create', module: 'backup', entityType: 'backup',
    entityId: backupRun.insertedId, entityName: 'a backup',
  } as any)

  // Things a test copy must never inherit.
  await createTestFiscalDevice(org._id, wh1._id)
  await createTestInvite(org._id, admin._id)
  await createTestNotification(org._id, admin._id)
  await coll('EmailLog').insertOne({ orgId: org._id, to: 'customer@x.test', subject: 'your invoice' })
  await coll('DocFile').insertOne({ orgId: org._id, currentPath: `${org._id}/docs/scan.pdf`, originalName: 'scan.pdf' })
  await coll('ArchiveUnit').insertOne({ orgId: org._id, year: 2025 })

  return { org, id: String(org._id), admin, seller, adminPerson, sellerPerson, wh1, wh2, contact, products, invoices, movement, sellerSet, sellerRole, fileId }
}
type Shop = Awaited<ReturnType<typeof realShop>>

/** A new test org copied from `shop`'s identity, then its data. */
async function testCopyOf(shop: Shop, opts: { activateAdmins?: boolean } = { activateAdmins: true }) {
  const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('test'), name: 'Test Real OOD', execute: true })
  const report = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: made.orgId, execute: true, activateAdmins: opts.activateAdmins })
  return { id: made.orgId, report }
}

const docsOf = (name: string, orgId: string) => coll(name).find({ orgId: oid(orgId) }).toArray()
const countOf = (name: string, orgId: string) => coll(name).countDocuments({ orgId: oid(orgId) })
const byName = (report: any, model: string) => report.collections.find((c: any) => c.model === model)

/** Every document of an org, per collection, as content hashes: what "the real org was not changed" is measured on. */
async function fingerprint(orgId: string) {
  const out: Record<string, string[]> = {}
  for (const name of tenantCollections()) {
    const docs = await docsOf(name, orgId)
    if (docs.length) out[name] = docs.map(d => contentHash(d)).sort()
  }
  out.__org = [contentHash(await Org.collection.findOne({ _id: oid(orgId) }))]
  return out
}

describe('what may be copied into what', () => {
  it('refuses a target that is not marked dev, a source that is, and an org copied onto itself', async () => {
    const shop = await realShop()
    const plain = await createTestOrg({ slug: slugOf('plain') } as any)
    const dev = await createTestOrg({ slug: slugOf('dev') } as any)
    await Org.updateOne({ _id: dev._id }, { $set: { 'settings.environment': 'dev' } })

    expect(((await captureRejection(assertCloneAllowed(shop.id, String(plain._id)))) as OrgCloneError)?.code).toBe('target_not_dev')
    expect(((await captureRejection(assertCloneAllowed(shop.id, shop.id))) as OrgCloneError)?.code).toBe('same_org')
    expect(((await captureRejection(assertCloneAllowed(String(dev._id), String(dev._id)))) as OrgCloneError)?.code).toBe('same_org')
    const other = await createTestOrg({ slug: slugOf('other') } as any)
    await Org.updateOne({ _id: other._id }, { $set: { 'settings.environment': 'dev' } })
    expect(((await captureRejection(assertCloneAllowed(String(dev._id), String(other._id)))) as OrgCloneError)?.code).toBe('source_is_dev')
    // Nothing was written by any of the refusals.
    expect(await countOf('Product', String(plain._id))).toBe(0)
  })

  it('refuses a source that holds sealed personal data', async () => {
    const shop = await realShop()
    await coll('PersonalDataKey').insertOne({ orgId: shop.org._id, sealed: 'x' })
    const target = await createTestOrg({ slug: slugOf('t') } as any)
    await Org.updateOne({ _id: target._id }, { $set: { 'settings.environment': 'dev' } })
    expect(((await captureRejection(assertCloneAllowed(shop.id, String(target._id)))) as OrgCloneError)?.code).toBe('source_holds_sealed_data')
  })

  it('writes nothing on a dry run, and says what it would do', async () => {
    const shop = await realShop()
    const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('dry'), name: 'Test Dry', execute: true })
    const report = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: made.orgId, execute: false, activateAdmins: true })
    expect(report.execute).toBe(false)
    expect(report.totals.inserted).toBeGreaterThan(10)
    expect(byName(report, 'Product').inserted).toBe(3)
    for (const name of tenantCollections()) expect(await countOf(name, made.orgId)).toBe(0)
  })
})

describe('the first copy', () => {
  it('copies every carried collection, leaves out what must never leave, and leaves the real org untouched', async () => {
    const shop = await realShop()
    const before = await fingerprint(shop.id)
    const { id, report } = await testCopyOf(shop)

    expect(report.totals.errors).toBe(0)
    expect(report.totals.conflicts).toBe(0)
    for (const m of ['Contact', 'Invoice', 'Product', 'StockLevel', 'StockMovement', 'Warehouse', 'Tag', 'Sequence', 'AuditLog', 'OrgLogo', 'OrgApp', 'PermissionSet', 'Role', 'User']) {
      expect(await countOf(m, id)).toBe(await countOf(m, shop.id))
    }
    expect(await countOf('Product', id)).toBe(3)

    // Never copied.
    for (const m of ['FiscalDevice', 'Invite', 'Notification', 'EmailLog', 'File', 'DocFile', 'ArchiveUnit']) {
      expect(await countOf(m, id)).toBe(0)
    }
    expect(report.notCloned.map(n => n.model).sort()).toEqual(['ArchiveUnit', 'DocFile', 'EmailLog', 'File', 'FiscalDevice', 'Invite', 'Notification'])

    // The real org is exactly as it was.
    expect(await fingerprint(shop.id)).toEqual(before)
  })

  it('points every reference at the copy: not one id of the real org survives in it', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)

    // Every model that holds an org's documents, operational records and node state included: a copied
    // audit entry may name a backup run of the real org, and that id must not survive either.
    const scoped = Object.keys(mongoose.models).filter(n => !!mongoose.models[n]!.schema.path('orgId'))
    const sourceIds = new Set<string>()
    for (const name of scoped) for (const d of await docsOf(name, shop.id)) sourceIds.add(String(d._id))
    sourceIds.add(shop.id)
    expect(sourceIds.size).toBeGreaterThan(20)

    let text = ''
    for (const name of scoped) text += JSON.stringify(await docsOf(name, id))
    for (const sid of sourceIds) expect(text.includes(sid)).toBe(false)

    // The tag that carried an id inside its text now carries the copy's.
    const tagged: any = (await docsOf('Invoice', id)).find((i: any) => i.status === 'sent')
    expect(tagged.tags[0]).toBe(`converted-from:${cloneIdHex(String(shop.products[0]._id), id)}`)
    expect(tagged.tags[1]).toBe('plain')

    // And the references that matter still resolve inside the copy.
    const products = await docsOf('Product', id)
    const warehouses = await docsOf('Warehouse', id)
    const invoice: any = (await docsOf('Invoice', id)).find((i: any) => i.status === 'sent')
    expect(products.map((p: any) => String(p._id))).toContain(String(invoice.lines[0].productId))
    expect(warehouses.map((w: any) => String(w._id))).toContain(String(invoice.lines[0].warehouseId))
    expect(String(invoice._id)).toBe(cloneIdHex(String(shop.invoices[0]._id), id))
    expect(String(invoice.orgId)).toBe(id)
    // The attachment points at a file the copy does not hold (a copied id, never the real file's).
    expect(String(invoice.attachments[0])).toBe(cloneIdHex(String(shop.fileId), id))
    const movement: any = (await docsOf('StockMovement', id))[0]
    expect(String(movement.invoiceId)).toBe(String(invoice._id))
    const level: any = (await docsOf('StockLevel', id))[0]
    expect(products.map((p: any) => String(p._id))).toContain(String(level.productId))
  })

  it('makes a copy whose org document says what it is, and reaches nowhere outward', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)
    const org: any = await Org.findById(id).lean().exec()
    expect(org.slug).toMatch(/^test-/)
    expect(org.name).toBe('Test Real OOD')
    expect(org.settings.environment).toBe('dev')
    expect(org.settings.dailyDigest.enabled).toBe(false)
    expect(org.settings.dailyDigest.recipients).toEqual([])
    expect(org.settings.backup.enabled).toBe(false)
    expect(org.settings.integrations?.googleDrive).toBeUndefined()
    expect(org.settings.accounting?.books).toBeUndefined()
    expect(org.settings.baseCurrency).toBe('EUR')
    // No fiscal device is ever copied, so the printer gate is off: a till sale could never find a printer.
    expect(org.settings.cashRegister.requireConnectedDevice).toBe(false)
    expect(org.taxNumber).toBe('BG123456789')
    // The company's address and bank are the real org's, with their ids still ids and not text.
    const raw: any = await Org.collection.findOne({ _id: oid(id) })
    expect(raw.addresses[0].city).toBe('Pazardzhik')
    expect(raw.addresses[0]._id._bsontype).toBe('ObjectId')
    expect(raw.bankDetails[0].iban).toBe('BG00AAAA11112222333344')
    expect(org.subscription.stripeCustomerId).toBeUndefined()
    // The owner is a membership OF THE COPY, and the logo URL names the copy.
    const owner: any = await User.findOne({ _id: org.ownerId }).lean().exec()
    expect(String(owner.orgId)).toBe(id)
    expect(owner.role).toBe('admin')
    expect(org.logo).toBe(`/api/org/${id}/logo?v=abc123`)
    // The real org still says what it said.
    const real: any = await Org.findById(shop.id).lean().exec()
    expect(real.settings.dailyDigest.enabled).toBe(true)
    expect(real.settings.environment).toBe('prod')
    expect(real.logo).toBe(`/api/org/${shop.id}/logo?v=abc123`)
  })

  it('copies memberships as they are for an admin, switched off for anyone else, with the same person behind each', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)
    const users: any[] = await docsOf('User', id)
    expect(users.length).toBe(2)
    const admin = users.find(u => u.role === 'admin')
    const seller = users.find(u => u.role === 'seller')
    expect(admin.isActive).toBe(true)
    expect(String(admin.identityId)).toBe(String(shop.adminPerson._id))
    expect(seller.isActive).toBe(false)
    expect(seller.deactivatedAt).toBeInstanceOf(Date)
    expect(String(seller.identityId)).toBe(String(shop.sellerPerson._id))
    // Its permission set is the copy's own.
    const sets: any[] = await docsOf('PermissionSet', id)
    expect(seller.permissionSetIds.map(String)).toEqual([String(sets.find(s => s.name === 'Seller')._id)])
    // And so is its role (FR-27): the copy's own Seller role, never the real org's.
    const roles: any[] = await docsOf('Role', id)
    expect(String(seller.roleId)).toBe(String(roles.find(r => r.name === 'Seller')._id))
    expect(String(seller.roleId)).not.toBe(String(shop.sellerRole._id))
    // The real memberships did not move.
    expect((await User.findById(shop.seller._id).lean().exec())!.isActive).toBe(true)
  })

  it('switches every membership off when asked not to activate admins', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop, { activateAdmins: false })
    expect((await docsOf('User', id)).every((u: any) => u.isActive === false)).toBe(true)
  })
})

describe('keeping it up to date', () => {
  it('changes nothing on a second run', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)
    const again = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: id, execute: true })
    expect(again.totals.inserted).toBe(0)
    expect(again.totals.updated).toBe(0)
    expect(again.totals.conflicts).toBe(0)
    expect(again.totals.errors).toBe(0)
    expect(again.totals.unchanged).toBeGreaterThan(10)
    expect(await compareOrgs(shop.id, id)).toEqual(expect.arrayContaining([{ model: 'Product', source: 3, target: 3 }]))
  })

  it('brings across what is new and what changed, keeps what only the test org holds, and takes source over a drifted copy', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)

    // The real shop trades on: a new article and invoice, a price change, a stock change.
    const fresh = await createTestProduct(shop.org._id, { name: 'Screw', sku: `S-${++seq}` } as any)
    await Product.updateOne({ _id: shop.products[0]._id }, { $set: { sellingPrice: 111 } })
    await StockLevel.updateOne({ productId: shop.products[1]._id }, { $set: { quantity: 3, availableQuantity: 3 } })
    const newInvoice = await createTestInvoice(shop.org._id, shop.contact._id, { invoiceNumber: `INV-NEW-${seq}`, createdBy: shop.admin._id } as any)

    // Meanwhile someone works in the test org: a document only it holds, and an edit of a copied one.
    const testOnly = await createTestProduct(oid(id), { name: 'Test-only article', sku: `T-${seq}` } as any)
    const copiedNut = cloneIdHex(String(shop.products[1]._id), id)
    await Product.updateOne({ _id: copiedNut }, { $set: { sellingPrice: 999 } })

    const run = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: id, execute: true })
    expect(byName(run, 'Product').inserted).toBe(1)
    expect(byName(run, 'Product').updated).toBe(2) // the repriced bolt, and the nut a tester had edited
    expect(byName(run, 'StockLevel').updated).toBe(1)
    expect(byName(run, 'Invoice').inserted).toBe(1)
    expect(run.totals.conflicts).toBe(0)

    const products: any[] = await docsOf('Product', id)
    expect(products.find(p => String(p._id) === cloneIdHex(String(shop.products[0]._id), id)).sellingPrice).toBe(111)
    expect(products.find(p => String(p._id) === copiedNut).sellingPrice).toBe(100) // source wins
    expect(products.map(p => String(p._id))).toContain(String(testOnly._id)) // the test org's own stays
    expect(products.map(p => String(p._id))).toContain(cloneIdHex(String(fresh._id), id))
    expect((await docsOf('Invoice', id)).map((i: any) => String(i._id))).toContain(cloneIdHex(String(newInvoice._id), id))
    expect((await docsOf('StockLevel', id)).find((l: any) => l.quantity === 3)).toBeTruthy()
  })

  it('leaves a drifted copy alone when asked only to add', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)
    const copiedNut = cloneIdHex(String(shop.products[1]._id), id)
    await Product.updateOne({ _id: copiedNut }, { $set: { sellingPrice: 999 } })
    await createTestProduct(shop.org._id, { name: 'Screw', sku: `S-${++seq}` } as any)

    const run = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: id, execute: true, insertOnly: true })
    expect(byName(run, 'Product').inserted).toBe(1)
    expect(byName(run, 'Product').updated).toBe(0)
    expect(((await Product.findById(copiedNut).lean().exec()) as any).sellingPrice).toBe(999)
  })

  it('never takes a counter backwards, and raises one the copy is behind on', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)
    await Sequence.updateOne({ orgId: oid(id), prefix: 'INV' }, { $set: { lastNumber: 50 } }) // the test org issued more
    await Sequence.updateOne({ orgId: shop.org._id, prefix: 'SM' }, { $set: { lastNumber: 12 } }) // the real one did

    const run = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: id, execute: true })
    expect(byName(run, 'Sequence').updated).toBe(1)
    expect(((await Sequence.findOne({ orgId: oid(id), prefix: 'INV' }).lean().exec()) as any).lastNumber).toBe(50)
    expect(((await Sequence.findOne({ orgId: oid(id), prefix: 'SM' }).lean().exec()) as any).lastNumber).toBe(12)
  })

  it('reports a unique-index clash as a conflict and carries on with everything else', async () => {
    const shop = await realShop()
    const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('clash'), name: 'Test Clash', execute: true })
    // The test org already issued this very number, to a different document.
    await createTestInvoice(oid(made.orgId), (await createTestContact(oid(made.orgId)))._id, { invoiceNumber: shop.invoices[0].invoiceNumber } as any)

    const run = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: made.orgId, execute: true })
    expect(run.totals.errors).toBe(0)
    expect(byName(run, 'Invoice').conflicts).toBe(1)
    expect(byName(run, 'Invoice').inserted).toBe(1) // the other invoice still came across
    expect(byName(run, 'Invoice').conflictSamples[0]).toContain('dup key')
    expect(await countOf('Product', made.orgId)).toBe(3)
  })
})

describe('people the test org already has', () => {
  it('matches a membership by the person and a permission set by name, so nothing is copied twice and nothing is overwritten', async () => {
    const shop = await realShop()
    // The test org: its own admin is the SAME person as the shop's admin, under another username, and
    // it has its own Seller set.
    const target = await createTestOrg({ slug: slugOf('existing'), name: 'Existing' } as any)
    await Org.updateOne({ _id: target._id }, { $set: { 'settings.environment': 'dev' } })
    const own = await createTestUser(target._id, { identityId: shop.adminPerson._id, role: 'admin', username: 'my-own-name', email: `own-${++seq}@x.test` } as any)
    const ownSet = await PermissionSet.create({ orgId: target._id, name: 'Seller', description: 'theirs', permissions: ['crm.read'], isSystem: true } as any)
    const ownRole = await Role.create({ orgId: target._id, name: 'Seller', isBuiltin: true, templateKey: 'seller', caps: ['crm.read'], legacy: { role: 'seller', permissions: [] } } as any)
    // The app made this one itself when someone opened the hub, and the test org has switched it off.
    await OrgApp.create({ orgId: target._id, appId: 'accounting', enabled: false })

    const run = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: String(target._id), execute: true, activateAdmins: true })
    expect(byName(run, 'User').merged).toBe(1)
    expect(byName(run, 'User').inserted).toBe(1) // only the seller
    expect(byName(run, 'PermissionSet').merged).toBe(1)
    expect(byName(run, 'Role').merged).toBe(1)
    expect(await countOf('Role', String(target._id))).toBe(1)
    // The enabled app is matched by which app it is: no clash, the test org's own switch stays, the other is added.
    expect(byName(run, 'OrgApp').merged).toBe(1)
    expect(byName(run, 'OrgApp').inserted).toBe(1)
    expect(byName(run, 'OrgApp').conflicts).toBe(0)
    const apps: any[] = await docsOf('OrgApp', String(target._id))
    expect(apps.map(a => [a.appId, a.enabled]).sort()).toEqual([['accounting', false], ['invoicing', true]])

    const users: any[] = await docsOf('User', String(target._id))
    expect(users.length).toBe(2)
    expect(users.filter(u => String(u.identityId) === String(shop.adminPerson._id)).length).toBe(1)
    expect(String(users.find(u => u.username === 'my-own-name')._id)).toBe(String(own._id)) // untouched
    // Documents the shop admin created now name the membership the test org already had.
    const invoice: any = (await docsOf('Invoice', String(target._id))).find((i: any) => i.status === 'sent')
    expect(String(invoice.createdBy)).toBe(String(own._id))
    // The seller arrives switched off, on the test org's OWN Seller set; that set is as it was.
    const seller = users.find(u => u.role === 'seller')
    expect(seller.isActive).toBe(false)
    expect(seller.permissionSetIds.map(String)).toEqual([String(ownSet._id)])
    expect(String(seller.roleId)).toBe(String(ownRole._id))
    expect(((await PermissionSet.findById(ownSet._id).lean().exec()) as any).permissions).toEqual(['crm.read'])
    expect(((await Role.findById(ownRole._id).lean().exec()) as any).caps).toEqual(['crm.read'])
  })
})

describe('an existing org becomes a test copy', () => {
  it('is renamed, marked dev and has its outward switches off, keeping its other settings', async () => {
    const shop = await realShop()
    const old = await createTestOrg({ slug: slugOf('regalish'), name: 'Old Test Org' } as any)
    await Org.updateOne({ _id: old._id }, { $set: { 'settings.dailyDigest': { enabled: true, hour: 7, recipients: [] }, 'settings.backup': { enabled: true }, 'settings.cashRegister': { requireConnectedDevice: true } } })

    const wrong = await captureRejection(convertToTestOrg({ orgId: String(old._id), expectSlug: 'not-it', newSlug: slugOf('test-x'), newName: 'X', sourceOrgId: shop.id, execute: true }))
    expect((wrong as OrgCloneError).code).toBe('slug_mismatch')
    expect(((await Org.findById(old._id).lean().exec()) as any).name).toBe('Old Test Org')

    const newSlug = slugOf('test-regalish')
    await convertToTestOrg({ orgId: String(old._id), expectSlug: old.slug, newSlug, newName: 'Test Regalish OOD', sourceOrgId: shop.id, execute: true })
    const org: any = await Org.findById(old._id).lean().exec()
    expect(org.slug).toBe(newSlug)
    expect(org.name).toBe('Test Regalish OOD')
    expect(org.settings.environment).toBe('dev')
    expect(org.settings.dailyDigest.enabled).toBe(false)
    expect(org.settings.backup.enabled).toBe(false)
    expect(org.settings.cashRegister.requireConnectedDevice).toBe(true) // its own, untouched
    expect(org.taxNumber).toBe('BG123456789') // the company's identity, from the real org
    const raw: any = await Org.collection.findOne({ _id: old._id })
    expect(raw.addresses[0].street).toBe('1 Main')
    expect(raw.addresses[0]._id._bsontype).toBe('ObjectId') // not turned into text on the way
    expect(org.subscription.plan).toBe('professional')
  })

  it('refuses to convert an org that is marked prod', async () => {
    const shop = await realShop()
    const err = await captureRejection(convertToTestOrg({ orgId: shop.id, expectSlug: shop.org.slug, newSlug: slugOf('nope'), newName: 'Nope', sourceOrgId: shop.id, execute: true }))
    expect((err as OrgCloneError).code).toBe('org_is_prod')
  })

  it('marks an org prod or dev only when the slug is the one expected', async () => {
    const o = await createTestOrg({ slug: slugOf('mark') } as any)
    expect(((await captureRejection(markOrgEnvironment({ orgId: String(o._id), expectSlug: 'wrong', environment: 'prod', execute: true }))) as OrgCloneError).code).toBe('slug_mismatch')
    expect(((await Org.findById(o._id).lean().exec()) as any).settings.environment).toBeUndefined()
    await markOrgEnvironment({ orgId: String(o._id), expectSlug: o.slug, environment: 'prod', execute: false })
    expect(((await Org.findById(o._id).lean().exec()) as any).settings.environment).toBeUndefined()
    await markOrgEnvironment({ orgId: String(o._id), expectSlug: o.slug, environment: 'prod', execute: true })
    expect(((await Org.findById(o._id).lean().exec()) as any).settings.environment).toBe('prod')
  })
})

describe('emptying a test org before the first copy', () => {
  async function dirtyTestOrg() {
    const o = await createTestOrg({ slug: slugOf('dirty') } as any)
    await Org.updateOne({ _id: o._id }, { $set: { 'settings.environment': 'dev' } })
    const wh = await createTestWarehouse(o._id, { code: 'paz' })
    const user = await createTestUser(o._id, { role: 'admin' } as any)
    await createTestProduct(o._id)
    await createTestProduct(o._id)
    await createTestContact(o._id)
    await createTestFiscalDevice(o._id, wh._id)
    await createTestInvite(o._id, user._id)
    await createTestNotification(o._id, user._id)
    await PermissionSet.create({ orgId: o._id, name: 'Administrator', description: '', permissions: [], isSystem: true, isAdmin: true } as any)
    await coll('Desktop').insertOne({ orgId: o._id, name: 'Dev laptop', status: 'active' })
    // The org's own operational history: not data, never touched.
    await coll('BackupRun').insertOne({ orgId: o._id, status: 'completed' })
    return { o, wh }
  }

  it('refuses on a slug that is not the expected one, on an org not marked dev, and does nothing on a dry run', async () => {
    const { o } = await dirtyTestOrg()
    expect(((await captureRejection(resetOrgData({ orgId: String(o._id), expectSlug: 'wrong', execute: true }))) as OrgCloneError).code).toBe('slug_mismatch')
    const shop = await realShop()
    expect(((await captureRejection(resetOrgData({ orgId: shop.id, expectSlug: shop.org.slug, execute: true }))) as OrgCloneError).code).toBe('target_not_dev')
    const dry = await resetOrgData({ orgId: String(o._id), expectSlug: o.slug, execute: false })
    expect(dry.deleted.Product).toBe(2)
    expect(await countOf('Product', String(o._id))).toBe(2)
  })

  it('deletes the data, keeps people and hardware and devices and history, and the copy then fills it', async () => {
    const shop = await realShop()
    const { o, wh } = await dirtyTestOrg()
    const orgId = String(o._id)

    const report = await resetOrgData({ orgId, expectSlug: o.slug, execute: true })
    expect(report.deleted.Product).toBe(2)
    expect(report.deleted.Contact).toBe(1)
    expect(report.deleted.Notification).toBe(1)
    expect(report.deleted.Warehouse).toBe(1)
    for (const m of ['Product', 'Contact', 'Warehouse', 'Notification']) expect(await countOf(m, orgId)).toBe(0)
    for (const m of ['User', 'FiscalDevice', 'Invite', 'PermissionSet', 'Desktop', 'BackupRun']) expect(await countOf(m, orgId)).toBe(1)
    expect(Object.keys(report.kept).sort()).toEqual(['Desktop', 'FiscalDevice', 'Invite', 'PermissionSet', 'User'])

    // The kept device names a warehouse that no longer exists; the copy relinks it to the one with this code.
    const run = await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: orgId, execute: true, activateAdmins: true, relinkHardwareTo: 'pz' })
    expect(run.warnings).toEqual([])
    const device: any = (await docsOf('FiscalDevice', orgId))[0]
    expect(String(device.warehouseId)).not.toBe(String(wh._id))
    const pz: any = (await docsOf('Warehouse', orgId)).find((w: any) => w.code === 'pz')
    expect(String(device.warehouseId)).toBe(String(pz._id))
    expect(await countOf('Product', orgId)).toBe(3)
  })
})

describe('every model with an orgId takes a side', () => {
  // A model added next month must be decided here, not copied (or left out) by default. Adding a
  // name to either list is the decision; the test only forces it to be made.
  const CARRIED = [
    'AbsenceEntry', 'Account', 'AccountingAnalytic', 'AuditLog', 'BankAccount', 'BankReconciliation', 'CashOrder', 'Contact',
    'CostLayer', 'Employee', 'EmploymentContract', 'ExchangeRate', 'FiscalPeriod', 'FiscalPosition', 'FiscalYear', 'FixedAsset',
    'InternalOrder', 'InventoryCount', 'Invoice', 'Journal', 'JournalEntry', 'LeaveBalance', 'OperationType', 'Order', 'OrgApp',
    'OrgLogo', 'POSPaymentMethod', 'POSSession', 'POSTransaction', 'PaymentOrder', 'PaymentTerm', 'PayrollElement', 'PayrollRun',
    'Payslip', 'PermissionSet', 'PriceList', 'Product', 'ProductCategory', 'Reservation', 'Role', 'Sequence', 'StockLevel',
    'StockLocation', 'StockLot', 'StockMovement', 'SupplierProductAlias', 'Tag', 'TaxReturn', 'Timesheet', 'User',
    'VatRegisterEntry', 'Warehouse',
  ].sort()

  it('carries exactly the models listed here', async () => {
    const { clonedModels } = await import('services/biz/org-clone/policy')
    expect(clonedModels(tenantCollections())).toEqual(CARRIED)
  })

  it('never copies a model of the file store, hardware, devices, credentials or inboxes', async () => {
    const { NEVER_CLONED, KEPT_ON_RESET } = await import('services/biz/org-clone/policy')
    const tenant = tenantCollections()
    for (const m of Object.keys(NEVER_CLONED)) expect(tenant).toContain(m)
    for (const m of KEPT_ON_RESET) expect(tenant).toContain(m)
  })
})

describe('the command line (scripts/org-clone.ts)', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')

  async function cli(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'org-clone.ts'), ...args], {
      cwd: REPO,
      env: { ...process.env, MONGODB_URI: testDbUri(), ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  it('says what it would do on a dry run, writes nothing, and then does it with --execute', async () => {
    const shop = await realShop()
    const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('cli'), name: 'Test Cli', execute: true })
    const copy: any = await Org.findById(made.orgId).lean().exec()

    const dry = await cli(['sync', '--source', shop.org.slug, '--target', copy.slug, '--activate-admins'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('DRY RUN')
    expect(dry.out).toMatch(/Product\s+3\s+3\s+0/)
    expect(await countOf('Product', made.orgId)).toBe(0)

    const real = await cli(['sync', '--source', shop.org.slug, '--target', copy.slug, '--activate-admins', '--execute'])
    expect(real.code).toBe(0)
    expect(real.out).not.toContain('DRY RUN')
    expect(await countOf('Product', made.orgId)).toBe(3)
    expect(await countOf('Invoice', made.orgId)).toBe(2)
    expect(real.out).toContain('not copied, by design')

    // The second run is a no-op, and `status` shows the two orgs level.
    const again = await cli(['sync', '--pairs', `${shop.org.slug}:${copy.slug}`, '--execute'])
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/0 inserted, 0 updated/)
    const status = await cli(['status', '--pairs', `${shop.org.slug}:${copy.slug}`])
    expect(status.code).toBe(0)
    expect(status.out).toMatch(/Product\s+3\s+3/)
    expect(status.out).not.toContain('behind')
  })

  it('takes the pairs from ORG_SYNC_PAIRS, which is how the daily job is told', async () => {
    const shop = await realShop()
    const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('env'), name: 'Test Env', execute: true })
    const copy: any = await Org.findById(made.orgId).lean().exec()
    const res = await cli(['sync', '--execute'], { ORG_SYNC_PAIRS: `${shop.org.slug}:${copy.slug}` })
    expect(res.code).toBe(0)
    expect(await countOf('Product', made.orgId)).toBe(3)
  })

  it('exits 1 and names the refusal when the target is not a dev org, and writes nothing', async () => {
    const shop = await realShop()
    const plain = await createTestOrg({ slug: slugOf('notdev') } as any)
    const res = await cli(['sync', '--source', shop.org.slug, '--target', plain.slug, '--execute'])
    expect(res.code).toBe(1)
    expect(res.out).toContain('[target_not_dev]')
    expect(await countOf('Product', String(plain._id))).toBe(0)
  })

  it('exits 1 for a pair where one org does not exist, and still copies the other pair', async () => {
    const shop = await realShop()
    const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('two'), name: 'Test Two', execute: true })
    const copy: any = await Org.findById(made.orgId).lean().exec()
    const res = await cli(['sync', '--pairs', `${shop.org.slug}:nope-${seq},${shop.org.slug}:${copy.slug}`, '--execute'])
    expect(res.code).toBe(1)
    expect(res.out).toContain('no org with slug')
    expect(await countOf('Product', made.orgId)).toBe(3)
  })

  it('takes a verified backup bundle before it empties an org, and keeps the people', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-clone-'))
    try {
      const o = await createTestOrg({ slug: slugOf('wipe') } as any)
      await Org.updateOne({ _id: o._id }, { $set: { 'settings.environment': 'dev' } })
      await createTestUser(o._id, { role: 'admin' } as any)
      await createTestProduct(o._id)
      await createTestProduct(o._id)

      const dry = await cli(['reset', '--org', o.slug], { UPLOAD_DIR: dir })
      expect(dry.code).toBe(0)
      expect(await countOf('Product', String(o._id))).toBe(2)
      expect(existsSync(join(dir, String(o._id)))).toBe(false)

      const res = await cli(['reset', '--org', o.slug, '--execute'], { UPLOAD_DIR: dir })
      expect(res.code).toBe(0)
      expect(res.out).toContain('backup bundle:')
      const bundles = readdirSync(join(dir, String(o._id), 'backups', 'pre-test-org-reset'))
      expect(bundles.length).toBe(1)
      expect(bundles[0]).toMatch(/pre-reset\.ndjson\.zst$/)
      expect(await countOf('Product', String(o._id))).toBe(0)
      expect(await countOf('User', String(o._id))).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks an org prod, and refuses to wipe an org that is not dev', async () => {
    const o = await createTestOrg({ slug: slugOf('badge') } as any)
    const mark = await cli(['mark', '--org', o.slug, '--env', 'prod', '--execute'])
    expect(mark.code).toBe(0)
    expect(((await Org.findById(o._id).lean().exec()) as any).settings.environment).toBe('prod')
    const wipe = await cli(['reset', '--org', o.slug, '--no-bundle', '--execute'])
    expect(wipe.code).toBe(1)
    expect(wipe.out).toContain('[target_not_dev]')
  })
})

describe('the unique indexes the copy relies on (scripts/org-clone.ts)', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')

  async function cli(args: string[]) {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'org-clone.ts'), ...args], {
      cwd: REPO,
      env: { ...process.env, MONGODB_URI: testDbUri() },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  async function uniqueIndexNames(model: { collection: any }): Promise<string[]> {
    return (await model.collection.indexes()).filter((i: any) => i.unique && i.name !== '_id_').map((i: any) => i.name as string)
  }

  it('does not ask for the unique index of a model the real org holds no rows of', async () => {
    // Production's leave balances: a schema index the app could not build over the old data. The shop being
    // copied has no leave balances, so the missing index must not stop its copy.
    await LeaveBalance.init()
    const names = await uniqueIndexNames(LeaveBalance)
    expect(names.length).toBeGreaterThan(0)
    try {
      for (const name of names) await LeaveBalance.collection.dropIndex(name)
      const shop = await realShop()
      const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('noidx'), name: 'Test NoIdx', execute: true })
      const copy: any = await Org.findById(made.orgId).lean().exec()
      const res = await cli(['sync', '--source', shop.org.slug, '--target', copy.slug, '--execute'])
      expect(res.code).toBe(0)
      expect(await countOf('Product', made.orgId)).toBe(3)
    } finally {
      await LeaveBalance.syncIndexes()
    }
  })

  it('refuses, and writes nothing, when a model the real org holds rows of lacks its unique index', async () => {
    await Tag.init()
    const names = await uniqueIndexNames(Tag)
    expect(names.length).toBeGreaterThan(0)
    try {
      const shop = await realShop()
      const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('idx'), name: 'Test Idx', execute: true })
      const copy: any = await Org.findById(made.orgId).lean().exec()
      for (const name of names) await Tag.collection.dropIndex(name)
      const res = await cli(['sync', '--source', shop.org.slug, '--target', copy.slug, '--execute'])
      expect(res.code).toBe(1)
      expect(res.out).toContain('unique index missing')
      expect(await countOf('Product', made.orgId)).toBe(0)
    } finally {
      await Tag.syncIndexes()
    }
  })
})

describe('the leak scan (scripts/org-clone.ts leaks)', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')

  async function leaksCli(pair: string) {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'org-clone.ts'), 'leaks', '--pairs', pair], {
      cwd: REPO,
      env: { ...process.env, MONGODB_URI: testDbUri() },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  it('finds nothing in a clean copy, says how much it looked at, and only looks', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)
    const before = await fingerprint(id)

    const scan = await scanCopyForLeaks(shop.id, id)
    expect(scan.leaking).toBe(0)
    expect(scan.byCollection).toEqual({})
    expect(scan.sourceIds).toBeGreaterThan(20)
    expect(scan.copyDocs).toBeGreaterThan(20)
    expect(await fingerprint(id)).toEqual(before)
  })

  it('finds a real-org id the rewrite does not follow, in a collection no model names, and in the org row of the copy', async () => {
    const shop = await realShop()
    const { id } = await testCopyOf(shop)

    // 1. An id glued to other hex digits is not a token the rewrite follows.
    const contact: any = (await docsOf('Contact', id))[0]
    await coll('Contact').updateOne({ _id: contact._id }, { $set: { notes: `ref ab${shop.contact._id}` } })
    // 2. A collection no model names is one the engine never reads.
    const stray = await mongoose.connection.db!.collection('stray_notes').insertOne({ orgId: oid(id), text: `see ${shop.invoices[0]._id}` })
    // 3. The real org's own id, in the org row of the copy.
    await Org.collection.updateOne({ _id: oid(id) }, { $set: { scanProbe: `x ${shop.id}` } })

    const scan = await scanCopyForLeaks(shop.id, id)
    const contacts = coll('Contact').collectionName
    const orgs = Org.collection.collectionName
    expect(scan.leaking).toBe(3)
    expect(scan.byCollection).toEqual({ [contacts]: 1, stray_notes: 1, [orgs]: 1 })
    // It points at documents of the COPY, and never prints an id of the real org.
    expect(scan.samples[contacts]).toEqual([String(contact._id)])
    expect(scan.samples.stray_notes).toEqual([String(stray.insertedId)])
    const printed = JSON.stringify(scan)
    for (const real of [shop.id, String(shop.contact._id), String(shop.invoices[0]._id)]) expect(printed.includes(real)).toBe(false)
  })

  it('takes exactly the pairs a sync takes', async () => {
    const shop = await realShop()
    const plain = await createTestOrg({ slug: slugOf('plain') } as any)
    expect(((await captureRejection(scanCopyForLeaks(shop.id, String(plain._id)))) as OrgCloneError)?.code).toBe('target_not_dev')
    expect(((await captureRejection(scanCopyForLeaks(shop.id, shop.id))) as OrgCloneError)?.code).toBe('same_org')
  })

  it('exits 0 on a clean copy, 1 naming the collection on a leak, 1 when it could not look, and never prints an id of the real org', async () => {
    const shop = await realShop()
    const made = await createTestOrgFrom({ sourceOrgId: shop.id, slug: slugOf('leaks'), name: 'Test Leaks', execute: true })
    await cloneOrgData({ sourceOrgId: shop.id, targetOrgId: made.orgId, execute: true, activateAdmins: true })
    const copy: any = await Org.findById(made.orgId).lean().exec()
    const pair = `${shop.org.slug}:${copy.slug}`

    const clean = await leaksCli(pair)
    expect(clean.code).toBe(0)
    expect(clean.out).toContain('NO LEAKS')

    await coll('Invoice').updateOne({ orgId: oid(made.orgId), status: 'sent' }, { $set: { notes: `ref ${shop.products[0]._id}` } })
    const dirty = await leaksCli(pair)
    expect(dirty.code).toBe(1)
    expect(dirty.out).toContain('LEAKS FOUND')
    expect(dirty.out).toContain(`${coll('Invoice').collectionName}: 1`)
    expect(dirty.out.includes(String(shop.products[0]._id))).toBe(false)

    const missing = await leaksCli(`${shop.org.slug}:no-such-test-org`)
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('[no_such_org]')
    expect(missing.out).toContain('NOT CHECKED')
  })
})
