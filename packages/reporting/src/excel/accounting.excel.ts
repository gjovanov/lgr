import type { IAccount } from 'db/models'
import type { IJournalEntry } from 'db/models'
import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

export async function generateChartOfAccountsXLSX(accounts: IAccount[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Chart of Accounts')

  worksheet.columns = [
    { header: 'Code', key: 'code', width: 15 },
    { header: 'Name', key: 'name', width: 35 },
    { header: 'Type', key: 'type', width: 15 },
    { header: 'Sub-Type', key: 'subType', width: 20 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Balance', key: 'balance', width: 18 },
    { header: 'Active', key: 'isActive', width: 10 },
    { header: 'System', key: 'isSystem', width: 10 },
    { header: 'Description', key: 'description', width: 40 },
  ]

  styleHeaderRow(worksheet, 9)

  for (const account of accounts) {
    worksheet.addRow({
      code: account.code,
      name: account.name,
      type: account.type,
      subType: account.subType,
      currency: account.currency || '',
      balance: formatCurrency(account.balance),
      isActive: account.isActive ? 'Yes' : 'No',
      isSystem: account.isSystem ? 'Yes' : 'No',
      description: account.description || '',
    }).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateJournalEntriesXLSX(entries: IJournalEntry[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Journal Entries')

  worksheet.columns = [
    { header: 'Entry #', key: 'entryNumber', width: 15 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Reference', key: 'reference', width: 18 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Total Debit', key: 'totalDebit', width: 18 },
    { header: 'Total Credit', key: 'totalCredit', width: 18 },
  ]

  styleHeaderRow(worksheet, 8)

  for (const entry of entries) {
    worksheet.addRow({
      entryNumber: entry.entryNumber,
      date: formatDate(entry.date),
      description: entry.description,
      reference: entry.reference || '',
      type: entry.type,
      status: entry.status,
      totalDebit: formatCurrency(entry.totalDebit),
      totalCredit: formatCurrency(entry.totalCredit),
    }).commit()

    // Add line detail rows
    for (const line of entry.lines) {
      worksheet.addRow({
        entryNumber: '',
        date: '',
        description: `  ${line.description || ''}`,
        reference: '',
        type: '',
        status: '',
        totalDebit: line.debit > 0 ? formatCurrency(line.debit) : '',
        totalCredit: line.credit > 0 ? formatCurrency(line.credit) : '',
      }).commit()
    }
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateTrialBalanceXLSX(accounts: IAccount[], periodName: string): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Trial Balance')

  // Add period header
  worksheet.addRow([`Trial Balance - ${periodName}`]).commit()
  worksheet.addRow([]).commit()

  worksheet.columns = [
    { header: 'Code', key: 'code', width: 15 },
    { header: 'Account Name', key: 'name', width: 35 },
    { header: 'Type', key: 'type', width: 15 },
    { header: 'Debit', key: 'debit', width: 18 },
    { header: 'Credit', key: 'credit', width: 18 },
  ]

  // Style row 3 as header (after the title rows)
  const headerRow = worksheet.getRow(3)
  headerRow.values = ['Code', 'Account Name', 'Type', 'Debit', 'Credit']
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow.commit()

  let totalDebit = 0
  let totalCredit = 0

  for (const account of accounts) {
    const debit = account.balance > 0 ? account.balance : 0
    const credit = account.balance < 0 ? Math.abs(account.balance) : 0
    totalDebit += debit
    totalCredit += credit

    worksheet.addRow({
      code: account.code,
      name: account.name,
      type: account.type,
      debit: debit > 0 ? formatCurrency(debit) : '',
      credit: credit > 0 ? formatCurrency(credit) : '',
    }).commit()
  }

  // Totals row
  const totalsRow = worksheet.addRow({
    code: '',
    name: 'TOTALS',
    type: '',
    debit: formatCurrency(totalDebit),
    credit: formatCurrency(totalCredit),
  })
  totalsRow.font = { bold: true }
  totalsRow.commit()

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateGeneralLedgerXLSX(entries: IJournalEntry[], accountName: string): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('General Ledger')

  // Title
  worksheet.addRow([`General Ledger - ${accountName}`]).commit()
  worksheet.addRow([]).commit()

  worksheet.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Entry #', key: 'entryNumber', width: 15 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Reference', key: 'reference', width: 18 },
    { header: 'Debit', key: 'debit', width: 18 },
    { header: 'Credit', key: 'credit', width: 18 },
    { header: 'Running Balance', key: 'balance', width: 18 },
  ]

  const headerRow = worksheet.getRow(3)
  headerRow.values = ['Date', 'Entry #', 'Description', 'Reference', 'Debit', 'Credit', 'Running Balance']
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow.commit()

  let runningBalance = 0

  for (const entry of entries) {
    for (const line of entry.lines) {
      runningBalance += line.debit - line.credit

      worksheet.addRow({
        date: formatDate(entry.date),
        entryNumber: entry.entryNumber,
        description: line.description || entry.description,
        reference: entry.reference || '',
        debit: line.debit > 0 ? formatCurrency(line.debit) : '',
        credit: line.credit > 0 ? formatCurrency(line.credit) : '',
        balance: formatCurrency(runningBalance),
      }).commit()
    }
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
