import { describe, it, expect } from 'bun:test'
import { decodeCp1251, encodeCp1251 } from 'config/cp1251'
import { emitEmpl, EMPL_FIELD_COUNT, isEmplRow, parseEmpl, type EmplRow } from 'services/biz/payroll/bg/files/empl2021'
import { emitNra, NRA_FIELD_COUNT, parseNra, type NraRecord } from 'services/biz/payroll/bg/files/nra62007'
import { parseEtz, parseUtd62 } from 'services/biz/payroll/bg/files/contract-events'
import { foldContractEvents } from 'services/biz/payroll/bg/contract-fold'

/**
 * FR-25 §10: golden files for the formats, with made-up people. The ЕГН passes the checksum and its
 * month 13 means it can be nobody's. The employer's number is nines.
 */
const EMPLOYER = '999999999'
const DEVELOPER = '888888888'
const FAKE_EGN = '7513020014'

const row = (over: Partial<EmplRow> = {}): EmplRow => ({
  month: 9, year: 2026, employerId: EMPLOYER, personId: FAKE_EGN, personIdKind: 0, surname: 'ПРИМЕРОВА', initials: 'ИП', insuredType: 1,
  from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0, from4: 0, to4: 0, from5: 0, to5: 0,
  totalDays: '2088', workedDays: 20, sickDays: 0, childcareDays: 0, noContributionDays: 0, unpaidLeaveDays: 0, employerSickDays: 0,
  hoursWorked: 160, overtimeHours: 0, qualificationGroup: 5, kid: '4690', mainActivityRow: 58, summedTimeCode: '0000',
  zoBaseSick: 0, zoRateSick: 0, insurableIncome: 1000, dooRateEmployer: 10.92, dooRateEmployee: 8.38, zoRateEmployer: 4.8, zoRateEmployee: 3.2,
  tzpbRate: 0.5, uchpfRate: 0, ppfRate: 0, upfRateEmployer: 2.8, upfRateEmployee: 2.2, healthOnlyBase: 0, healthOnlyRate: 0,
  grossPay: 1000, gvrsRate: 0, taxableIncome: 1000, tax: 86.22, netPay: 775.98, kasaCode: 0, correctionCode: 0, developerId: DEVELOPER,
  ...over,
})

const GOLDEN_EMPL = `9,2026,"999999999","7513020014",0,"ПРИМЕРОВА","ИП",1,0,0,0,0,0,0,0,0,0,0,"2088",20,0,0,0,0,0,160,0,5,"4690",58,"0000",0.00,0.00,1000.00,10.92,8.38,4.80,3.20,0.50,0.00,0.00,2.80,2.20,0.00,0.00,1000.00,0.00,1000.00,86.22,775.98,0,0,"888888888"\r\n`

describe('обр. 1, EMPL2021.TXT', () => {
  it('emits the golden record, byte for byte, in CP1251', () => {
    expect(emitEmpl([row()], { developerId: DEVELOPER })).toEqual(encodeCp1251(GOLDEN_EMPL))
  })

  it('reads back what it wrote', () => {
    const parsed = parseEmpl(encodeCp1251(GOLDEN_EMPL))
    expect(parsed).toEqual([row()])
    expect(Object.keys(parsed[0])).toHaveLength(EMPL_FIELD_COUNT)
  })

  it('writes no Ctrl+Z unless asked, because the filed files have none', () => {
    const plain = emitEmpl([row()], { developerId: DEVELOPER })
    expect(plain[plain.length - 1]).toBe(0x0a)
    const asTheSpec = emitEmpl([row()], { developerId: DEVELOPER, eof: true })
    expect(asTheSpec[asTheSpec.length - 1]).toBe(0x1a)
    expect(parseEmpl(asTheSpec)).toEqual([row()])
  })

  it('writes the developer it is given, and never the one it read', () => {
    const text = decodeCp1251(emitEmpl([row()], { developerId: '777777777' }))
    expect(text).toContain('"777777777"')
    expect(text).not.toContain(DEVELOPER)
  })

  it('refuses to write without a developer', () => {
    expect(() => emitEmpl([row()], { developerId: '' })).toThrow('PAYROLL_DEVELOPER_EIK')
  })

  it('uppercases text, and refuses a comma that would shift every later field', () => {
    expect(decodeCp1251(emitEmpl([row({ surname: 'Примерова' })], { developerId: DEVELOPER }))).toContain('"ПРИМЕРОВА"')
    expect(() => emitEmpl([row({ surname: 'А,Б' })], { developerId: DEVELOPER })).toThrow('comma')
  })

  it('refuses a record that is not the format', () => {
    expect(() => parseEmpl(encodeCp1251('1,2,3\r\n'))).toThrow('fields')
    expect(() => parseEmpl(encodeCp1251(GOLDEN_EMPL.replace('"ПРИМЕРОВА"', 'ПРИМЕРОВА')))).toThrow('not quoted')
    expect(() => parseEmpl(encodeCp1251(GOLDEN_EMPL.replace('0.00,0.00,1000.00', 'x,0.00,1000.00')))).toThrow('not a number')
  })

  it('recognises a row that came over HTTP', () => {
    expect(isEmplRow(row())).toBe(true)
    expect(isEmplRow({ ...row(), extra: 1 })).toBe(false)
    expect(isEmplRow({ ...row(), tax: '86.22' })).toBe(false)
    expect(isEmplRow(null)).toBe(false)
  })
})

const record = (): NraRecord => ({
  employerId: EMPLOYER,
  employerName: 'ПРИМЕР',
  kasaMember: 0,
  email: 'A@EXAMPLE.COM',
  phone: '000000000',
  gsm: '',
  developerId: DEVELOPER,
  columns: [
    { month: '09', year: '2026', paymentDate: '25/10/2026', changeFlag: '0', paymentType: '5', doo: 1234.56, uchpf: null, dzpoUpf: 234.56, dzpoPpf: null, zo: 345.67, gvrs: null, tax: null, advanceTax: null },
    { month: '08', year: '2026', paymentDate: '25/10/2026', changeFlag: '0', paymentType: '8', doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: 456.78, advanceTax: null },
    { month: '', year: '', paymentDate: '', changeFlag: '', paymentType: '', doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: null, advanceTax: null },
    { month: '', year: '', paymentDate: '', changeFlag: '', paymentType: '', doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: null, advanceTax: null },
  ],
})

const GOLDEN_NRA = `"999999999","ПРИМЕР",0,"A@EXAMPLE.COM","000000000",,09,2026,25/10/2026,0,5,1234.56,,234.56,,345.67,,,,08,2026,25/10/2026,0,8,,,,,,,456.78,,,,,,,,,,,,,,,,,,,,,,,,,,,,"888888888"`

describe('обр. 6, NRA62007.TXT', () => {
  it('emits the golden record, byte for byte, with the spec\'s ending', () => {
    expect(emitNra(record(), { developerId: DEVELOPER })).toEqual(encodeCp1251(`${GOLDEN_NRA}\r\n\x1a`))
  })

  it('reads back what it wrote, and which ending the file had', () => {
    expect(parseNra(encodeCp1251(`${GOLDEN_NRA}\r\n\x1a`))).toEqual({ record: record(), ending: 'crlf-eof' })
    expect(parseNra(encodeCp1251(`${GOLDEN_NRA}\x1a`))).toEqual({ record: record(), ending: 'eof' })
  })

  it('reproduces both endings on disk', () => {
    const noBreak = encodeCp1251(`${GOLDEN_NRA}\x1a`)
    const { record: parsed, ending } = parseNra(noBreak)
    expect(emitNra(parsed, { developerId: DEVELOPER, ending })).toEqual(noBreak)
  })

  it('has 59 fields', () => {
    expect(NRA_FIELD_COUNT).toBe(59)
    expect(GOLDEN_NRA.split(',')).toHaveLength(59)
  })

  it('refuses to write without a developer, and a file with no Ctrl+Z', () => {
    expect(() => emitNra(record(), { developerId: '' })).toThrow('PAYROLL_DEVELOPER_EIK')
    expect(() => parseNra(encodeCp1251(GOLDEN_NRA))).toThrow('Ctrl+Z')
  })
})

const etzRow = (document: number, inner: string) => `<rowenum><employtype>01</employtype><codecorrection>0</codecorrection><documenttype>${document}</documenttype><egn>${FAKE_EGN}</egn><egntype>0</egntype><firstname>ИВА</firstname><secondname>ИВАНОВА</secondname><thirdname>ПРИМЕРОВА</thirdname><contractdate>2025-09-01</contractdate><contracttype>001</contracttype>${inner}</rowenum>`

const etzFile = (...rows: string[]) => encodeCp1251(`<?xml version="1.0" encoding="windows-1251"?><etzemploy><eik>${EMPLOYER}</eik><contract>${rows.join('')}</contract></etzemploy>`)

describe('the labour register', () => {
  it('reads an ЕТЗ: a contract, with pay and codes', () => {
    const [event] = parseEtz(etzFile(etzRow(1, '<begindate>2025-09-02</begindate><salary>1200.50</salary><codenkpd>52230000</codenkpd><codekid>4690</codekid><codeekatte>00000</codeekatte><codehours>1</codehours><workinghours>8</workinghours><vacationdays>20</vacationdays>')))
    expect(event).toMatchObject({
      source: 'etz', action: 'concluded', correction: 0, personId: FAKE_EGN, firstName: 'ИВА', middleName: 'ИВАНОВА', lastName: 'ПРИМЕРОВА',
      contractDate: '2025-09-01', startDate: '2025-09-02', salary: 1200.5, nkpd: '52230000', kid: '4690', workingHours: 8, leaveDays: 20,
    })
  })

  it('reads an ЕТЗ: a termination', () => {
    const [event] = parseEtz(etzFile(etzRow(3, '<usedvacation>4</usedvacation><enddate>2026-03-31</enddate><endreason>012</endreason><experience>000700</experience><noexperience>000000</noexperience>')))
    expect(event).toMatchObject({ action: 'terminated', endDate: '2026-03-31', endReason: '012', usedLeaveDays: 4, experience: '000700' })
  })

  it('refuses a document type it does not know', () => {
    expect(() => parseEtz(etzFile(etzRow(9, '')))).toThrow('unknown')
  })

  const utd = (action: number, rest: string) => `0,${action},"${EMPLOYER}","${FAKE_EGN}",0,"ИВА","ИВАНОВА","ПРИМЕРОВА",01,${rest},"${EMPLOYER}"\r\n\x1a`

  it('reads a чл. 62 notification: a contract', () => {
    const [event] = parseUtd62(encodeCp1251(utd(1, '02,01,2023,00,00,0000,1000.00,,,,"52230000","4690","00000",00,00,0000,""')))
    expect(event).toMatchObject({ source: 'utd62', action: 'concluded', contractDate: '2023-01-02', salary: 1000, kid: '4690' })
  })

  it('reads a чл. 62 notification: an annex and a termination', () => {
    const [annex] = parseUtd62(encodeCp1251(utd(2, '02,01,2023,01,04,2023,1200.00,,,,"52230000","4690","00000",00,00,0000,""')))
    expect(annex).toMatchObject({ action: 'amended', changeDate: '2023-04-01', effectiveFrom: '2023-04-01', salary: 1200 })
    const [end] = parseUtd62(encodeCp1251(utd(3, '02,01,2023,00,00,0000,,,,,"","","",31,12,2024,"12"')))
    expect(end).toMatchObject({ action: 'terminated', endDate: '2024-12-31', endReason: '12' })
  })
})

describe('events into contracts', () => {
  const concluded = parseEtz(etzFile(etzRow(1, '<begindate>2025-09-02</begindate><salary>1200.00</salary><codekid>4690</codekid>')))

  it('makes one contract, its salary from the day it starts', () => {
    const { contracts, gaps } = foldContractEvents(concluded, [], [FAKE_EGN])
    expect(gaps).toEqual([])
    expect(contracts).toHaveLength(1)
    expect(contracts[0]).toMatchObject({ date: '2025-09-01', startDate: '2025-09-02', kid: '4690', hoursPerDay: 8 })
  })

  it('adds the law\'s euro amendment to a salary in leva, whether or not a paper exists', () => {
    const [contract] = foldContractEvents(concluded, [], [FAKE_EGN]).contracts
    expect(contract.salaries).toEqual([
      { effectiveFrom: '2025-09-02', amount: 1200, currency: 'BGN' },
      { effectiveFrom: '2026-01-01', amount: 613.55, currency: 'EUR', byLaw: true },
    ])
    expect(contract.amendments).toEqual([{ date: '2026-01-01', effectiveFrom: '2026-01-01', byLaw: true }])
  })

  it('adds none for a contract that ended before the euro', () => {
    const end = parseEtz(etzFile(etzRow(3, '<enddate>2025-12-31</enddate><endreason>012</endreason>')))
    const [contract] = foldContractEvents([...concluded, ...end], [], [FAKE_EGN]).contracts
    expect(contract.salaries).toHaveLength(1)
    expect(contract.termination).toMatchObject({ date: '2025-12-31', basis: '012' })
  })

  it('applies an annex, and a deletion takes its event out', () => {
    const annex = parseUtd62(encodeCp1251(`0,2,"${EMPLOYER}","${FAKE_EGN}",0,"ИВА","ИВАНОВА","ПРИМЕРОВА",01,01,09,2025,01,11,2025,1300.00,,,,"","","",00,00,0000,"","${EMPLOYER}"\r\n`))
    const [amended] = foldContractEvents([...concluded, ...annex], [], [FAKE_EGN]).contracts
    expect(amended.salaries.map(s => s.amount)).toEqual([1200, 1300, 664.68])
    const deleted = foldContractEvents([...annex, { ...annex[0], correction: 2 }], [], [FAKE_EGN])
    expect(deleted.contracts).toEqual([])
  })

  it('lists what the files leave open, and guesses none of it', () => {
    expect(foldContractEvents([], [], [FAKE_EGN]).gaps).toEqual([{ personId: FAKE_EGN, gap: 'no_contract_event' }])
    const noPay = parseEtz(etzFile(etzRow(1, '<begindate>2025-09-02</begindate>')))
    expect(foldContractEvents(noPay, [], [FAKE_EGN]).gaps).toEqual([{ personId: FAKE_EGN, gap: 'no_salary' }])
    const orphan = parseEtz(etzFile(etzRow(3, '<enddate>2025-12-31</enddate>')))
    expect(foldContractEvents(orphan, [], [FAKE_EGN]).gaps).toContainEqual({ personId: FAKE_EGN, gap: 'termination_without_contract' })
  })

  it('takes a contract from the newest personnel export where the register holds none', () => {
    const { contracts, gaps } = foldContractEvents([], [
      { personId: FAKE_EGN, asOf: '2025-01-01', startDate: '2020-02-03', salary: 900, position: 'СТАРА' },
      { personId: FAKE_EGN, asOf: '2026-06-01', startDate: '2020-02-03', salary: 700, position: 'НОВА', hoursPerDay: 6, kid: '4690' },
    ], [FAKE_EGN])
    expect(gaps).toEqual([])
    expect(contracts[0]).toMatchObject({ date: '2020-02-03', position: 'НОВА', hoursPerDay: 6, kid: '4690' })
    expect(contracts[0].salaries).toEqual([{ effectiveFrom: '2020-02-03', amount: 700, currency: 'EUR' }])
  })
})
