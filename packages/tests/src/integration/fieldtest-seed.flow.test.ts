import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { mongoose } from 'db/connection'
import { Contact, Org, Product, ProductCategory, User, Warehouse } from 'db/models'
import { products as genProducts, PRESETS } from '../../../../scripts/lib/fieldtest-data.ts'
import { exportDenylist, scanDatabase } from '../../../../scripts/data-scan.ts'

/**
 * `seed-fieldtest.ts` and `data-scan.ts` (FR-20.112/113, AC 45, plan step T-2), against a real
 * database. The seed's API and Files phases need a running server and are driven by the two-node
 * harness (T-1). This file holds the database phase and the scan.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const adminKey = randomBytes(12).toString('base64url')

async function seed(...args: string[]) {
  const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'seed-fieldtest.ts'), ...args], {
    cwd: REPO,
    env: { ...process.env, MONGODB_URI: testDbUri(), FIELDTEST_ADMIN_PASSWORD: adminKey },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

describe('seed-fieldtest', () => {
  it('refuses an org that is not a field-test org, and writes nothing', async () => {
    const res = await seed('--org', 'regal-pz', '--execute')
    expect(res.code).toBe(2)
    expect(res.out).toContain('not a field-test org')
    expect(await Org.countDocuments({ slug: 'regal-pz' })).toBe(0)
  }, 60_000)

  it('writes nothing without --execute', async () => {
    const res = await seed('--org', 'lgr-fieldtest-dry', '--preset', 'small')
    expect(res.code).toBe(0)
    expect(res.out).toContain('Dry run')
    expect(await Org.countDocuments({ slug: 'lgr-fieldtest-dry' })).toBe(0)
  }, 60_000)

  it('makes the org the way a sign-up does, then its nomenclature, with ids from the seed', async () => {
    const res = await seed('--org', 'lgr-fieldtest-it', '--seed', '3', '--preset', 'small', '--execute')
    expect({ code: res.code, out: res.out.slice(-600) }).toMatchObject({ code: 0 })

    const org: any = await Org.findOne({ slug: 'lgr-fieldtest-it' }).lean()
    expect(org.settings.timezone).toBe('Europe/Sofia')
    const orgId = org._id
    expect(await Product.countDocuments({ orgId })).toBe(PRESETS.small.products)
    expect(await Contact.countDocuments({ orgId })).toBe(PRESETS.small.contacts)
    expect(await ProductCategory.countDocuments({ orgId })).toBe(12)
    expect(await Warehouse.countDocuments({ orgId })).toBe(1)
    const admin: any = await User.findOne({ orgId }).lean()
    expect(admin).toMatchObject({ username: 'admin', role: 'admin', isActive: true })
    expect(admin.email).toBe('admin@lgr-fieldtest-it.invalid')
    expect(admin.permissionSetIds?.length).toBe(1)

    const expected = genProducts(3, PRESETS.small.products).map(p => p._id).sort()
    const stored = (await Product.find({ orgId }).select({ _id: 1 }).lean()).map((p: any) => String(p._id)).sort()
    expect(stored).toEqual(expected)
    // The search mirrors the plugin keeps are kept for bulk inserts too.
    const one: any = await Product.findOne({ orgId }).lean()
    expect(one.nameLower).toBe(one.name.toLocaleLowerCase('bg'))
  }, 120_000)

  it('refuses to seed an org that exists, and with --replace seeds the same ids again', async () => {
    const again = await seed('--org', 'lgr-fieldtest-it', '--seed', '3', '--preset', 'small', '--execute')
    expect(again.code).toBe(1)
    expect(again.out).toContain('already exists')

    const before = (await Product.find({ sku: 'FT-000001' }).select({ _id: 1, orgId: 1 }).lean()) as any[]
    const replaced = await seed('--org', 'lgr-fieldtest-it', '--seed', '3', '--preset', 'small', '--replace', '--execute')
    expect({ code: replaced.code, out: replaced.out.slice(-600) }).toMatchObject({ code: 0 })
    const orgs = await Org.find({ slug: 'lgr-fieldtest-it' }).lean()
    expect(orgs).toHaveLength(1)
    const after = (await Product.find({ sku: 'FT-000001' }).select({ _id: 1 }).lean()) as any[]
    expect(after.map(p => String(p._id))).toEqual(before.map(p => String(p._id)))
    expect(await User.countDocuments({ email: 'admin@lgr-fieldtest-it.invalid' })).toBe(1)
  }, 180_000)
})

describe('data-scan', () => {
  const db = () => mongoose.connection.db!

  it('exports every org but the synthetic ones', async () => {
    const prod = await Org.create({ name: 'A Shop', slug: 'shop-real-one' } as any)
    await Org.create({ name: 'Demo', slug: 'acme-corp' } as any)
    const list = await exportDenylist(db() as any)
    const slugs = list.orgs.map(o => o.slug)
    expect(slugs).toContain('shop-real-one')
    expect(slugs).not.toContain('acme-corp')
    expect(slugs).not.toContain('lgr-fieldtest-it')
    expect(list.orgs.find(o => o.slug === 'shop-real-one')!.id).toBe(String(prod._id))
  })

  it('finds a production org\'s id anywhere, and its slug as a word, but not inside another word', async () => {
    const realId = new mongoose.Types.ObjectId()
    const denylist = { exportedAt: '', orgs: [{ id: String(realId), slug: 'regal-pz' }] }
    const coll = db().collection('scan_probe')
    await coll.insertMany([
      { _id: 'by-id' as any, orgId: realId },
      { _id: 'in-a-path' as any, nested: { path: `uploads/${realId}/x.pdf` } },
      { _id: 'by-slug' as any, notes: 'imported from regal-pz.lgrai.app' },
      { _id: 'in-an-array' as any, tags: ['x', 'REGAL-PZ'] },
      { _id: 'not-a-word' as any, notes: 'regal-pzx and xregal-pz are other names' },
    ])
    const found = (await scanDatabase(db() as any, denylist)).filter(f => f.collection === 'scan_probe')
    expect(found.map(f => `${f.id} ${f.path}`).sort()).toEqual([
      'by-id orgId', 'by-slug notes', 'in-a-path nested.path', 'in-an-array tags[1]',
    ])
    await coll.drop()
  })

  it('finds nothing on a database the generator alone seeded', async () => {
    const denylist = { exportedAt: '', orgs: [{ id: String(new mongoose.Types.ObjectId()), slug: 'regal-pz' }, { id: String(new mongoose.Types.ObjectId()), slug: 'regal' }] }
    expect(await scanDatabase(db() as any, denylist)).toEqual([])
  })
})
