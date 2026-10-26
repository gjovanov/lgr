import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseOutcome } from '../../../invoicing-ui/src/composables/reservation-form'
import {
  RESERVATION_ERROR_CODES, isShortage, reservationErrorMessage,
} from '../../../invoicing-ui/src/composables/reservation-errors'

/**
 * FR-22.37 — the rules behind the reservation dialogs: what a release leaves, and how a refusal
 * is said.
 */

const PACKAGES = join(import.meta.dir, '..', '..', '..')
const LOCALES = ['en', 'bg', 'de', 'mk'] as const
const catalogue = (l: string) => JSON.parse(readFileSync(join(PACKAGES, 'ui-shared', 'src', 'locales', `${l}.json`), 'utf8'))
const valueAt = (obj: any, key: string) => key.split('.').reduce((o, k) => o?.[k], obj)

describe('what releasing part of a reservation leaves', () => {
  it('everything of an untouched reservation cancels it', () => {
    expect(releaseOutcome({ quantity: 5 }, 5)).toMatchObject({ releasable: 5, consumed: 0, cancels: true, remaining: 0, valid: true })
  })

  it('part of it lowers it', () => {
    expect(releaseOutcome({ quantity: 5 }, 2)).toMatchObject({ cancels: false, remaining: 3, valid: true })
  })

  it('what is invoiced or dispatched stays, and only the rest can go', () => {
    const r = { quantity: 5, invoicedQuantity: 2, dispatchedQuantity: 1 }
    expect(releaseOutcome(r, 3)).toMatchObject({ releasable: 3, consumed: 2, cancels: false, remaining: 2, valid: true })
    expect(releaseOutcome(r, 4).valid).toBe(false)
  })

  it('nothing, or more than there is, is no release', () => {
    expect(releaseOutcome({ quantity: 5 }, 0).valid).toBe(false)
    expect(releaseOutcome({ quantity: 5 }, 6).valid).toBe(false)
    expect(releaseOutcome({ quantity: 3, invoicedQuantity: 3 }, 1)).toMatchObject({ releasable: 0, valid: false })
  })
})

describe('a refused reservation, in the user\'s language', () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`
  const refusal = (data: any) => ({ response: { data } })

  it('a known code is a sentence of the catalogue, with the figure it names', () => {
    expect(reservationErrorMessage(refusal({ message: 'Insufficient available stock (available: 3)', code: 'insufficient_stock', available: 3 }), t))
      .toBe('invoicing.reservations.errors.insufficient_stock{"message":"Insufficient available stock (available: 3)","code":"insufficient_stock","available":3}')
  })

  it('anything else is the API\'s message, or a generic failure', () => {
    expect(reservationErrorMessage(refusal({ message: 'Reservation not found' }), t)).toBe('Reservation not found')
    expect(reservationErrorMessage(refusal({ message: 'x', code: 'something_new' }), t)).toBe('x')
    expect(reservationErrorMessage(new Error('network'), t)).toBe('common.operationFailed')
  })

  it('a shortage is what another source or a smaller quantity could get past', () => {
    expect(isShortage(refusal({ code: 'insufficient_stock' }))).toBe(true)
    expect(isShortage(refusal({ code: 'allocation_full' }))).toBe(true)
    expect(isShortage(refusal({ code: 'line_demand_exceeded' }))).toBe(true)
    expect(isShortage(refusal({ code: 'contact_mismatch' }))).toBe(false)
    expect(isShortage(refusal({ message: 'Order allocation not found' }))).toBe(false)
  })

  it('knows every code the service sends, and each is said in all four languages', () => {
    const service = readFileSync(join(PACKAGES, 'services', 'src', 'biz', 'reservation-ops.service.ts'), 'utf8')
    const sent = [...new Set([...service.matchAll(/\{ code: '([a-z_]+)'/g)].map((m) => m[1]))].sort()
    expect(sent).toEqual([...RESERVATION_ERROR_CODES].sort())
    for (const locale of LOCALES) {
      const c = catalogue(locale)
      for (const code of RESERVATION_ERROR_CODES) {
        expect({ locale, code, ok: typeof valueAt(c, `invoicing.reservations.errors.${code}`) === 'string' }).toEqual({ locale, code, ok: true })
      }
    }
  })
})
