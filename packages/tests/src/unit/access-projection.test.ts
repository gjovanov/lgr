import { describe, it, expect } from 'bun:test'
import { ROLES } from 'config/constants'
import { CAPABILITIES, compileLegacy, projectGrant, sameGrant, templateGrant, type CapabilityId, type Grant } from 'config/access'

/**
 * FR-27 §4 step 3 (#529) — a role's legacy projection: what an org on the legacy model, or a master on an older
 * release, serves its people. Exact for every built-in role; never more than the role, for any role.
 */

const within = (inner: Grant, outer: Grant) => outer.all || (!inner.all && [...inner.caps].every(c => outer.caps.has(c)))

describe('the legacy projection', () => {
  it('is exact for every built-in role', () => {
    for (const role of ROLES) {
      const grant = templateGrant(role)
      const p = projectGrant(grant)
      expect({ role, exact: p.exact, same: sameGrant(compileLegacy(p.legacy), grant) }).toEqual({ role, exact: true, same: true })
    }
  })

  it('never serves more than the role, whatever the role holds (2000 random roles)', () => {
    const all = [...CAPABILITIES] as CapabilityId[]
    let seed = 529
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const failures: string[] = []
    for (let i = 0; i < 2000; i++) {
      const density = random()
      const grant: Grant = { caps: new Set(all.filter(() => random() < density)) }
      const p = projectGrant(grant)
      const served = compileLegacy(p.legacy)
      if (!within(served, grant)) {
        failures.push(`role of ${grant.caps.size} caps served ${[...(served as any).caps].filter((c: CapabilityId) => !grant.caps.has(c)).join(', ')}`)
      }
      if (p.exact !== sameGrant(served, grant)) failures.push('`exact` disagrees with the served grant')
    }
    expect(failures.slice(0, 5)).toEqual([])
  })

  it('the Administrator is the admin role', () => {
    expect(projectGrant({ all: true })).toMatchObject({ legacy: { role: 'admin' }, exact: true })
  })
})
