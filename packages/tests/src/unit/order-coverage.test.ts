import { describe, it, expect } from 'bun:test'
import { lineCoverage, orderCoverage } from 'config/order-coverage'

/**
 * FR-22.44 — a client order's coverage, the one rule the list, the form's header and its lines
 * read: a line covered only by what a supplier order not sent yet brings is „Поръчана" (`ordered`),
 * not „Резервирана" (`full`).
 */

describe('a client-order line\'s coverage', () => {
  it('nothing reserved, part of it, all of it', () => {
    expect(lineCoverage({ quantity: 10, reserved: 0 }).status).toBe('none')
    expect(lineCoverage({ quantity: 10, reserved: 4 })).toMatchObject({ status: 'partial', held: 4, short: 6 })
    expect(lineCoverage({ quantity: 10, reserved: 10 })).toMatchObject({ status: 'full', held: 10, short: 0 })
    expect(lineCoverage({ quantity: 10, reserved: 12 })).toMatchObject({ status: 'full', short: 0 })
  })

  it('covered only by a supplier order not sent yet: ordered', () => {
    expect(lineCoverage({ quantity: 10, reserved: 10, onUnsentOrder: 10 })).toMatchObject({ status: 'ordered', held: 0, onUnsentOrder: 10 })
  })

  it('part on the shelf, the rest on an unsent order: ordered, not reserved', () => {
    expect(lineCoverage({ quantity: 60, reserved: 60, onUnsentOrder: 10 })).toMatchObject({ status: 'ordered', held: 50 })
  })

  it('an unsent order that leaves it short is still partial', () => {
    expect(lineCoverage({ quantity: 10, reserved: 6, onUnsentOrder: 6 }).status).toBe('partial')
  })

  it('never counts more on the unsent order than is reserved at all', () => {
    expect(lineCoverage({ quantity: 5, reserved: 5, onUnsentOrder: 9 })).toMatchObject({ status: 'ordered', held: 0, onUnsentOrder: 5 })
  })
})

describe('a client order\'s coverage', () => {
  it('reads the lines together', () => {
    expect(orderCoverage([{ quantity: 5, reserved: 0 }, { quantity: 3, reserved: 0 }])).toEqual({ status: 'none', shortQuantity: 8 })
    expect(orderCoverage([{ quantity: 5, reserved: 5 }, { quantity: 3, reserved: 3 }])).toEqual({ status: 'full', shortQuantity: 0 })
    expect(orderCoverage([{ quantity: 5, reserved: 5 }, { quantity: 3, reserved: 3, onUnsentOrder: 3 }])).toEqual({ status: 'ordered', shortQuantity: 0 })
    expect(orderCoverage([{ quantity: 5, reserved: 5, onUnsentOrder: 5 }, { quantity: 3, reserved: 1 }])).toEqual({ status: 'partial', shortQuantity: 2 })
  })

  it('a line ordering nothing — the blank line a form keeps — counts for nothing', () => {
    expect(orderCoverage([{ quantity: 5, reserved: 5 }, { quantity: 0, reserved: 0 }]).status).toBe('full')
    expect(orderCoverage([{ quantity: 0, reserved: 0 }]).status).toBe('none')
    expect(orderCoverage([]).status).toBe('none')
  })
})
