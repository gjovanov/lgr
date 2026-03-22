import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from 'bun:test'
import { config } from 'config'

describe('Purestat Analytics Service', () => {
  let originalEnabled: boolean
  let originalTrackerUrl: string

  beforeAll(() => {
    originalEnabled = config.externalIntegrations?.purestat?.enabled ?? false
    originalTrackerUrl = config.externalIntegrations?.purestat?.trackerUrl ?? ''
  })

  afterAll(() => {
    config.externalIntegrations.purestat.enabled = originalEnabled
    config.externalIntegrations.purestat.trackerUrl = originalTrackerUrl
  })

  beforeEach(() => {
    config.externalIntegrations.purestat.enabled = false
    config.externalIntegrations.purestat.trackerUrl = 'http://localhost:8001'
  })

  it('should be a no-op when purestat is disabled', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
    config.externalIntegrations.purestat.enabled = false

    // Re-import to get fresh module
    const { trackEvent } = await import('services/biz/purestat.service')
    await trackEvent('test.event', { orgId: 'org1' })

    // fetch should NOT have been called
    const purestatCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('purestat') || String(call[0]).includes('8001'),
    )
    expect(purestatCalls.length).toBe(0)
    fetchSpy.mockRestore()
  })

  it('should send correct payload when enabled', async () => {
    config.externalIntegrations.purestat.enabled = true
    config.externalIntegrations.purestat.trackerUrl = 'http://localhost:8001'

    let capturedUrl = ''
    let capturedBody: any = null

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      capturedUrl = String(input)
      if (init?.body) {
        capturedBody = JSON.parse(String(init.body))
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202 })
    })

    const { trackEvent } = await import('services/biz/purestat.service')
    await trackEvent('invoice.posted', { orgId: 'org123', total: 500 })

    expect(capturedUrl).toBe('http://localhost:8001/api/event')
    expect(capturedBody).toEqual({
      name: 'invoice.posted',
      url: 'https://lgrai.app/api/invoice.posted',
      domain: 'lgrai.app',
      props: { orgId: 'org123', total: 500 },
    })

    fetchSpy.mockRestore()
  })

  it('should handle fetch timeout gracefully (no throw)', async () => {
    config.externalIntegrations.purestat.enabled = true
    config.externalIntegrations.purestat.trackerUrl = 'http://localhost:8001'

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('TimeoutError: signal timed out')
    })

    const { trackEvent } = await import('services/biz/purestat.service')

    // Should NOT throw — errors are swallowed
    await trackEvent('payment.recorded', { orgId: 'org1', amount: 100 })

    fetchSpy.mockRestore()
  })

  it('should handle network errors gracefully (no throw)', async () => {
    config.externalIntegrations.purestat.enabled = true
    config.externalIntegrations.purestat.trackerUrl = 'http://localhost:8001'

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })

    const { trackEvent } = await import('services/biz/purestat.service')

    // Should NOT throw
    await trackEvent('sales.order.confirmed', { orgId: 'org1', lines: 3 })

    fetchSpy.mockRestore()
  })
})
