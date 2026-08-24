import { describe, it, expect } from 'bun:test'

describe('org logo controller module', () => {
  it('loads and registers its three routes', async () => {
    const { orgLogoController } = await import('../../../portal-api/src/controllers/org-logo.controller')
    const methods = (orgLogoController as any).routes.map((r: any) => `${r.method} ${r.path}`)
    expect(methods).toContain('POST /org/:orgId/logo/')
    expect(methods).toContain('GET /org/:orgId/logo/')
    expect(methods).toContain('DELETE /org/:orgId/logo/')
  })
})
