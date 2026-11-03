/**
 * FR-25 §7.4: payroll's arithmetic, in whole cents, so that a half is a half. Import-pure.
 *
 * TODO(FR-25 §7.5, item 3): ПМС 175/2018's own text was not reached. Its predecessor's чл. 2а says: each
 * contribution is computed per insured person, separately, to two decimals; a third decimal of 0–4
 * leaves the second as it is, and 5–9 adds one. Half up, which is also what the filed files prove:
 * income × percentage, each share rounded separately, equals обр. 6 to the cent in all 42 months.
 *
 * ⚠ Never on doubles. `Math.round(x * 100) / 100` rounds some .xx5 values down, because the product
 * lands just under the tie. Cents × hundredths of a percent is an exact whole number, and at this
 * scale it stays well inside 2^53.
 */
export const toCents = (amount: number): number => Math.round(amount * 100)
export const fromCents = (cents: number): number => cents / 100

/** `cents × numerator / denominator`, half up on the magnitude, the sign restored after. */
export function shareOf(cents: number, numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error('a share of nothing')
  const magnitude = Math.floor((2 * Math.abs(cents) * numerator + denominator) / (2 * denominator))
  return cents < 0 ? -magnitude : magnitude
}

/** `cents × rate%`, half up. A rate has at most two decimals, so hundredths make it a whole number. */
export function percentOf(cents: number, rate: number): number {
  return shareOf(cents, Math.round(rate * 100), 10_000)
}

const EUR_FIXED_NUMERATOR = 195_583
const EUR_FIXED_DENOMINATOR = 100_000

/** BGN cents as thousandths of a euro, cut at the third decimal. */
const thousandthsOfEur = (bgnCents: number) => Math.floor((bgnCents * 10 * EUR_FIXED_DENOMINATOR) / EUR_FIXED_NUMERATOR)

/** The general rule of the Euro Act (чл. 12–13): full rate, two decimals, half up. */
export function bgnToEur(bgn: number): number {
  const scaled = toCents(bgn) * EUR_FIXED_DENOMINATOR
  return fromCents(Math.floor((2 * scaled + EUR_FIXED_NUMERATOR) / (2 * EUR_FIXED_NUMERATOR)))
}

/**
 * Wages, benefits and pensions round UP on any non-zero third decimal, per pay element (ЗВЕРБ чл. 45):
 * 1,000 лв. is €511.30, not €511.29. Deductions and statutory thresholds take the general rule.
 */
export function bgnWageToEur(bgn: number): number {
  const thousandths = thousandthsOfEur(toCents(bgn))
  return fromCents(Math.ceil(thousandths / 10))
}
