import type { IOrg } from 'db/models'
import { markdownToPdf, buildHeader } from './base.pdf.js'

export interface ProfitLossData {
  revenue: { name: string; amount: number }[]
  costOfGoodsSold: { name: string; amount: number }[]
  operatingExpenses: { name: string; amount: number }[]
  otherIncome: { name: string; amount: number }[]
  otherExpenses: { name: string; amount: number }[]
}

export interface BalanceSheetData {
  currentAssets: { name: string; amount: number }[]
  fixedAssets: { name: string; amount: number }[]
  otherAssets: { name: string; amount: number }[]
  currentLiabilities: { name: string; amount: number }[]
  longTermLiabilities: { name: string; amount: number }[]
  equity: { name: string; amount: number }[]
}

function sumItems(items: { name: string; amount: number }[]): number {
  return items.reduce((acc, item) => acc + item.amount, 0)
}

function renderSection(items: { name: string; amount: number }[], indent = ''): string {
  let md = ''
  for (const item of items) {
    md += `| ${indent}${item.name} | ${item.amount.toFixed(2)} |\n`
  }
  return md
}

export async function generateProfitLossStatementPDF(
  data: ProfitLossData,
  org: IOrg,
  period: string,
): Promise<Buffer | undefined> {
  let md = buildHeader('Profit & Loss Statement', org.name, period)

  const totalRevenue = sumItems(data.revenue)
  const totalCOGS = sumItems(data.costOfGoodsSold)
  const grossProfit = totalRevenue - totalCOGS
  const totalOpEx = sumItems(data.operatingExpenses)
  const operatingIncome = grossProfit - totalOpEx
  const totalOtherIncome = sumItems(data.otherIncome)
  const totalOtherExpenses = sumItems(data.otherExpenses)
  const netIncome = operatingIncome + totalOtherIncome - totalOtherExpenses

  md += `| Account | Amount (${org.settings.baseCurrency}) |\n`
  md += `|---------|-------:|\n`

  // Revenue
  md += `| **Revenue** | |\n`
  md += renderSection(data.revenue, '  ')
  md += `| **Total Revenue** | **${totalRevenue.toFixed(2)}** |\n`
  md += `| | |\n`

  // COGS
  md += `| **Cost of Goods Sold** | |\n`
  md += renderSection(data.costOfGoodsSold, '  ')
  md += `| **Total COGS** | **${totalCOGS.toFixed(2)}** |\n`
  md += `| | |\n`

  // Gross Profit
  md += `| **Gross Profit** | **${grossProfit.toFixed(2)}** |\n`
  md += `| | |\n`

  // Operating Expenses
  md += `| **Operating Expenses** | |\n`
  md += renderSection(data.operatingExpenses, '  ')
  md += `| **Total Operating Expenses** | **${totalOpEx.toFixed(2)}** |\n`
  md += `| | |\n`

  // Operating Income
  md += `| **Operating Income** | **${operatingIncome.toFixed(2)}** |\n`
  md += `| | |\n`

  // Other Income / Expenses
  if (data.otherIncome.length > 0) {
    md += `| **Other Income** | |\n`
    md += renderSection(data.otherIncome, '  ')
    md += `| **Total Other Income** | **${totalOtherIncome.toFixed(2)}** |\n`
  }

  if (data.otherExpenses.length > 0) {
    md += `| **Other Expenses** | |\n`
    md += renderSection(data.otherExpenses, '  ')
    md += `| **Total Other Expenses** | **${totalOtherExpenses.toFixed(2)}** |\n`
  }

  md += `| | |\n`
  md += `| **Net Income** | **${netIncome.toFixed(2)}** |\n`

  return markdownToPdf(md)
}

export async function generateBalanceSheetPDF(
  data: BalanceSheetData,
  org: IOrg,
  asOfDate: string,
): Promise<Buffer | undefined> {
  let md = buildHeader('Balance Sheet', org.name)
  md += `**As of:** ${asOfDate}\n\n---\n\n`

  const totalCurrentAssets = sumItems(data.currentAssets)
  const totalFixedAssets = sumItems(data.fixedAssets)
  const totalOtherAssets = sumItems(data.otherAssets)
  const totalAssets = totalCurrentAssets + totalFixedAssets + totalOtherAssets

  const totalCurrentLiabilities = sumItems(data.currentLiabilities)
  const totalLongTermLiabilities = sumItems(data.longTermLiabilities)
  const totalLiabilities = totalCurrentLiabilities + totalLongTermLiabilities

  const totalEquity = sumItems(data.equity)
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity

  md += `| Account | Amount (${org.settings.baseCurrency}) |\n`
  md += `|---------|-------:|\n`

  // Assets
  md += `| **ASSETS** | |\n`
  md += `| | |\n`

  md += `| **Current Assets** | |\n`
  md += renderSection(data.currentAssets, '  ')
  md += `| **Total Current Assets** | **${totalCurrentAssets.toFixed(2)}** |\n`
  md += `| | |\n`

  md += `| **Fixed Assets** | |\n`
  md += renderSection(data.fixedAssets, '  ')
  md += `| **Total Fixed Assets** | **${totalFixedAssets.toFixed(2)}** |\n`
  md += `| | |\n`

  if (data.otherAssets.length > 0) {
    md += `| **Other Assets** | |\n`
    md += renderSection(data.otherAssets, '  ')
    md += `| **Total Other Assets** | **${totalOtherAssets.toFixed(2)}** |\n`
    md += `| | |\n`
  }

  md += `| **TOTAL ASSETS** | **${totalAssets.toFixed(2)}** |\n`
  md += `| | |\n`

  // Liabilities
  md += `| **LIABILITIES** | |\n`
  md += `| | |\n`

  md += `| **Current Liabilities** | |\n`
  md += renderSection(data.currentLiabilities, '  ')
  md += `| **Total Current Liabilities** | **${totalCurrentLiabilities.toFixed(2)}** |\n`
  md += `| | |\n`

  if (data.longTermLiabilities.length > 0) {
    md += `| **Long-Term Liabilities** | |\n`
    md += renderSection(data.longTermLiabilities, '  ')
    md += `| **Total Long-Term Liabilities** | **${totalLongTermLiabilities.toFixed(2)}** |\n`
    md += `| | |\n`
  }

  md += `| **TOTAL LIABILITIES** | **${totalLiabilities.toFixed(2)}** |\n`
  md += `| | |\n`

  // Equity
  md += `| **EQUITY** | |\n`
  md += renderSection(data.equity, '  ')
  md += `| **TOTAL EQUITY** | **${totalEquity.toFixed(2)}** |\n`
  md += `| | |\n`

  md += `| **TOTAL LIABILITIES & EQUITY** | **${totalLiabilitiesAndEquity.toFixed(2)}** |\n`

  return markdownToPdf(md)
}
