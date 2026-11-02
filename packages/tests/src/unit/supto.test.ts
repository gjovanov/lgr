import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SUPTO_DECLARED, SUPTO_VERSION, SUPTO_VERSION_RE, suptoOffer, suptoWaits } from 'config/supto'

/**
 * FR-20.50 (plan step P3-8c): a SUPTO version travels only once declared. The same rule as the
 * supervisor's `supto::waits` (packages/server/src/supto.rs), case for case; and the data file in the
 * shape the deploy reads with jq on the build host (`.version`, `.declared`).
 */

const ROOT = join(import.meta.dir, '..', '..', '..', '..')

describe('a SUPTO version travels only once declared (FR-20.50)', () => {
  it('nothing waits while nothing is declared: LGR is not on НАП\'s list yet', () => {
    expect(suptoOffer('2', [])).toEqual({ version: '2', declared: false, enforced: false })
    expect(suptoWaits(suptoOffer('2', []), '1')).toBeNull()
  })

  it('once something is: a declared version travels, and so does a build within the running one', () => {
    expect(suptoWaits(suptoOffer('2', ['1', '2']), '1')).toBeNull()
    expect(suptoWaits(suptoOffer('1', ['0']), '1')).toBeNull()
  })

  it('an undeclared new version waits, by its version; one that names none, or none that is one, cannot be shown declared', () => {
    expect(suptoWaits(suptoOffer('2', ['1']), '1')).toBe('2')
    expect(suptoWaits(suptoOffer('2', ['1']), null)).toBe('2')
    expect(suptoWaits(suptoOffer(null, ['1']), '1')).toBe('unknown')
    expect(suptoOffer('../2', ['1'])).toEqual({ version: null, declared: false, enforced: true })
    expect(suptoOffer(' 2\n', ['2'])).toEqual({ version: '2', declared: true, enforced: true })
  })

  it('FR-23 changed the database structure (a `payment_receipt` in 18.1–18.3 and 18.5), and that is a new version', () => {
    // By hand, in the commit that makes such a change (the file's own rule). Declaring it is the owner's act.
    expect(SUPTO_VERSION).toBe('2')
    expect(SUPTO_DECLARED).toEqual([])
  })

  it('the data file: a version, the declared ones, in the shape the deploy gate reads with jq', () => {
    const file = JSON.parse(readFileSync(join(ROOT, 'packages', 'config', 'src', 'supto.json'), 'utf8'))
    expect(typeof file.about).toBe('string')
    expect(SUPTO_VERSION_RE.test(file.version)).toBe(true)
    expect(Array.isArray(file.declared) && file.declared.every((v: unknown) => typeof v === 'string' && SUPTO_VERSION_RE.test(v))).toBe(true)
    expect([SUPTO_VERSION, SUPTO_DECLARED]).toEqual([file.version, file.declared])
    // The deploy script reads exactly these.
    const deploy = readFileSync(join(ROOT, 'scripts', 'deploy-prod.sh'), 'utf8')
    for (const filter of [`jq -er '.version'`, `'.declared | length > 0'`, `'any(.declared[]; . == $v)'`, 'packages/config/src/supto.json']) expect(deploy).toContain(filter)
    expect(deploy).toMatch(/if \[\[ \$DO_BUILD == 1 && \$DO_APP == 1 \]\]; then supto_gate; fi/)
  })

  it('the release workflow publishes it beside the bundles, and the home carries it', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'server-release.yml'), 'utf8')
    expect(workflow).toContain(`> "release/lgr-server-$v.supto"`)
    const assemble = readFileSync(join(ROOT, 'scripts', 'assemble-server-home.ts'), 'utf8')
    expect(assemble).toMatch(/supto: JSON\.parse\(readFileSync\(join\(ROOT, 'packages', 'config', 'src', 'supto\.json'\)/)
  })
})
