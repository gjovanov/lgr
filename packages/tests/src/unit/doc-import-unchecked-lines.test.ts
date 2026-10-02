/**
 * Lines that print NEITHER a price NOR a value.
 *
 * regal-sf's стокова разписка uses the wide 12-price-column layout throughout, and on 2026-10-01
 * eight of its thirty receipts were refused over lines of exactly two shapes — while every one of
 * those documents summed to its own printed footer to the cent:
 *
 *   · a PRICE RESTATEMENT — no quantity either, so the line delivers nothing (2222036030 line 1);
 *   · a QUANTITY with no money against it — an internal correction booked „Доставчик: склад",
 *     i.e. from ourselves (2222036043, all 26 lines, signed, against a zero footer).
 *
 * Accepting them cannot hide a value the document DID print: dropping one would leave the lines
 * short of the footer, and the footer check is what decides whether the table is accepted at all.
 * What it cannot check is the QUANTITY, which is why those lines are reported rather than passed
 * off as verified.
 */
import { describe, it, expect } from 'bun:test'
import { parseTable, draftFromLayoutText } from 'services/biz/doc-import/parse-table'

const HEAD = "   No                      Име                        Мяр      Кол            Цена     Стойност"
const FOOT = (v: string) => ["", `                                                      Данъчна основа                  ${v} €`]
const row = (n: number, name: string, qty = '', price = '', val = '') =>
  `${String(n).padEnd(3)}        ${name.padEnd(34)}        БР      ${qty.padStart(7)}      ${price.padStart(10)}  ${val.padStart(11)}`

describe('a price restatement beside delivering lines', () => {
  const t = parseTable([HEAD, row(1, 'ГАЙКА М8', '', '0.4500', ''), row(2, 'БОЛТ М6', '10', '1.2000', '12.00'), ...FOOT('12.00')].join('\n'))

  it('is read instead of refusing the whole document', () => {
    expect(t.ok).toBe(true)
    expect(t.reason).toBeUndefined()
    expect(t.lines.length).toBe(2)
  })

  it('delivers nothing and is marked unchecked', () => {
    const [restate, delivered] = t.lines
    expect(restate.quantity).toBeNull()
    expect(restate.total).toBeNull()
    expect(restate.prices['Цена']).toBe(0.45)
    expect(restate.unchecked).toBe(true)
    expect(delivered.quantity).toBe(10)
    expect(delivered.unchecked).toBeFalsy()
  })

  it('does not warn — there is no quantity to take on trust', () => {
    const d = draftFromLayoutText([HEAD, row(1, 'ГАЙКА М8', '', '0.4500', ''), row(2, 'БОЛТ М6', '10', '1.2000', '12.00'), ...FOOT('12.00')].join('\n'), 'goods_receipt')
    expect(d).not.toBeNull()
    expect(d!.validation.checks.some(c => c.check === 'unchecked_quantities')).toBe(false)
  })
})

describe('a quantity with no money against it', () => {
  const text = [HEAD, row(1, 'ВИНТ 5.5Х50 - РАП.', '1620'), row(2, 'ВИНТ 2.9Х13 РАП.', '-1502'), row(3, 'БОЛТ М6', '10', '1.2000', '12.00'), ...FOOT('12.00')].join('\n')
  const t = parseTable(text)

  it('is read, keeping the sign the document prints', () => {
    expect(t.ok).toBe(true)
    expect(t.lines.map(l => l.quantity)).toEqual([1620, -1502, 10])
  })

  it('is reported as taken on trust, naming the lines', () => {
    const d = draftFromLayoutText(text, 'goods_receipt')
    expect(d).not.toBeNull()
    const c = d!.validation.checks.find(x => x.check === 'unchecked_quantities')
    expect(c).toBeTruthy()
    expect(c!.status).toBe('warn')
    expect(c!.details).toContain('2 line(s)')
    expect(c!.details).toContain('ВИНТ 5.5Х50 - РАП.')
    // And the arithmetic check stops claiming that EVERY line reconciled.
    expect(d!.validation.checks.find(x => x.check === 'line_arithmetic')!.details).toContain('1 of 3')
  })
})

describe('what this must NOT excuse', () => {
  it('still refuses a line that prints both a price and a value that disagree', () => {
    // 10 × 1.20 is 12.00, not 99.00 — the one thing the document can contradict, it does.
    const t = parseTable([HEAD, row(1, 'БОЛТ М6', '10', '1.2000', '99.00'), ...FOOT('99.00')].join('\n'))
    expect(t.ok).toBe(false)
    expect(t.reason).toContain('do not reconcile')
  })

  it('still refuses when a value goes missing, because the footer then falls short', () => {
    // The 12.00 line reads as price-only, so the lines sum to 0 against a printed 12.00. That is
    // exactly the protection that makes accepting a value-less line safe.
    const t = parseTable([HEAD, row(1, 'ГАЙКА М8', '', '0.4500', ''), row(2, 'БОЛТ М6', '', '1.2000', ''), ...FOOT('12.00')].join('\n'))
    expect(t.ok).toBe(false)
  })
})
