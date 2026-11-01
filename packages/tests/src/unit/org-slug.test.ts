import { describe, it, expect } from 'bun:test'
import { currentAppId, orgSlugFromName } from 'ui-shared/session/useOrgSession'

/**
 * The new-org dialog suggests the org's address from its name. The server takes only lowercase
 * letters, digits and dashes, and LGR's orgs are mostly named in Cyrillic, so a suggestion that
 * dropped every Cyrillic letter would leave the field empty for exactly the people who use it.
 */
describe('orgSlugFromName', () => {
  it('transliterates Bulgarian and Macedonian names', () => {
    expect(orgSlugFromName('Регал Пловдив')).toBe('regal-plovdiv')
    expect(orgSlugFromName('Щастие ООД')).toBe('shtastie-ood')
    expect(orgSlugFromName('Ѓорѓи Њушки')).toBe('gjorgji-njushki')
  })

  it('keeps what the server accepts and collapses the rest', () => {
    expect(orgSlugFromName('  Acme & Co.  ')).toBe('acme-co')
    expect(orgSlugFromName('Müller GmbH')).toBe('muller-gmbh')
    expect(orgSlugFromName('A--B__C')).toBe('a-b-c')
    expect(orgSlugFromName('!!!')).toBe('')
  })

  it('never ends in a dash, even when cut to the server\'s 50 characters', () => {
    const slug = orgSlugFromName(`${'a'.repeat(49)} b`)
    expect(slug.length).toBeLessThanOrEqual(50)
    expect(slug.endsWith('-')).toBe(false)
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(orgSlugFromName('Регал - Пловдив / Склад 2'))).toBe(true)
  })
})

describe('currentAppId', () => {
  it('names the domain app a path belongs to, and the portal for everything else', () => {
    expect(currentAppId('/invoicing/invoices')).toBe('invoicing')
    // FR-24 Phase 0: POS pages are under the invoicing SPA, and the longer base wins.
    expect(currentAppId('/invoicing/pos')).toBe('pos')
    expect(currentAppId('/invoicing/pos/terminal')).toBe('pos')
    expect(currentAppId('/invoicing/posters')).toBe('invoicing')
    expect(currentAppId('/apps')).toBe('portal')
    expect(currentAppId('/settings/users')).toBe('portal')
    // A prefix is not an app: `/posters` is not the POS.
    expect(currentAppId('/posters')).toBe('portal')
  })
})
