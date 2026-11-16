import { describe, it, expect } from 'bun:test'
import { advance, type OrgFacts } from '../../../../scripts/lib/access-advance'

/**
 * FR-27 Phase 3, P3-1 (#529) — what `access-model.ts --all` moves. Two steps, because an org on `legacy` counts no
 * differences: its "0" proves nothing.
 */

const now = new Date('2026-11-20T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000)
const facts = (over: Partial<OrgFacts>): OrgFacts => ({ slug: 'shop', model: 'legacy', withoutRole: 0, shadowSince: null, differences: 0, ...over })
const go = (f: Partial<OrgFacts>, target: 'shadow' | 'roles', minDays = 1) => advance(facts(f), target, { now, minDays })

describe('--set shadow', () => {
  it('moves an org on legacy whose people all have a role', () => {
    expect(go({}, 'shadow')).toEqual({ move: true, reason: 'legacy → shadow' })
  })
  it('skips an org with someone 0015 cannot give a role, and an org already on shadow or roles', () => {
    expect(go({ withoutRole: 2 }, 'shadow').move).toBe(false)
    expect(go({ model: 'shadow' }, 'shadow').reason).toBe('already on shadow')
    expect(go({ model: 'roles' }, 'shadow').move).toBe(false)
  })
})

describe('--set roles', () => {
  it('moves an org a full day on shadow with no difference and everyone on a role', () => {
    expect(go({ model: 'shadow', shadowSince: daysAgo(1.5) }, 'roles').move).toBe(true)
  })
  it('never straight from legacy: its zero proves nothing', () => {
    expect(go({ model: 'legacy' }, 'roles')).toEqual({ move: false, reason: 'on legacy: --set shadow first, and a day there' })
  })
  it('waits for the day, refuses a difference, someone without a role, or no record of the move', () => {
    expect(go({ model: 'shadow', shadowSince: daysAgo(0.5) }, 'roles').reason).toContain('less than 1')
    expect(go({ model: 'shadow', shadowSince: daysAgo(3) }, 'roles', 7).move).toBe(false)
    expect(go({ model: 'shadow', shadowSince: daysAgo(2), differences: 3 }, 'roles').reason).toContain('3 difference(s)')
    expect(go({ model: 'shadow', shadowSince: daysAgo(2), withoutRole: 1 }, 'roles').move).toBe(false)
    expect(go({ model: 'shadow', shadowSince: null }, 'roles').move).toBe(false)
  })
  it('leaves an org on roles where it is', () => {
    expect(go({ model: 'roles' }, 'roles').reason).toBe('already on roles')
  })
})
