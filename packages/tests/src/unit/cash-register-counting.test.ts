import { describe, it, expect } from 'bun:test'
import { keptByMethod, posRowSign } from 'services/biz/cash-register/counting'

/**
 * FR-21.1 — the one counting rule every cash-register reader shares, and the money a row left in
 * the drawer. Import-pure, so it is pinned here without a database.
 */

describe('posRowSign — a sale counts whether or not it was stornoed; a storno counts negative; nothing voided counts', () => {
  it('a sale counts in either status: it is `cancelled` only by its storno', () => {
    expect(posRowSign({ type: 'sale', status: 'completed' })).toBe(1)
    expect(posRowSign({ type: 'sale', status: 'cancelled' })).toBe(1)
  })

  it('a storno counts negative, unless its receipt failed (cancelled: it reversed nothing)', () => {
    expect(posRowSign({ type: 'storno', status: 'completed' })).toBe(-1)
    expect(posRowSign({ type: 'storno', status: 'cancelled' })).toBe(0)
  })

  it('the legacy return and exchange keep their sign, while completed', () => {
    expect(posRowSign({ type: 'return', status: 'completed' })).toBe(-1)
    expect(posRowSign({ type: 'return', status: 'cancelled' })).toBe(0)
    expect(posRowSign({ type: 'exchange', status: 'completed' })).toBe(1)
    expect(posRowSign({ type: 'exchange', status: 'cancelled' })).toBe(0)
  })

  it('an unknown type does not count', () => {
    expect(posRowSign({ type: 'whatever', status: 'completed' })).toBe(0)
    expect(posRowSign({})).toBe(0)
  })
})

describe('keptByMethod — card and other as paid, cash the rest of the total', () => {
  it('a cash sale with change keeps the total, not the amount tendered', () => {
    expect(keptByMethod({ total: 37.2, payments: [{ method: 'cash', amount: 50 }] })).toEqual({ cash: 37.2, card: 0, other: 0 })
  })

  it('split tender: the card part as paid, the cash part net of change', () => {
    expect(keptByMethod({ total: 120, payments: [{ method: 'card', amount: 70 }, { method: 'cash', amount: 60 }] }))
      .toEqual({ cash: 50, card: 70, other: 0 })
  })

  it('mobile and voucher are other', () => {
    expect(keptByMethod({ total: 30, payments: [{ method: 'mobile', amount: 20 }, { method: 'voucher', amount: 10 }] }))
      .toEqual({ cash: 0, card: 0, other: 30 })
  })

  it('the three always add up to the total, even when a card part exceeds it', () => {
    const k = keptByMethod({ total: 40, payments: [{ method: 'card', amount: 45 }] })
    expect(k).toEqual({ cash: 0, card: 40, other: 0 })
    expect(k.cash + k.card + k.other).toBe(40)
  })

  it('no payments: the whole total is cash', () => {
    expect(keptByMethod({ total: 12.5 })).toEqual({ cash: 12.5, card: 0, other: 0 })
  })
})
