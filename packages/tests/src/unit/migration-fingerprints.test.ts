import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fingerprintOf, fingerprintOfFile, MIGRATIONS_DIR, FINGERPRINTS_FILE } from 'migrations/fingerprint'
import { MIGRATIONS, RELEASED } from 'migrations/registry'
import { checksumOf, legacyChecksumOf } from 'migrations/runner'

/**
 * The runner checksums a migration by its file's fingerprint (`fingerprints.json`), never by
 * `up.toString()`, which a bundle prints differently (FR-20 plan step P0b-9).
 *
 * This keeps the committed fingerprints true: a migration file edited after release, or a new one
 * registered without its line, fails here, in CI, instead of on a node.
 */

const recorded: Record<string, string> = JSON.parse(readFileSync(FINGERPRINTS_FILE, 'utf8'))

describe('migration fingerprints', () => {
  it('every registered migration has one, and it is its file as it is now', () => {
    for (const m of RELEASED) {
      expect({ id: m.id, fingerprint: recorded[m.id] }).toEqual({ id: m.id, fingerprint: fingerprintOfFile(m.id) })
    }
  })

  it('records nothing for a migration that is not registered', () => {
    expect(Object.keys(recorded).sort()).toEqual(RELEASED.map(m => m.id).sort())
  })

  it('every file in migrations/ is registered: an unregistered one would never run', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.ts')).map(f => f.slice(0, -3)).sort()
    expect(files).toEqual(RELEASED.map(m => m.id).sort())
  })

  it('the registry attaches them, and the checksum is taken over the fingerprint, not over `up`', () => {
    for (const m of MIGRATIONS) {
      expect(m.fingerprint).toBe(recorded[m.id])
      expect(checksumOf(m)).not.toBe(legacyChecksumOf(m))
    }
  })

  it('ignores line endings and indentation, and sees any other edit', () => {
    const text = 'export const x = {\n  id: "0009-x",\n}\n'
    expect(fingerprintOf(text.replace(/\n/g, '\r\n'))).toBe(fingerprintOf(text))
    expect(fingerprintOf(text.replace(/  /g, '\t'))).toBe(fingerprintOf(text))
    expect(fingerprintOf(text.replace('0009-x', '0009-y'))).not.toBe(fingerprintOf(text))
  })

  it('a migration without a fingerprint (a test\'s) keeps the old checksum', () => {
    const m = { id: '0001-t', description: 't', async up() {} }
    expect(checksumOf(m)).toBe(legacyChecksumOf(m))
  })
})
