import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { FiscalYear, FiscalPeriod } from 'db/models'
import { ensureFiscalPeriod } from 'services/biz/accounting.service'
import { createTestOrg, createTestAccount } from '../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('ensureFiscalPeriod', () => {
  it('should auto-create fiscal year + 12 periods for Jan-start org', async () => {
    const org = await createTestOrg({ slug: 'fp-auto-jan', settings: { fiscalYearStart: 1 } as any })
    const orgId = String(org._id)

    const periodId = await ensureFiscalPeriod(orgId, new Date('2026-02-15'))

    // Verify fiscal year was created
    const years = await FiscalYear.find({ orgId }).exec()
    expect(years).toHaveLength(1)
    expect(years[0].name).toBe('FY 2026')
    expect(years[0].startDate.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(years[0].endDate.toISOString().slice(0, 10)).toBe('2026-12-31')

    // Verify 12 periods were created
    const periods = await FiscalPeriod.find({ orgId }).sort({ number: 1 }).exec()
    expect(periods).toHaveLength(12)
    expect(periods[0].name).toBe('January')
    expect(periods[0].number).toBe(1)
    expect(periods[11].name).toBe('December')
    expect(periods[11].number).toBe(12)
    expect(periods.every(p => p.status === 'open')).toBe(true)

    // Verify returned period is February (number: 2)
    const matchingPeriod = periods.find(p => String(p._id) === periodId)
    expect(matchingPeriod).toBeDefined()
    expect(matchingPeriod!.name).toBe('February')
    expect(matchingPeriod!.number).toBe(2)
  })

  it('should auto-create fiscal year + 12 periods for non-Jan start (April)', async () => {
    const org = await createTestOrg({ slug: 'fp-auto-apr', settings: { fiscalYearStart: 4 } as any })
    const orgId = String(org._id)

    const periodId = await ensureFiscalPeriod(orgId, new Date('2026-02-15'))

    // FY should be 2025-04-01 to 2026-03-31
    const years = await FiscalYear.find({ orgId }).exec()
    expect(years).toHaveLength(1)
    expect(years[0].name).toBe('FY 2025/2026')
    expect(years[0].startDate.toISOString().slice(0, 10)).toBe('2025-04-01')
    expect(years[0].endDate.toISOString().slice(0, 10)).toBe('2026-03-31')

    // Verify 12 periods: first = April 2025, last = March 2026
    const periods = await FiscalPeriod.find({ orgId }).sort({ number: 1 }).exec()
    expect(periods).toHaveLength(12)
    expect(periods[0].name).toBe('April')
    expect(periods[0].startDate.toISOString().slice(0, 10)).toBe('2025-04-01')
    expect(periods[11].name).toBe('March')
    expect(periods[11].startDate.toISOString().slice(0, 10)).toBe('2026-03-01')

    // Returned period should be February 2026 (period number 11)
    const matchingPeriod = periods.find(p => String(p._id) === periodId)
    expect(matchingPeriod).toBeDefined()
    expect(matchingPeriod!.name).toBe('February')
    expect(matchingPeriod!.number).toBe(11)
  })

  it('should return existing period without creating duplicates', async () => {
    const org = await createTestOrg({ slug: 'fp-auto-idempotent', settings: { fiscalYearStart: 1 } as any })
    const orgId = String(org._id)

    const periodId1 = await ensureFiscalPeriod(orgId, new Date('2026-02-15'))
    const periodId2 = await ensureFiscalPeriod(orgId, new Date('2026-02-20'))

    // Should return same period ID
    expect(periodId1).toBe(periodId2)

    // Should still have only 1 fiscal year and 12 periods
    const years = await FiscalYear.find({ orgId }).exec()
    expect(years).toHaveLength(1)
    const periods = await FiscalPeriod.find({ orgId }).exec()
    expect(periods).toHaveLength(12)
  })

  it('should handle fiscal year boundary correctly', async () => {
    const org = await createTestOrg({ slug: 'fp-auto-boundary', settings: { fiscalYearStart: 4 } as any })
    const orgId = String(org._id)

    // Date 2026-04-01 → FY 2026-04-01 to 2027-03-31
    const periodIdApr = await ensureFiscalPeriod(orgId, new Date('2026-04-01'))
    const yearApr = await FiscalYear.findOne({ orgId, startDate: new Date('2026-04-01') }).exec()
    expect(yearApr).toBeDefined()
    expect(yearApr!.endDate.toISOString().slice(0, 10)).toBe('2027-03-31')

    // Date 2026-03-31 → FY 2025-04-01 to 2026-03-31
    const periodIdMar = await ensureFiscalPeriod(orgId, new Date('2026-03-31'))
    const yearMar = await FiscalYear.findOne({ orgId, startDate: new Date('2025-04-01') }).exec()
    expect(yearMar).toBeDefined()
    expect(yearMar!.endDate.toISOString().slice(0, 10)).toBe('2026-03-31')

    // These should be different fiscal years
    expect(String(yearApr!._id)).not.toBe(String(yearMar!._id))

    // Different period IDs
    expect(periodIdApr).not.toBe(periodIdMar)
  })

  it('should support journal entry creation that triggers auto-creation', async () => {
    const org = await createTestOrg({ slug: 'fp-auto-je', settings: { fiscalYearStart: 1 } as any })
    const orgId = String(org._id)

    // No fiscal years or periods exist yet
    let years = await FiscalYear.find({ orgId }).exec()
    expect(years).toHaveLength(0)

    // Ensure fiscal period (simulates what the controller does)
    const periodId = await ensureFiscalPeriod(orgId, new Date('2026-06-15'))

    expect(periodId).toBeDefined()
    expect(typeof periodId).toBe('string')

    // Now fiscal year and periods exist
    years = await FiscalYear.find({ orgId }).exec()
    expect(years).toHaveLength(1)

    const periods = await FiscalPeriod.find({ orgId }).exec()
    expect(periods).toHaveLength(12)

    // Returned period should be June
    const period = await FiscalPeriod.findById(periodId).exec()
    expect(period).toBeDefined()
    expect(period!.name).toBe('June')
  })
})
