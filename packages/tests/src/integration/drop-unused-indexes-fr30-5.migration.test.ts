import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { mongoose } from 'db/connection'
import 'db/models'
import { MIGRATIONS } from 'migrations/registry'
import { dropUnusedIndexesFr305, UNUSED_INDEXES, KEPT } from 'migrations/migrations/0022-drop-unused-indexes-fr30-5'

/**
 * FR-30.5 (#868): migration 0022 drops, by name, the indexes production did not use, and the schemas no longer
 * declare them (a server builds what a schema declares, so a declared one would come back at the next start). What
 * production did not use and is kept stays declared. A collection or an index that is not there is skipped; a second
 * run, and the dry run after it, find nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

const db = () => mongoose.connection.db!
const ctx = (said: string[]) => ({ db: db(), log: (m: string) => { said.push(m) }, orgFilter: {} })

/** Every index a schema declares, as `<collection>.<name>`: the name it is given, or the one MongoDB makes. */
function declared(): Set<string> {
  const out = new Set<string>()
  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName)
    for (const [key, options] of model.schema.indexes()) {
      const name = (options as { name?: string } | undefined)?.name ?? Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_')
      out.add(`${model.collection.collectionName}.${name}`)
    }
  }
  return out
}

const dropped = Object.entries(UNUSED_INDEXES).flatMap(([collection, names]) => names.map(name => `${collection}.${name}`))
const indexNames = async (collection: string) => (await db().collection(collection).indexes()).map(i => i.name).sort()

describe('0022-drop-unused-indexes-fr30-5 (FR-30.5, #868)', () => {
  it('is registered right after 0021', () => {
    const ids = MIGRATIONS.map(m => m.id)
    expect(ids.indexOf('0022-drop-unused-indexes-fr30-5')).toBe(ids.indexOf('0021-relay-receipts-kept-60-days') + 1)
  })

  it('no schema declares what it drops; every kept index is still declared; none is both', () => {
    const schemas = declared()
    expect(dropped.filter(k => schemas.has(k))).toEqual([])
    expect(Object.keys(KEPT).filter(k => !schemas.has(k))).toEqual([])
    expect(dropped.filter(k => k in KEPT)).toEqual([])
    expect(new Set(dropped).size).toBe(dropped.length)
  })

  it('drops what is there by name, leaves every other index, skips what is not there; a second run finds nothing', async () => {
    await db().collection('din_catalog').insertOne({ din: 'DIN 0022', baseNumber: '0022', categoryIndex: 1, category: 'test' })
    await db().collection('din_catalog').createIndex({ baseNumber: 1 })
    await db().collection('din_catalog').createIndex({ categoryIndex: 1 })
    // A dotted name: the collection is what comes before its first dot.
    await db().collection('products').createIndex({ orgId: 1, 'priceTiers.tags': 1 })
    // One of a collection's listed indexes, not the others.
    await db().collection('warehouses').createIndex({ nameLower: 1 })
    await db().collection('warehouses').createIndex({ orgId: 1 })

    const preview = await dropUnusedIndexesFr305.preview!(ctx([]))
    for (const k of ['din_catalog.baseNumber_1', 'din_catalog.categoryIndex_1', 'products.orgId_1_priceTiers.tags_1', 'warehouses.nameLower_1']) {
      expect(preview).toContain(`would drop ${k}`)
    }
    expect(preview).not.toContain('would drop warehouses.codeLower_1')

    const said: string[] = []
    await dropUnusedIndexesFr305.up(ctx(said))
    expect(said).toContain('din_catalog: the unused index baseNumber_1 dropped')
    expect(said).toContain('products: the unused index orgId_1_priceTiers.tags_1 dropped')
    expect(said).toContain('warehouses: the unused index nameLower_1 dropped')
    expect(await indexNames('din_catalog')).not.toContain('baseNumber_1')
    expect(await indexNames('din_catalog')).not.toContain('categoryIndex_1')
    expect(await indexNames('din_catalog')).toContain('_id_')
    expect(await indexNames('products')).not.toContain('orgId_1_priceTiers.tags_1')
    expect(await indexNames('warehouses')).toContain('orgId_1')
    expect(await indexNames('warehouses')).not.toContain('nameLower_1')

    const again: string[] = []
    await dropUnusedIndexesFr305.up(ctx(again))
    expect(again).toEqual([])
    expect(await dropUnusedIndexesFr305.preview!(ctx([]))).toEqual([])
  })
})
