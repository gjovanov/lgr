import { describe, it, expect } from 'bun:test'
import { CAPABILITIES, ROLE_TEMPLATES, TEMPLATE_CAPS } from 'config/access'

/**
 * FR-27 Phase 3, P3-4 (#529) — the built-in roles are data (`config/access/template-caps.ts`). Each is pinned to what
 * its legacy role's defaults compiled to in `unit/access-legacy-frozen.test.ts`, legacy.ts's own test (FR-27 P3-6).
 */

describe('the templates are data', () => {
  it('one entry per built-in role, and nothing else', () => {
    expect(Object.keys(TEMPLATE_CAPS).sort()).toEqual(ROLE_TEMPLATES.map(t => t.key).sort())
  })

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
