import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { logger } from 'services/logger'
import { renderInvoicePdf } from 'invoicing-api/src/lib/invoice-pdf'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg } from '../helpers/factories'

/**
 * #896: a master whose browser could not start printed no PDF and said nothing. The 503 reached the person
 * as "temporarily unavailable", and the log held no line about it. The browser's own message is the cause (a
 * library it cannot load, a sandbox the kernel refuses), and on a master the log is the only place anyone
 * looks, so it has to be there.
 *
 * The failure here is a real one: a launch that fails because the path holds no browser.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const savedChromePath = config.pdf.chromePath

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  ;(config.pdf as any).chromePath = savedChromePath
  await clearCollections()
}, 30_000)

describe('#896: a browser that cannot start is in the log', () => {
  it('logs the browser\'s own message beside the 503, with the org and the document', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id)
    ;(config.pdf as any).chromePath = join(tmpdir(), 'no-browser-here', 'chrome-headless-shell')

    const spy = spyOn(logger, 'error')
    let result: any
    let calls: any[][] = []
    try {
      result = await renderInvoicePdf(String(org._id), String(invoice._id), {})
      calls = spy.mock.calls.map(c => [...c])
    } finally {
      spy.mockRestore()
    }

    // What the caller gets is what it always got.
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.message).toContain('temporarily unavailable')

    // And the log says why: whose document, and what the browser said (puppeteer names the path it could not start).
    const line = calls.find(c => c[1] === 'The invoice PDF could not be rendered')
    expect(line).toBeDefined()
    expect(line![0].orgId).toBe(String(org._id))
    expect(line![0].invoiceId).toBe(String(invoice._id))
    expect(String(line![0].err)).toContain('no-browser-here')
    expect(String(line![0].err).length).toBeLessThanOrEqual(300)
  }, 60_000)
})
