import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { Org, OrgLogo } from 'db/models'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { bundledLogoDataUri } from 'reporting/pdf/logo'
import {
  OrgLogoError,
  deleteOrgLogo,
  getOrgLogoBytes,
  getOrgLogoDataUri,
  getOrgLogoMeta,
  saveOrgLogo,
} from 'services/biz/org-logo.service'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/** Header-only PNG — the service reads the header, never the pixels. */
function png(width: number, height: number, salt = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  ihdr[24] = salt
  return Buffer.concat([sig, ihdr])
}

const invoiceFixture = {
  invoiceNumber: 'INV-2026-00001',
  type: 'invoice',
  direction: 'outgoing',
  issueDate: new Date('2026-08-24'),
  currency: 'BGN',
  subtotal: 100,
  taxTotal: 20,
  total: 120,
  lines: [{ description: 'Item', quantity: 1, unit: 'бр', unitPrice: 100, taxRate: 20, lineTotal: 120 }],
}

/**
 * `.rejects` / `.resolves` deadlock on Windows when the rejection follows driver I/O
 * (CLAUDE.md → Known Issues), so failures are captured by hand.
 */
async function captureRejection(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

describe('org logo — storage round trip', () => {
  it('stores the bytes and points Org.logo at the versioned endpoint URL', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const meta = await saveOrgLogo(orgId, png(600, 200), 'image/png', undefined)

    expect(meta.mimeType).toBe('image/png')
    expect(meta.width).toBe(600)
    expect(meta.height).toBe(200)
    expect(meta.url).toBe(`/api/org/${orgId}/logo?v=${meta.hash}`)

    const stored = await Org.findById(orgId).lean()
    expect((stored as any).logo).toBe(meta.url)

    const bytes = await getOrgLogoBytes(orgId)
    expect(bytes?.data.equals(png(600, 200))).toBe(true)
  })

  it('serves a data URI the PDF renderer can use, and caches it by hash', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    await saveOrgLogo(orgId, png(600, 200), 'image/png')

    const uri = await getOrgLogoDataUri(orgId)
    expect(uri).toStartWith('data:image/png;base64,')
    // Second read is served from the in-process cache — same value, no staleness.
    expect(await getOrgLogoDataUri(orgId)).toBe(uri!)
  })

  it('replacing the logo changes the hash, the URL and the served bytes', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const first = await saveOrgLogo(orgId, png(600, 200, 1), 'image/png')
    const firstUri = await getOrgLogoDataUri(orgId)

    const second = await saveOrgLogo(orgId, png(600, 200, 2), 'image/png')

    expect(second.hash).not.toBe(first.hash)
    expect(second.url).not.toBe(first.url)
    expect(await getOrgLogoDataUri(orgId)).not.toBe(firstUri!)
    // Upsert, not insert: one logo per org.
    expect(await OrgLogo.countDocuments({ orgId })).toBe(1)
  })

  it('rejects a file that is not one of the accepted image formats', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const err = await captureRejection(() => saveOrgLogo(orgId, Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'))
    expect(err).toBeInstanceOf(OrgLogoError)
    expect(err.statusCode).toBe(400)

    // Nothing was written, and the org is untouched.
    expect(await OrgLogo.countDocuments({ orgId })).toBe(0)
    expect((await Org.findById(orgId).lean() as any).logo).toBeFalsy()
  })

  it('removing the logo clears the row and unsets Org.logo, so PDFs fall back to the bundle', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    await saveOrgLogo(orgId, png(600, 200), 'image/png')

    expect(await deleteOrgLogo(orgId)).toBe(true)
    expect(await getOrgLogoMeta(orgId)).toBeNull()
    expect(await getOrgLogoDataUri(orgId)).toBeNull()
    expect(await OrgLogo.countDocuments({ orgId })).toBe(0)
    expect((await Org.findById(orgId).lean() as any).logo).toBeUndefined()

    // Deleting again is a no-op, not an error.
    expect(await deleteOrgLogo(orgId)).toBe(false)
  })

  it('puts the uploaded logo into the printed invoice, replacing the bundled letterhead', async () => {
    const org = await createTestOrg({ name: 'Regal' } as any)
    const orgId = String(org._id)

    // What every PDF export path does: resolve the org's own logo, hand it to the generator.
    const withoutLogo = buildInvoiceHtml(
      invoiceFixture as any,
      { name: 'Regal', logo: (await getOrgLogoDataUri(orgId)) ?? undefined } as any,
      {} as any, undefined, { locale: 'bg' },
    ).html
    expect(withoutLogo).toContain(`src="${bundledLogoDataUri()}"`)

    await saveOrgLogo(orgId, png(600, 200, 7), 'image/png')
    const uploaded = (await getOrgLogoDataUri(orgId))!

    const withLogo = buildInvoiceHtml(
      invoiceFixture as any,
      { name: 'Regal', logo: uploaded } as any,
      {} as any, undefined, { locale: 'bg' },
    ).html

    expect(withLogo).toContain(`<img class="org-logo" src="${uploaded}"`)
    expect(withLogo).not.toContain(`src="${bundledLogoDataUri()}"`)
  })

  it('keeps each org on its own logo', async () => {
    const [a, b] = await Promise.all([createTestOrg(), createTestOrg()])
    await saveOrgLogo(String(a._id), png(600, 200, 1), 'image/png')
    await saveOrgLogo(String(b._id), png(300, 100, 2), 'image/png')

    const metaA = await getOrgLogoMeta(String(a._id))
    const metaB = await getOrgLogoMeta(String(b._id))
    expect(metaA!.width).toBe(600)
    expect(metaB!.width).toBe(300)
    expect(metaA!.hash).not.toBe(metaB!.hash)

    // An org that never uploaded one simply has none.
    const c = await createTestOrg()
    expect(await getOrgLogoMeta(String(c._id))).toBeNull()
  })
})
