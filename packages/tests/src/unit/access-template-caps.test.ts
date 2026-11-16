import { describe, it, expect } from 'bun:test'
import { CAPABILITIES, ROLE_TEMPLATES, TEMPLATE_CAPS, compileLegacy, sameGrant, templateGrant } from 'config/access'

/**
 * FR-27 Phase 3, P3-4 (#529) — the built-in roles are data (`config/access/template-caps.ts`). Until the legacy model
 * goes (P3-6), each one is pinned to what its legacy role's defaults compile to: nobody's access moved when the
 * templates stopped being compiled. Remove the pin with the legacy tables, never before.
 */

describe('the templates are data', () => {
  it('one entry per built-in role, and nothing else', () => {
    expect(Object.keys(TEMPLATE_CAPS).sort()).toEqual(ROLE_TEMPLATES.map(t => t.key).sort())
  })

  for (const t of ROLE_TEMPLATES) {
    it(`${t.key}: exactly what its legacy role compiled to`, () => {
      expect(sameGrant(templateGrant(t.key), compileLegacy(t.legacy))).toBe(true)
    })
  }

  it('every capability a template names is in the catalogue, once', () => {
    const known = new Set<string>(CAPABILITIES)
    for (const [key, caps] of Object.entries(TEMPLATE_CAPS)) {
      if (caps === '*') continue
      expect([key, caps.filter(c => !known.has(c))]).toEqual([key, []])
      expect(new Set(caps).size).toBe(caps.length)
    }
  })

  it('only the Administrator is every capability', () => {
    expect(Object.entries(TEMPLATE_CAPS).filter(([, caps]) => caps === '*').map(([key]) => key)).toEqual(['admin'])
  })
})
