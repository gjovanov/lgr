#!/usr/bin/env bun
/**
 * `data-scan` — no production org's data on a throwaway database (FR-20.113, AC 45, plan step T-2).
 *
 *   MONGODB_URI=<production> bun run scripts/data-scan.ts --export > prod-orgs.json
 *   MONGODB_URI=<throwaway>  bun run scripts/data-scan.ts --denylist prod-orgs.json
 *
 * `--export` lists the ids and slugs of production's orgs, leaving out the synthetic ones (the
 * field-test orgs and the demo orgs the seed creates). It only reads: the native driver, never a
 * model, so connecting builds no index and creates no collection on production.
 *
 * `--denylist` reads EVERY document of every collection of the throwaway database and refuses on
 * any value that is one of those ids, or a string naming one of those ids or slugs. It exits 1 with
 * each finding, 0 with none. A throwaway instance is seeded by `seed-fieldtest.ts` and nothing else,
 * so any finding means real data arrived some other way: a restored backup, a copied file, a
 * mis-aimed script.
 */
import { mongoose } from '../packages/db/src/connection.js'
import { FIELDTEST_SLUG } from './lib/fieldtest-data.ts'

// The driver, as mongoose carries it. No Mongoose connection is opened: that is what builds indexes.
const { MongoClient, ObjectId } = mongoose.mongo
type Db = InstanceType<typeof mongoose.mongo.Db>

/** The orgs whose data is synthetic in production too: the field-test orgs and the demo seed's. */
export const SYNTHETIC_ORG = (slug: string) => FIELDTEST_SLUG.test(slug) || ['acme-corp', 'beta-inc'].includes(slug)

export interface Denylist { exportedAt: string; orgs: Array<{ id: string; slug: string }> }
export interface ScanFinding { collection: string; id: string; path: string; matched: string }

export async function exportDenylist(db: Db): Promise<Denylist> {
  const orgs = await db.collection('orgs').find({}, { projection: { slug: 1 } }).toArray()
  return {
    exportedAt: new Date().toISOString(),
    orgs: orgs
      .filter(o => typeof o.slug === 'string' && !SYNTHETIC_ORG(o.slug))
      .map(o => ({ id: String(o._id), slug: String(o.slug) }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  }
}

/**
 * Every value in `db` that names a denylisted org. Ids match as ObjectIds and inside strings (a
 * stored path, a URL); slugs match as whole words, so `regal` finds `regal.lgrai.app` but never
 * `regalia`, and `regal-pz` is not reported as `regal`.
 */
export async function scanDatabase(db: Db, denylist: Denylist, opts: { maxFindings?: number } = {}): Promise<ScanFinding[]> {
  const max = opts.maxFindings ?? 100
  const ids = new Set(denylist.orgs.map(o => o.id.toLowerCase()))
  const slugs = denylist.orgs.map(o => ({
    slug: o.slug,
    re: new RegExp(`(^|[^a-z0-9-])${o.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`, 'i'),
  }))
  const findings: ScanFinding[] = []

  const visit = (value: unknown, path: string, hit: (path: string, matched: string) => void): void => {
    if (value === null || value === undefined) return
    if (value instanceof ObjectId) {
      if (ids.has(value.toHexString())) hit(path, `org id ${value.toHexString()}`)
      return
    }
    if (typeof value === 'string') {
      const lower = value.toLowerCase()
      for (const id of ids) if (lower.includes(id)) hit(path, `org id ${id}`)
      for (const s of slugs) if (s.re.test(value)) hit(path, `org slug ${s.slug}`)
      return
    }
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}[${i}]`, hit)); return }
    if (typeof value === 'object' && !(value instanceof Date) && !ArrayBuffer.isView(value) && (value as any)._bsontype !== 'Binary') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, path ? `${path}.${k}` : k, hit)
    }
  }

  for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (c.name.startsWith('system.')) continue
    for await (const doc of db.collection(c.name).find({})) {
      visit(doc, '', (path, matched) => {
        if (findings.length < max) findings.push({ collection: c.name, id: String(doc._id), path, matched })
      })
      if (findings.length >= max) return findings
    }
  }
  return findings
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.error('Set MONGODB_URI to the database to read.')
    process.exit(2)
  }
  const client = await MongoClient.connect(uri)
  try {
    const db = client.db()
    if (args.includes('--export')) {
      console.log(JSON.stringify(await exportDenylist(db), null, 2))
    } else if (args.includes('--denylist')) {
      const file = args[args.indexOf('--denylist') + 1]
      const denylist: Denylist = await Bun.file(file).json()
      if (!Array.isArray(denylist.orgs) || !denylist.orgs.length) {
        console.error(`${file} lists no orgs: a scan against it would prove nothing.`)
        process.exit(2)
      }
      const findings = await scanDatabase(db, denylist)
      for (const f of findings) console.log(`${f.collection} ${f.id} ${f.path}: ${f.matched}`)
      if (findings.length) {
        console.log(`\n${findings.length} finding(s): production data is on this database (${db.databaseName}).`)
        process.exitCode = 1
      } else {
        console.log(`${db.databaseName}: none of ${denylist.orgs.length} production orgs found.`)
      }
    } else {
      console.error('Pass --export (against production) or --denylist <file> (against a throwaway database).')
      process.exitCode = 2
    }
  } finally {
    await client.close()
  }
}
