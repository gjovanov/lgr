/**
 * Deterministic validation of an extracted invoice (TS port of Starling
 * extraction/validate.py). Flags arithmetic / checksum problems so the drafting
 * step can mark bills `needs_review` instead of posting silently-wrong data.
 */
import type { InvoiceExtraction, ValidationCheck, ValidationResult } from './schema.js'

const AMOUNT_TOL = 0.011 // rounding tolerance for money comparisons
const BG_VAT_RATES = new Set([0, 9, 20])

function approx(a: number, b: number, tol = AMOUNT_TOL): boolean {
  return Math.abs(a - b) <= tol
}

/** Bulgarian ЕИК/БУЛСТАТ checksum (9- or 13-digit). */
export function isValidEik(raw?: string | null): boolean {
  if (!raw) return false
  const eik = raw.replace(/\D/g, '')
  if (eik.length !== 9 && eik.length !== 13) return false
  const d = eik.split('').map(Number)

  const check9 = (): number => {
    let sum = 0
    for (let i = 0; i < 8; i++) sum += d[i] * (i + 1) // weights 1..8
    let r = sum % 11
    if (r === 10) {
      sum = 0
      for (let i = 0; i < 8; i++) sum += d[i] * (i + 3) // weights 3..10
      r = sum % 11
      if (r === 10) r = 0
    }
    return r
  }
  if (check9() !== d[8]) return false
  if (eik.length === 9) return true

  // 13-digit: validate the trailing check digit over digits 9..12
  const w1 = [2, 7, 3, 5]
  const w2 = [4, 9, 5, 7]
  let sum = 0
  for (let i = 0; i < 4; i++) sum += d[8 + i] * w1[i]
  let r = sum % 11
  if (r === 10) {
    sum = 0
    for (let i = 0; i < 4; i++) sum += d[8 + i] * w2[i]
    r = sum % 11
    if (r === 10) r = 0
  }
  return r === d[12]
}

/** ISO 13616 IBAN mod-97 checksum. */
export function isValidIban(raw?: string | null): boolean {
  if (!raw) return false
  const iban = raw.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch // A=10..Z=35
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

function isIsoDate(s?: string | null): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
}

export function validateExtraction(inv: InvoiceExtraction): ValidationResult {
  const checks: ValidationCheck[] = []
  const push = (check: string, status: ValidationCheck['status'], details: string) =>
    checks.push({ check, status, details })

  const isBg =
    (inv.currency || '').toUpperCase() === 'BGN' ||
    /^BG/i.test(inv.supplier?.vat_id || '') ||
    /^BG/i.test(inv.customer?.vat_id || '')

  // Per-line arithmetic
  let lineSum = 0
  inv.line_items.forEach((l, i) => {
    const n = i + 1
    if (l.quantity == null || l.unit_price == null || l.total == null) {
      push(`line_${n}_arithmetic`, 'skip', 'missing quantity/price/total')
      if (l.total != null) lineSum += l.total
      return
    }
    lineSum += l.total
    const expected = l.quantity * l.unit_price
    if (approx(expected, l.total)) push(`line_${n}_arithmetic`, 'pass', `${l.quantity} × ${l.unit_price} = ${l.total}`)
    else push(`line_${n}_arithmetic`, 'fail', `${l.quantity} × ${l.unit_price} = ${expected.toFixed(4)} ≠ ${l.total}`)
  })

  // Σ lines ≈ net
  if (inv.net_total != null) {
    if (approx(lineSum, inv.net_total, 0.05)) push('lines_sum_net', 'pass', `Σ ${lineSum.toFixed(2)} = net ${inv.net_total}`)
    else push('lines_sum_net', 'fail', `Σ lines ${lineSum.toFixed(2)} ≠ net ${inv.net_total}`)
  } else push('lines_sum_net', 'skip', 'no net_total')

  // net + vat ≈ gross
  if (inv.net_total != null && inv.vat_total != null && inv.gross_total != null) {
    if (approx(inv.net_total + inv.vat_total, inv.gross_total)) push('totals_net_vat_gross', 'pass', `${inv.net_total} + ${inv.vat_total} = ${inv.gross_total}`)
    else push('totals_net_vat_gross', 'fail', `${inv.net_total} + ${inv.vat_total} ≠ ${inv.gross_total}`)
  } else push('totals_net_vat_gross', 'skip', 'missing totals')

  // VAT rates plausible for BG
  const rates = inv.line_items.map(l => l.vat_rate).filter((r): r is number => r != null)
  if (isBg && rates.length) {
    const bad = rates.filter(r => !BG_VAT_RATES.has(r))
    if (bad.length) push('vat_rate_plausible', 'warn', `rates outside {0,9,20}: ${[...new Set(bad)].join(', ')}`)
    else push('vat_rate_plausible', 'pass', 'rates within BG set {0, 9, 20}')
  } else push('vat_rate_plausible', 'skip', 'not BG or no rates')

  // Identity checks
  const idCheck = (label: string, ok: boolean | null) =>
    ok === null ? push(label, 'skip', 'not present') : push(label, ok ? 'pass' : 'fail', ok ? 'valid' : 'invalid checksum')
  idCheck('supplier_eik', inv.supplier?.company_id ? isValidEik(inv.supplier.company_id) : null)
  idCheck('supplier_iban', inv.supplier?.iban ? isValidIban(inv.supplier.iban) : null)
  idCheck('customer_eik', inv.customer?.company_id ? isValidEik(inv.customer.company_id) : null)

  // Dates
  push('issue_date', isIsoDate(inv.issue_date) ? 'pass' : inv.issue_date ? 'fail' : 'skip', inv.issue_date || 'missing')

  const status: ValidationResult['status'] = checks.some(c => c.status === 'fail') ? 'needs_review' : 'valid'
  return { status, checks }
}
