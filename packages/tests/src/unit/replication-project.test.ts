import { describe, it, expect } from 'bun:test'
import { REPLICATION_META } from 'db/replication/meta.generated'
import { homePart, keptTree, mirrorPipeline } from 'services/biz/replication/project'

/**
 * FR-20.63 (plan step P3-2a): split ownership as pages and the mirror apply it. The apply itself is
 * `integration/replication-pages.flow.test.ts`; these are the rules it is built from.
 */
describe('split ownership, applied (FR-20.63)', () => {
  it('every split model can be mirrored: no home path lies under one the mirror keeps', () => {
    const split = Object.values(REPLICATION_META).filter(e => e.class === 'S')
    expect(split.length).toBeGreaterThan(0)
    for (const e of split) expect(() => keptTree(e)).not.toThrow()
  })

  it('a declaration the mirror could not honour is refused', () => {
    expect(() => keptTree({ collection: 'x', class: 'S', orgPath: 'orgId', home: ['a.b'], global: ['a'], node: [] })).toThrow(/lies under/)
  })

  it('the master sends the home\'s parts: the most specific path decides, and a leftover goes nowhere', () => {
    const doc = {
      _id: 'org',
      name: 'Shop',
      slug: 'shop',
      subscription: { plan: 'enterprise' },
      settings: { locale: 'bg', integrations: { googleDrive: { email: 'd@x' } }, node: { ephemeralKeysEnabled: true } },
      homeEpochHighWater: 3,
      leftover: 'from an old schema',
    }
    expect(homePart(doc, REPLICATION_META.Org)).toEqual({ _id: 'org', name: 'Shop', settings: { locale: 'bg' } })
    expect(homePart({ _id: 'u', orgId: 'o', username: 'ana', password: 'x', email: 'a@x', lastLoginAt: 1 }, REPLICATION_META.User)).toEqual({ _id: 'u', orgId: 'o', username: 'ana' })
    expect(homePart({ _id: 'd', orgId: 'o', name: 'A3', status: 'online', lastCommunicationAt: 1 }, REPLICATION_META.FiscalDevice)).toEqual({ _id: 'd', orgId: 'o', name: 'A3' })
  })

  it('a replicated document is whole', () => {
    const doc = { _id: 'c', orgId: 'o', companyName: 'Client', anything: { at: 'all' } }
    expect(homePart(doc, REPLICATION_META.Contact)).toEqual(doc)
    expect(mirrorPipeline(doc, REPLICATION_META.Contact)).toEqual([{ $replaceWith: { $literal: doc } }])
  })

  it('the mirror keeps its own parts from the document it has, never from the page', () => {
    const [stage] = mirrorPipeline({ _id: 'org', name: 'Shop', slug: 'forged', settings: { locale: 'bg', integrations: { forged: true } } }, REPLICATION_META.Org) as any[]
    const merge = stage.$replaceWith.$mergeObjects
    // The page's own fields, global's dropped from them…
    expect(merge[0]).toEqual({ $literal: { _id: 'org', name: 'Shop', settings: { locale: 'bg' } } })
    // …and global's read from the mirror's current document.
    expect(merge[1].slug).toBe('$slug')
    expect(merge[1].subscription).toBe('$subscription')
    expect(JSON.stringify(merge[1].settings)).toContain('$settings.integrations')
  })
})
