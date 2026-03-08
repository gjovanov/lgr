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

describe('Company Lookup Service — Bulgaria (eik.bg)', () => {
  it('should lookup Bulgarian company by EIK from eik.bg', async () => {
    const result = await lookupBulgaria('205174895')
    expect(result.isValid).toBe(true)
    expect(result.taxNumber).toBe('205174895')
    expect(result.companyName).toBeTruthy()
    expect(result.vatNumber).toContain('BG')
  })

  it('should return address for Bulgarian EIK lookup', async () => {
    const result = await lookupBulgaria('112500982')
    expect(result.isValid).toBe(true)
    expect(result.companyName).toBeTruthy()
    expect(result.address).toBeDefined()
    expect(result.address!.country).toBe('BG')
    expect(result.address!.city).toBeTruthy()
  })

  it('should lookup pure EIK number (no prefix) as Bulgarian', async () => {
    const result = await lookupCompany('205174895')
    expect(result.isValid).toBe(true)
    expect(result.taxNumber).toBe('205174895')
  })

  it('should lookup BG112500982 and return address', async () => {
    const result = await lookupCompany('BG112500982')
    expect(result.isValid).toBe(true)
    expect(result.companyName).toBeTruthy()
    expect(result.address).toBeDefined()
    expect(result.address!.country).toBe('BG')
    expect(result.address!.city).toBeTruthy()
    expect(result.address!.street).toBeTruthy()
  })
})

describe('Company Lookup Service — EU (verifyvat.com)', () => {
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
