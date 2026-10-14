import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestContact } from '../helpers/factories'
import { Product } from 'db/models'
import { resolvePrice, listPriceOptions } from 'services/biz/pricing.service'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Phase 1 — Product.priceTiers[] schema + validation.
 * Covers round-trip, 10-slot cap, required fields, negative finalPrice,
 * and the backfill-equivalent default-slot seeding pattern.
 */
describe('Product.priceTiers schema', () => {
  it('persists and reloads 10 tier slots (round-trip)', async () => {
    const org = await createTestOrg()
    const tiers = Array.from({ length: 10 }, (_, i) => ({
      name: `Price ${i + 1}`,
      percent: i * 5,
      finalPrice: 100 + i * 5,
      manualOverride: false,
      contactIds: [],
      tags: [],
    }))
    const product = await createTestProduct(org._id, { sellingPrice: 100, priceTiers: tiers } as any)

    const fresh = await Product.findById(product._id).lean()
    expect(fresh?.priceTiers).toHaveLength(10)
    expect(fresh?.priceTiers[0]).toMatchObject({ name: 'Price 1', percent: 0, finalPrice: 100, manualOverride: false })
    expect(fresh?.priceTiers[9]).toMatchObject({ name: 'Price 10', percent: 45, finalPrice: 145 })
  })

  it('rejects a 14th tier (cap at 13 slots)', async () => {
    const org = await createTestOrg()
    const tiers = Array.from({ length: 14 }, (_, i) => ({
      name: `Price ${i + 1}`,
      percent: 0,
      finalPrice: 100,
      manualOverride: false,
    }))
    expectRejection(await captureRejection(createTestProduct(org._id, { priceTiers: tiers } as any)), /priceTiers exceeds maximum of 13 slots/)
  })

  it('rejects a tier without a name', async () => {
    const org = await createTestOrg()
    expectRejection(await captureRejection(createTestProduct(org._id, { priceTiers: [{ percent: 0, finalPrice: 100, manualOverride: false }] } as any)), /name/i)
  })

  it('rejects a tier with negative finalPrice', async () => {
    const org = await createTestOrg()
    expectRejection(await captureRejection(createTestProduct(org._id, { priceTiers: [{ name: 'Bad', percent: 0, finalPrice: -1, manualOverride: false }] } as any)))
  })

  it('accepts tiers with filter fields (contactIds, tags, minQuantity, validFrom/validTo)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const now = new Date()
    const later = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    const tiers = [{
      name: 'VIP',
      percent: 10,
      finalPrice: 90,
      manualOverride: false,
      contactIds: [contact._id],
      tags: ['vip', 'gold'],
      minQuantity: 5,
      validFrom: now,
      validTo: later,
    }]
    const product = await createTestProduct(org._id, { sellingPrice: 100, priceTiers: tiers } as any)
    const fresh = await Product.findById(product._id).lean()
    expect(fresh?.priceTiers[0].tags).toEqual(['vip', 'gold'])
    expect(fresh?.priceTiers[0].contactIds).toHaveLength(1)
    expect(fresh?.priceTiers[0].minQuantity).toBe(5)
  })

  it('defaults priceTiers to [] when not provided', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const fresh = await Product.findById(product._id).lean()
    expect(Array.isArray(fresh?.priceTiers)).toBe(true)
    expect(fresh?.priceTiers).toHaveLength(0)
  })
})

describe('Product.priceTiers backfill pattern (idempotent default-slot seeding)', () => {
  function defaultTiers(sellingPrice: number) {
    return Array.from({ length: 10 }, (_, i) => ({
      name: `Price ${i + 1}`,
      percent: 0,
      finalPrice: sellingPrice,
      manualOverride: false,
      contactIds: [],
      tags: [],
    }))
  }

  it('seeds 10 tiers for a product with empty priceTiers', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { sellingPrice: 42 })
    // Pre-state
    const before = await Product.findById(product._id).lean()
    expect(before?.priceTiers).toHaveLength(0)

    // Run the seed logic (as the backfill script would)
    await Product.updateOne(
      { _id: product._id, 'priceTiers.0': { $exists: false } },
      { $set: { priceTiers: defaultTiers(42) } },
    ).exec()

    const after = await Product.findById(product._id).lean()
    expect(after?.priceTiers).toHaveLength(10)
    expect(after?.priceTiers.every(t => t.finalPrice === 42 && t.percent === 0)).toBe(true)
  })

  it('is idempotent — does not touch products that already have tiers', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, {
      sellingPrice: 42,
      priceTiers: [{ name: 'Existing', percent: 5, finalPrice: 40, manualOverride: true }],
    } as any)

    // Run seed logic: should skip because priceTiers.0 exists.
    await Product.updateOne(
      { _id: product._id, 'priceTiers.0': { $exists: false } },
      { $set: { priceTiers: defaultTiers(42) } },
    ).exec()

    const after = await Product.findById(product._id).lean()
    expect(after?.priceTiers).toHaveLength(1)
    expect(after?.priceTiers[0].name).toBe('Existing')
    expect(after?.priceTiers[0].manualOverride).toBe(true)
  })
})

/**
 * Legacy price-group wiring: a contact tagged with a tier's name (e.g. "Цена 4")
 * resolves that tier's price; listPriceOptions offers the tier and its resolvedKey
 * mirrors resolvePrice.
 */
describe('price-group tags (tier ↔ contact tag wiring)', () => {
  const legacyTiers = [
    { name: 'Доставна цена', percent: 0, finalPrice: 0.0076, manualOverride: true, contactIds: [], tags: [] },
    { name: 'Цена 4', percent: -6.6, finalPrice: 0.0071, manualOverride: true, contactIds: [], tags: ['Цена 4'] },
    { name: 'Цена 5', percent: -32.9, finalPrice: 0.0051, manualOverride: true, contactIds: [], tags: ['Цена 5'] },
  ]

  it('resolvePrice picks the tagged tier for a contact carrying the group tag', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['Цена 4'] } as any)
    const product = await createTestProduct(org._id, { sellingPrice: 0.0153, priceTiers: legacyTiers } as any)

    const res = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(res.finalPrice).toBe(0.0071)
    const last = res.steps[res.steps.length - 1]
    expect(last.type).toBe('tier')
    expect(last.label).toBe('Цена 4')
  })

  it('listPriceOptions offers the matching tier and resolvedKey mirrors resolvePrice', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['Цена 4'] } as any)
    const product = await createTestProduct(org._id, { sellingPrice: 0.0153, priceTiers: legacyTiers } as any)

    const withContact = await listPriceOptions(String(org._id), String(product._id), String(contact._id))
    const tierOpt = withContact.options.find(o => o.type === 'tier' && o.name === 'Цена 4')
    expect(tierOpt).toBeTruthy()
    expect(tierOpt!.price).toBe(0.0071)
    // The other group's tier does not match this contact's tag → not offered with a contact.
    expect(withContact.options.find(o => o.name === 'Цена 5')).toBeUndefined()
    expect(withContact.resolvedKey).toBe(tierOpt!.key)

    // Without a contact: resolution stays at base selling price, but filtered tiers
    // remain listed for manual selection.
    const noContact = await listPriceOptions(String(org._id), String(product._id))
    expect(noContact.resolvedKey).toBe('selling')
    expect(noContact.options.filter(o => o.type === 'tier')).toHaveLength(2)
  })

  /**
   * `all` mode feeds the cash-sale price dropdown (`<PriceCombobox all>`, #134) and the
   * per-line picker. The dropdown auto-applies the option whose key is `resolvedKey`, so that
   * key must be one of the options listed, or the cart silently stops pricing new lines.
   */
  it('all mode lists every named non-zero price, and resolvedKey is still one of them', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id, { tags: ['Цена 4'] } as any)
    const product = await createTestProduct(org._id, {
      sellingPrice: 10,
      priceTiers: [
        { name: 'Цена 1', percent: 0, finalPrice: 9, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена 2', percent: 0, finalPrice: 8, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена 3', percent: 0, finalPrice: 0, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена 4', percent: 0, finalPrice: 7, manualOverride: true, contactIds: [], tags: ['Цена 4'] },
      ],
    } as any)
    const pid = String(product._id)
    const names = (r: { options: { name: string }[] }) => r.options.map(o => o.name).sort()

    // No customer (the usual cash sale): every named price, the filterless slots included;
    // a zero-priced slot is not a price. The selling price is what applies.
    const anon = await listPriceOptions(String(org._id), pid, undefined, 1, undefined, { all: true })
    expect(names(anon)).toEqual(['Selling price', 'Цена 1', 'Цена 2', 'Цена 4'])
    expect(anon.resolvedKey).toBe('selling')
    expect(anon.options.map(o => o.key)).toContain(anon.resolvedKey)

    // A customer in the „Цена 4" group: the same full list, and their price applies.
    const tagged = await listPriceOptions(String(org._id), pid, String(contact._id), 1, undefined, { all: true })
    expect(names(tagged)).toEqual(['Selling price', 'Цена 1', 'Цена 2', 'Цена 4'])
    const applied = tagged.options.find(o => o.key === tagged.resolvedKey)
    expect(applied?.name).toBe('Цена 4')
    expect(applied?.price).toBe(7)

    // The contrast: without `all`, the invoice dropdown keeps the filterless slots out.
    const filtered = await listPriceOptions(String(org._id), pid, String(contact._id))
    expect(names(filtered)).toEqual(['Selling price', 'Цена 4'])
  })

  it('an untagged contact resolves the base selling price (filterless tiers stay display-only)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, {
      sellingPrice: 0.0153,
      priceTiers: [{ name: 'Цена 1', percent: 0, finalPrice: 0.005, manualOverride: true, contactIds: [], tags: [] }],
    } as any)

    const res = await resolvePrice(String(org._id), String(product._id), String(contact._id))
    expect(res.finalPrice).toBe(0.0153)
    expect(res.steps).toHaveLength(1)
    const opts = await listPriceOptions(String(org._id), String(product._id), String(contact._id))
    expect(opts.resolvedKey).toBe('selling')
    expect(opts.options.filter(o => o.type === 'tier')).toHaveLength(0)
  })
})
