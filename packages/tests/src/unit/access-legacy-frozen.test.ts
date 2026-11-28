import { describe, it, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from 'config/constants'
import { ROLE_TEMPLATES, can, compileLegacy, legacyClaimsOf, sameGrant, templateGrant } from 'config/access'

/**
 * FR-27 P3-6 (#529) — `config/access/legacy.ts` is frozen, and it is the legacy model's last home.
 *
 * Released migration 0015 imports it (`compileLegacy`, `legacyClaimsOf`, through `config/access`), and a released
 * migration is never edited: its fingerprint is its own file, so a change to legacy.ts would change what 0015 does
 * without the runner noticing. Nothing else may decide by the legacy model any more, so nothing else imports it.
 *
 * This is legacy.ts's own test: the one place outside `packages/migrations/` (and 0015's own test) that reads it.
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const LEGACY = join(ROOT, 'packages', 'config', 'src', 'access', 'legacy.ts')

/**
 * The file's SHA-256, its line ends as LF. Changing legacy.ts changes what migration 0015 does on its next run (a new
 * org, a restored bundle): do not. If a change is ever unavoidable, it is a new migration's, and this pin moves with
 * a reason in the commit.
 */
const FROZEN_SHA256 = '0db40d6c1584db96cc6ae751b2a624493415796c0a0706752a4fdd3c7b339960'

/** Where the legacy model may still be named, and why. */
const MAY_IMPORT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^packages\/config\/src\/access\/legacy\.ts$/, 'the file itself'],
  [/^packages\/config\/src\/access\/index\.ts$/, 'the barrel 0015 imports it through'],
  [/^packages\/config\/src\/access\/templates\.ts$/, "a template's `legacy` claims, which 0015 compares a person with"],
  [/^packages\/config\/src\/access\/roles\.ts$/, "`legacyKeyOf`'s type, 0015's key for an imported role"],
  [/^packages\/migrations\//, 'released migrations (0015)'],
  [/^packages\/tests\/src\/unit\/access-legacy-frozen\.test\.ts$/, 'this test'],
  [/^packages\/tests\/src\/integration\/roles-migration\.flow\.test\.ts$/, "0015's own test: the oracle it proves the migration against"],
  [/^packages\/tests\/src\/integration\/roles-before-archive\.migration\.test\.ts$/, "0016-roles-before-the-archive's test: 0015's rules are its oracle too"],
  [/^packages\/tests\/src\/unit\/access-client-grants\.test\.ts$/, 'a ratchet that names the compiler to forbid it in the client'],
  [/^packages\/tests\/src\/unit\/access-no-legacy\.test\.ts$/, "P3-8's grep test (acceptance 2): it names the compiler to forbid it everywhere else"],
]

/** A use of the legacy model: its compiler, its claims reader, its tables, or the file by path. */
const LEGACY_NAMES = /\b(compileLegacy|legacyClaimsOf|LEGACY_BRIDGE|LEGACY_ROLE_AREAS|LegacyClaims|LegacySet)\b|access\/legacy(\.js)?['"]/

/** The code of a source, without its comments: a comment may say what the legacy model was. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(ts|vue)$/.test(name)) out.push(path)
  }
  return out
}

describe('legacy.ts is frozen (FR-27 P3-6)', () => {
  it('its bytes are the ones migration 0015 was released against', () => {
    const text = readFileSync(LEGACY, 'utf8').replace(/\r\n/g, '\n')
    expect(createHash('sha256').update(text).digest('hex')).toBe(FROZEN_SHA256)
  })

  it('only the migrations, its own test and the files 0015 reads through name it', () => {
    const files = [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'scripts'))]
    expect(files.length).toBeGreaterThan(500)
    const named = files
      .map(f => relative(ROOT, f).replace(/\\/g, '/'))
      .filter(rel => !MAY_IMPORT.some(([re]) => re.test(rel)))
      .filter(rel => LEGACY_NAMES.test(code(readFileSync(join(ROOT, rel), 'utf8'))))
    expect(named).toEqual([])
  })
})

describe('what 0015 reads from it, unchanged', () => {
  for (const t of ROLE_TEMPLATES) {
    it(`${t.key}: its template is exactly what its legacy role compiled to`, () => {
      expect(sameGrant(templateGrant(t.key), compileLegacy(t.legacy))).toBe(true)
    })
  }

  it('legacyClaimsOf, no set: the role defaults, the own list on top, the role areas', () => {
    expect(legacyClaimsOf({ role: 'member', permissions: ['inventory.write'] }, [])).toMatchObject({
      role: 'member', permissions: [...DEFAULT_ROLE_PERMISSIONS.member, 'inventory.write'],
    })
    expect(legacyClaimsOf({ role: 'seller' }, []).areas).toEqual([])
    expect(legacyClaimsOf({ role: 'sales_consultant' }, []).areas).toEqual(['orders'])
    expect(legacyClaimsOf({ role: 'member' }, []).areas).toBeUndefined()
  })

  it('legacyClaimsOf, sets: their union, every permission for an admin set, the areas merged', () => {
    expect(legacyClaimsOf({ role: 'member', permissions: ['payroll.read'] }, [{ permissions: ['invoicing.read'] }, { permissions: ['pos.read'] }]).permissions).toEqual(['invoicing.read', 'pos.read'])
    expect(legacyClaimsOf({ role: 'member' }, [{ permissions: [], isAdmin: true }]).permissions).toEqual([...PERMISSIONS])
    expect(legacyClaimsOf({ role: 'member' }, [{ areas: [] }, { areas: ['orders'] }]).areas).toEqual(['orders'])
    expect(legacyClaimsOf({ role: 'member' }, [{ areas: [] }, {}]).areas).toBeUndefined()
  })

  it('compileLegacy: an areas list takes the totals, the import and changing organization (#493, FR-27 D-8)', () => {
    expect(can(compileLegacy({ role: 'member', permissions: [] }), 'org.switch')).toBe(true)
    expect(can(compileLegacy({ role: 'member', permissions: [], areas: ['portal'] }), 'org.switch')).toBe(false)
    expect(can(compileLegacy({ role: 'member', permissions: ['invoicing.write'], areas: [] }), 'sales-docs.import')).toBe(false)
    expect(compileLegacy({ role: 'admin' }).all).toBe(true)
    expect(compileLegacy(null).caps.size).toBe(0)
  })
})
