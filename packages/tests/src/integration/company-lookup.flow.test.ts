import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { lookupCompany, lookupBulgaria, lookupEU } from 'services/biz/company-lookup.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

describe('Company Lookup Service', () => {
  it('should lookup Bulgarian company by EIK from eik.bg', async () => {
    const result = await lookupBulgaria('205174895')
    expect(result.isValid).toBe(true)
    expect(result.taxNumber).toBe('205174895')
    expect(result.companyName).toBeTruthy()
    expect(result.vatNumber).toContain('BG')
  })

  it('should lookup EU company by VAT from verifyvat.com (AT)', async () => {
    const result = await lookupEU('ATU66280133')
    expect(result.isValid).toBe(true)
    expect(result.vatNumber).toContain('ATU66280133')
    expect(result.companyName).toBeTruthy()
  })

  it('should lookup Bulgarian VAT number via EU adapter', async () => {
    const result = await lookupEU('BG205174895')
    expect(result.isValid).toBe(true)
    expect(result.vatNumber).toContain('BG205174895')
  })

  it('should auto-detect country from VAT prefix via lookupCompany', async () => {
    // BG prefix -> Bulgaria adapter first
    const bgResult = await lookupCompany('BG205174895')
    expect(bgResult.isValid).toBe(true)
    expect(bgResult.taxNumber).toBeTruthy()

    // AT prefix -> EU adapter
    const atResult = await lookupCompany('ATU66280133')
    expect(atResult.isValid).toBe(true)
    expect(atResult.companyName).toBeTruthy()
  })

  it('should lookup pure EIK number (no prefix) as Bulgarian', async () => {
    const result = await lookupCompany('205174895')
    expect(result.isValid).toBe(true)
    expect(result.taxNumber).toBe('205174895')
  })

  it('should return isValid=false for invalid VAT', async () => {
    const result = await lookupCompany('XX000000000')
    expect(result.isValid).toBe(false)
  })
})
