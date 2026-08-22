import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { lookupCompany, lookupBulgaria, lookupEU } from 'services/biz/company-lookup.service'

// verifyvat.com burst limit: 2 requests per 10 seconds
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

/**
 * These hit eik.bg live, and as of 2026-08 that site serves a data-less placeholder page
 * ("Информацията за ЕИК … се обновява") for the EIKs below — so nothing can assert a real
 * company name or address today.
 *
 * What IS worth asserting, and what these tests now cover, is the adapter's contract when
 * the registry has nothing: it must report `isValid: false` rather than manufacture an
 * answer. It used to read the page <title> — literally "ЕИК 112500982 | EIK.bg" — and hand
 * back "ЕИК 112500982" as the company name, which callers then wrote into contact records
 * as though it were a real firm.
 */
describe('Company Lookup Service — Bulgaria (eik.bg)', () => {
  /** Shape check that holds whether or not the registry is currently serving data. */
  function expectHonestResult(result: Awaited<ReturnType<typeof lookupBulgaria>>, eik: string) {
    // Never a name derived from the number we asked about.
    expect(result.companyName || '').not.toMatch(new RegExp(`^ЕИК\\s*${eik}$`, 'i'))
    if (!result.isValid) {
      // No data must read as no data — not an empty-but-valid record.
      expect(result.companyName).toBeFalsy()
      return
    }
    expect(result.taxNumber).toBe(eik)
    expect(result.vatNumber).toContain('BG')
    expect(result.companyName).toBeTruthy()
    if (result.address) expect(result.address.country).toBe('BG')
  }

  it('never invents a company name when the registry has no data', async () => {
    expectHonestResult(await lookupBulgaria('205174895'), '205174895')
  })

  it('never invents a company name for an EIK with a placeholder page', async () => {
    expectHonestResult(await lookupBulgaria('112500982'), '112500982')
  })

  it('routes a bare EIK to the Bulgarian adapter', async () => {
    const result = await lookupCompany('205174895')
    expectHonestResult(result, '205174895')
  })

  it('routes a BG-prefixed VAT number to the Bulgarian adapter', async () => {
    const result = await lookupCompany('BG112500982')
    expectHonestResult(result, '112500982')
  })

  it('rejects malformed input without calling out', async () => {
    for (const bad of ['', 'abc', '123', '12345678901234']) {
      const result = await lookupBulgaria(bad)
      expect(result.isValid).toBe(false)
      expect(result.companyName).toBeFalsy()
    }
  })
})

describe.skip('Company Lookup Service — EU (verifyvat.com) — skipped: external API rate-limited', () => {
  it('should lookup EU company by VAT (AT)', async () => {
    const result = await lookupEU('ATU66280133')
    expect(result.isValid).toBe(true)
    expect(result.vatNumber).toContain('ATU66280133')
    expect(result.companyName).toBeTruthy()
  })

  it('should return address for EU VAT lookup (AT)', async () => {
    await wait(6000)
    const result = await lookupEU('ATU66280133')
    expect(result.isValid).toBe(true)
    expect(result.address).toBeDefined()
    expect(result.address!.country).toBeTruthy()
  })

  it('should lookup Bulgarian VAT number via EU adapter', async () => {
    await wait(6000)
    const result = await lookupEU('BG205174895')
    expect(result.isValid).toBe(true)
    expect(result.vatNumber).toContain('BG205174895')
  })

  it('should auto-detect country from VAT prefix via lookupCompany', async () => {
    await wait(6000)
    // BG prefix -> Bulgaria adapter first (eik.bg, no verifyvat)
    const bgResult = await lookupCompany('BG205174895')
    expect(bgResult.isValid).toBe(true)
    expect(bgResult.taxNumber).toBeTruthy()

    // AT prefix -> EU adapter (1 verifyvat call)
    const atResult = await lookupCompany('ATU66280133')
    expect(atResult.isValid).toBe(true)
    expect(atResult.companyName).toBeTruthy()
  })

  it('should lookup German VAT (partial coverage) and return country in address', async () => {
    await wait(6000)
    const result = await lookupEU('DE270518880')
    expect(result.isValid).toBe(true)
    expect(result.vatNumber).toBe('DE270518880')
    expect(result.taxNumber).toBe('270518880')
    // Germany has partial VIES coverage — may not return company name
    // But address should always have country from prefix
    expect(result.address).toBeDefined()
    expect(result.address!.country).toBe('DE')
  })

  it('should lookup DE270518880 via lookupCompany and return address with country', async () => {
    await wait(6000)
    const result = await lookupCompany('DE270518880')
    expect(result.isValid).toBe(true)
    expect(result.vatNumber).toBe('DE270518880')
    expect(result.address).toBeDefined()
    expect(result.address!.country).toBe('DE')
  })

  it('should return isValid=false for invalid VAT', async () => {
    const result = await lookupCompany('XX000000000')
    expect(result.isValid).toBe(false)
  })
})
