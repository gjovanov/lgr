import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ExcelJS from 'exceljs'
import { generateBackupKeyPair, sealBundle } from 'services/biz/backup/backup-crypto'
import { declarationKey, nameParts, readPersonnel, readSalarySheets, sheetKey, sheetLines } from '../../../../scripts/lib/payroll-exports'
import { declarationFiles, sealedRoot, versionsByMonth, type SealedRoot } from '../../../../scripts/lib/sealed-payroll'

/**
 * FR-25 §4, §5.1: the import's reading of the employer's sealed files, by the vendor's column names.
 * Made-up people. The files are sealed as the real ones are, and open in memory.
 */
const FAKE_EGN = '7513020014'
let dir = ''
let root: SealedRoot

const workbook = async (rows: unknown[][]) => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('a')
  for (const row of rows) sheet.addRow(row)
  return Buffer.from(await book.xlsx.writeBuffer())
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lgr-payroll-exports-'))
  const keys = generateBackupKeyPair()
  const identity = join(dir, 'identity.key')
  writeFileSync(identity, keys.privateKey)
  const put = (rel: string, bytes: Buffer) => {
    const path = join(dir, 'sealed', `${rel}.sealed`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, sealBundle(bytes, keys.publicKey))
  }
  put('nap/decl_1_6/202509/999999999/20251010_120000/EMPL2021.TXT', Buffer.from('a'))
  put('nap/decl_1_6/202509/999999999/20251020_120000/EMPL2021.TXT', Buffer.from('b'))
  put('nap/decl_1_6/202509/999999999/20251020_120000/NRA62007_999999999.txt', Buffer.from('c'))
  put('exports/payrollEmployee_20251015_101010.xlsx', await workbook([
    ['Служители'],
    ['ИМЕ', 'ЕГН/ЕНЧ', 'Вид. Здравно Осиг.', 'Постъпил', 'Напуснал', 'Вид. Осиг.', 'Осн. Заплата', 'Раб. време', 'Законоуст. раб. време', 'Раб. седмица', 'Клас', 'Осиг. Стаж', 'ТД КИД', 'ТД НКПД', 'Длъжност'],
    ['Ива Иванова Примерова', FAKE_EGN, '00', '01.02.2024', '', '01', 2000, 6, 8, 5, 1.5, '02-01-03', '4690', '52230000', 'Продавач'],
    ['Без номер', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ]))
  put('exports/payrollSalaries_20251010_101010.xlsx', await workbook([
    ['Заплати за месец: Сеп-2025'],
    ['No', 'Име', 'Отр. дни', 'Платен отпуск', 'Заплата', 'ДТВ за стаж', 'Пл.отп. чл.155,ал.1', 'Болн. сума раб-л', 'ФРЗ', 'Подпис', 'No'],
    [1, 'Ива Иванова Примерова', 15, 5, 1500, 30, 510, 0, 2040, '', 1],
    ['', 'Общо', 15, 5, 1500, 30, 510, 0, 2040, '', ''],
  ]))
  root = sealedRoot(join(dir, 'sealed'), identity)
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the sealed tree', () => {
  it('finds each month\'s versions, newest first, from the path alone', () => {
    const files = declarationFiles(root)
    expect(files).toHaveLength(3)
    const empl = versionsByMonth(files, 'empl').get('202509')!
    expect(empl.map(v => v.stamp)).toEqual(['20251020_120000', '20251010_120000'])
    expect(versionsByMonth(files, 'nra').get('202509')).toHaveLength(1)
  })

  it('opens a file in memory', () => {
    const [newest] = versionsByMonth(declarationFiles(root), 'empl').get('202509')!
    expect(root.open(newest.rel).toString()).toBe('b')
  })
})

describe('the personnel export', () => {
  it('reads by column name, and skips a row with no identifier', async () => {
    const rows = await readPersonnel(root)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      personId: FAKE_EGN, asOf: '2025-10-15', startDate: '2024-02-01', salary: 2000, hoursPerDay: 6, statutoryHours: 8, daysPerWeek: 5,
      classPercent: 1.5, experience: { years: 2, months: 1, days: 3 }, kid: '4690', nkpd: '52230000', position: 'Продавач', socialSecurityType: '01',
    })
  })

  it('splits a name into its parts', () => {
    expect(nameParts('Ива Иванова Примерова')).toEqual({ firstName: 'Ива', middleName: 'Иванова', lastName: 'Примерова' })
    expect(nameParts('Ива Примерова')).toEqual({ firstName: 'Ива', middleName: '', lastName: 'Примерова' })
  })
})

describe('the month\'s sheet', () => {
  it('finds its month in the title, and reads a person\'s amounts, not the total row', async () => {
    const [sheet] = await readSalarySheets(root)
    expect(sheet.period).toBe('202509')
    expect(sheet.rows).toHaveLength(1)
    expect(sheet.rows[0].values).toMatchObject({ 'Отр. дни': 15, Заплата: 1500, ФРЗ: 2040 })
  })

  it('joins обр. 1 by surname and initials, the only name that file carries', async () => {
    const [sheet] = await readSalarySheets(root)
    expect(sheetKey(sheet.rows[0])).toBe(declarationKey('202509', 'ПРИМЕРОВА', 'ИИ'))
  })

  it('reads a payslip\'s lines under our codes, an empty column being no line', async () => {
    const [sheet] = await readSalarySheets(root)
    expect(sheetLines(sheet.rows[0])).toEqual([
      { code: 'salary', amount: 1500, days: 15 },
      { code: 'classSupplement', amount: 30 },
      { code: 'paidLeave', amount: 510, days: 5 },
    ])
  })
})
