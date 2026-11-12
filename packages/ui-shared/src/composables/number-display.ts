/**
 * How a number is SHOWN (owner, 2026-11-12): with a point as the decimal separator, whatever the interface language.
 * A number is TYPED with a point or a comma (`price-precision.ts#parseTyped`), and `Intl` alone would print it back with
 * the comma bg, de and mk use, so the person reads „12,5" where they typed „12.5".
 *
 * The locale keeps everything else: its currency symbol, its sign and where it puts them. A locale that groups thousands
 * with a point (de, mk) groups them with a no-break space instead, so „1.234" never reads as one point two three four.
 *
 * Import-pure: no Vue. `unit/number-display.test.ts` holds the rules.
 */

const NBSP = ' '

/** `format.format(value)`, with a point for the decimal separator and no point between thousands. */
export function withDecimalPoint(format: Intl.NumberFormat, value: number | bigint): string {
  return format
    .formatToParts(value)
    .map(part => (part.type === 'decimal' ? '.' : part.type === 'group' && part.value === '.' ? NBSP : part.value))
    .join('')
}

/**
 * `new Intl.NumberFormat(locale, options)` whose `format` shows a point as the decimal separator: the one change a call
 * site makes is the constructor's name.
 */
export function numberFormat(locale?: string | string[], options?: Intl.NumberFormatOptions): { format(value: number | bigint): string } {
  const format = new Intl.NumberFormat(locale, options)
  return { format: (value: number | bigint) => withDecimalPoint(format, value) }
}
