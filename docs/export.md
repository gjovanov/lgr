# Export & Reporting

## Overview

LGR generates Excel (.xlsx) and PDF files for financial reports, invoices, payslips, and operational data. All generators support locale-aware column headers (EN, DE, MK) and organization branding.

## Excel Generators

Built on **ExcelJS** with streaming workbook writer for memory efficiency.

| Generator | Module | Output | Description |
|-----------|--------|--------|-------------|
| `generateChartOfAccountsXLSX` | Accounting | Chart of accounts | Account code, name, type, sub-type, balance |
| `generateJournalEntriesXLSX` | Accounting | Journal entries | Entry headers with indented debit/credit lines |
| `generateTrialBalanceXLSX` | Accounting | Trial balance | Debit/credit columns by account with period name |
| `generateGeneralLedgerXLSX` | Accounting | General ledger | Running balance for a single account |
| `generateInvoiceListXLSX` | Invoicing | Invoice list | Batch invoice export with totals and status |
| `generateProductCatalogXLSX` | Warehouse | Product catalog | SKU, name, category, pricing, tax rate |

### Excel Formatting

All Excel files share these conventions:
- **Header row**: Blue background (`#1976d2`), white bold text, centered
- **Currency columns**: 2 decimal places via `formatCurrency()`
- **Date columns**: ISO format (`YYYY-MM-DD`)
- **Streaming**: Uses `createWorkbook()` for memory-efficient generation

### Spreadsheet Structure

```
Row 1: Title         "Chart of Accounts: Acme Corp"  (bold, size 14)
Row 2: Generated     "2026-02-08"
Row 3: (blank)
Row 4: Headers       Code | Name | Type | Sub-Type | Balance  (styled header)
Row 5: Data          1000 | Cash | asset | current_asset | 15000.00
Row 6: Data          ...
```

## PDF Generators

Built on **md-to-pdf** — generates markdown then converts to PDF with A4 format and 20mm margins.

| Generator | Module | Output | Description |
|-----------|--------|--------|-------------|
| `generateInvoicePDF` | Invoicing | Invoice | Full invoice layout with line items, addresses, totals |
| `generatePayslipPDF` | Payroll | Payslip | Employee pay statement with earnings/deductions |
| `generateProfitLossStatement` | Accounting | P&L | Revenue, COGS, operating expenses, net income |
| `generateBalanceSheet` | Accounting | Balance sheet | Assets, liabilities, equity sections |

### Invoice PDF Layout

```markdown
# Invoice INV-2026-001

**Status:** Sent | **Date:** 2026-01-15 | **Due:** 2026-02-14

## Bill To
Acme Customer LLC
123 Main Street, City, State 12345

## Line Items

| Description | Qty | Unit Price | Discount | Tax | Total |
|-------------|-----|-----------|----------|-----|-------|
| Widget A    | 10  | 50.00     | 0%       | 18% | 590.00 |
| Service B   | 5   | 100.00    | 10%      | 18% | 531.00 |

## Summary

| | |
|---|---|
| **Subtotal** | 1,000.00 |
| **Discount** | -50.00 |
| **Tax (18%)** | 171.00 |
| **Total** | **1,121.00** |
| **Amount Due** | **1,121.00** |
```

### Payslip PDF Layout

```markdown
# Payslip

**Employee:** John Doe (#EMP-001)
**Department:** Engineering | **Position:** Senior Developer
**Period:** 2026-01-01 - 2026-01-31

## Earnings

| Type | Description | Amount |
|------|-------------|--------|
| Base Salary | Monthly salary | 5,000.00 |
| Overtime | 10 hours @ 1.5x | 468.75 |

## Deductions

| Type | Description | Amount |
|------|-------------|--------|
| Social Security | 18% | 984.38 |
| Health Insurance | Fixed | 150.00 |

| | |
|---|---|
| **Gross Pay** | 5,468.75 |
| **Total Deductions** | 1,134.38 |
| **Net Pay** | **4,334.37** |
```

### Financial Statement PDF

The P&L and balance sheet generators accept structured data:

```typescript
// Profit & Loss
interface ProfitLossData {
  revenue: { name: string; amount: number }[]
  costOfGoodsSold: { name: string; amount: number }[]
  operatingExpenses: { name: string; amount: number }[]
  otherIncome: { name: string; amount: number }[]
  otherExpenses: { name: string; amount: number }[]
}

// Balance Sheet
interface BalanceSheetData {
  currentAssets: { name: string; amount: number }[]
  fixedAssets: { name: string; amount: number }[]
  otherAssets: { name: string; amount: number }[]
  currentLiabilities: { name: string; amount: number }[]
  longTermLiabilities: { name: string; amount: number }[]
  equity: { name: string; amount: number }[]
}
```

## Export API Endpoints

All exports are served through the export controller at `/api/org/:orgId/export/`:

| Endpoint | Format | Description |
|----------|--------|-------------|
| `GET /export/accounting/chart-of-accounts` | Excel | Full chart of accounts |
| `GET /export/accounting/journal-entries` | Excel | Journal entries with lines |
| `GET /export/accounting/trial-balance` | Excel | Trial balance report |
| `GET /export/accounting/general-ledger` | Excel | Single account ledger |
| `GET /export/invoicing/invoice-list` | Excel | Batch invoice export |
| `GET /export/invoicing/invoice/:id` | PDF | Single invoice PDF |
| `GET /export/payroll/payslip/:id` | PDF | Single payslip PDF |
| `GET /export/accounting/profit-loss` | PDF | P&L statement |
| `GET /export/accounting/balance-sheet` | PDF | Balance sheet |
| `GET /export/warehouse/product-catalog` | Excel | Product catalog |

## Localization

Column headers are locale-aware. The export system reads the user's locale from the JWT payload or query parameter.

| Key | English | German | Macedonian |
|-----|---------|--------|-----------|
| date | Date | Datum | Датум |
| description | Description | Beschreibung | Опис |
| amount | Amount | Betrag | Износ |
| total | Total | Gesamt | Вкупно |
| balance | Balance | Saldo | Салдо |

See [API Reference](api.md) for endpoint details and [Architecture](architecture.md) for the reporting layer.
