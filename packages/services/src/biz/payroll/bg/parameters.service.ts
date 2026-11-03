import { PayrollParameter } from 'db/models'
import { logger } from '../../../logger/logger.js'
import { parametersForPeriod, type BgParameters, type ParameterRow } from './parameters.js'
import { PAYROLL_PARAMETERS } from './parameters.data.js'

/**
 * FR-25 §3.10: the law's dated values in the database, where a new law can land without a release.
 * The repo's table is the floor: a row in the database wins for its key and date, and a server that
 * has not seeded yet still calculates. Global reference data, so a master never writes it.
 */
const CACHE_MS = 60_000
let cached: { rows: ParameterRow[]; at: number } | null = null

export function clearParameterCache(): void {
  cached = null
}

async function allRows(): Promise<ParameterRow[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rows
  const stored: any[] = await PayrollParameter.find({}).lean().exec()
  const byKey = new Map<string, ParameterRow>(PAYROLL_PARAMETERS.map(row => [`${row.key}|${row.effectiveFrom}`, row]))
  for (const row of stored) byKey.set(`${row.key}|${row.effectiveFrom}`, row as ParameterRow)
  cached = { rows: [...byKey.values()], at: Date.now() }
  return cached.rows
}

export async function loadParameters(period: string): Promise<BgParameters> {
  return parametersForPeriod(await allRows(), period)
}

/** Writes the repo's table. Safe on every start: a row is matched on its key and date. */
export async function seedPayrollParameters(): Promise<{ rows: number }> {
  await PayrollParameter.bulkWrite(PAYROLL_PARAMETERS.map(row => ({
    updateOne: {
      filter: { key: row.key, effectiveFrom: row.effectiveFrom },
      update: { $set: { value: row.value, currency: row.currency, source: row.source } },
      upsert: true,
    },
  })))
  clearParameterCache()
  logger.info({ rows: PAYROLL_PARAMETERS.length }, 'Payroll parameters seeded')
  return { rows: PAYROLL_PARAMETERS.length }
}
