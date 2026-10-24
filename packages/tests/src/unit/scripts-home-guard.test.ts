import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Scripts refuse to write for an org homed elsewhere (FR-20.4, plan step P0b-6).
 *
 * The rule is about the DATABASE, not about spotting every kind of write: a script that opens the
 * database in-process (and so writes through models, raw collections or services) checks the home
 * first, through `scripts/lib/home-guard.ts` or `db/home/home` directly. A script that talks to the
 * API over HTTP is already behind the route gate and is not scanned. A script that only reads is
 * listed below with its reason.
 */

const SCRIPTS = join(import.meta.dir, '..', '..', '..', '..', 'scripts')

/** Opens the database itself. */
const OPENS_DB = /connectDB\(|mongoose\.connect\(|MongoClient|from '(?:\.\.\/)*(?:packages\/db\/src\/|db\/)connection|require\('\.\/src\/models'\)/

/** Checks the home: the shared helper, or the home module itself (scripts that run from a pod path). */
const GUARDED = /assertScriptHome\(|keepHomeOrgs\(|tenantHomeScope\(|assertAllOrgsHome\(|assertHomeIsHere\(|isHomeHere\(/

const READ_ONLY: Record<string, string> = {
  'preview-daily-digest.ts': 'renders a digest to an HTML file: no send, no claim',
  'data-scan.ts': 'reads every collection for production orgs\' ids and slugs (FR-20.113): writes nothing',
}

const sources = () =>
  readdirSync(SCRIPTS, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.ts'))
    .map(e => ({ name: e.name, src: readFileSync(join(SCRIPTS, e.name), 'utf8') }))

describe('scripts check the home before they write', () => {
  it('the scan sees the scripts directory', () => {
    // Guards against a wrong path making the real check vacuous.
    expect(sources().filter(s => OPENS_DB.test(s.src)).length).toBeGreaterThan(20)
  })

  it('every script that opens the database is guarded or listed as read-only', () => {
    const unguarded = sources()
      .filter(s => OPENS_DB.test(s.src) && !GUARDED.test(s.src) && !READ_ONLY[s.name])
      .map(s => s.name)
    expect(unguarded).toEqual([])
  })

  it('a read-only exemption is still a script that exists and opens the database', () => {
    const byName = new Map(sources().map(s => [s.name, s.src]))
    for (const name of Object.keys(READ_ONLY)) {
      expect(byName.has(name)).toBe(true)
      expect(OPENS_DB.test(byName.get(name)!)).toBe(true)
    }
  })

  it('the detector flags an unguarded writer and accepts a guarded one (positive control)', () => {
    const writer = "import { connectDB } from '../packages/db/src/connection.js'\nawait connectDB()\nawait Product.updateMany({}, { $set: { x: 1 } })"
    expect(OPENS_DB.test(writer) && !GUARDED.test(writer)).toBe(true)
    const guarded = writer + '\nawait assertScriptHome(org._id)'
    expect(GUARDED.test(guarded)).toBe(true)
    expect(OPENS_DB.test("const { DocFile } = require('./src/models')")).toBe(true)
  })

  it('no script reads the `organizations` collection, which does not exist (the Org model is `orgs`)', () => {
    const bad = sources().filter(s => /collection\(\s*['"]organizations['"]/.test(s.src)).map(s => s.name)
    expect(bad).toEqual([])
  })
})
