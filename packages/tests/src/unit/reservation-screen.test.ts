import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseOutcome } from '../../../invoicing-ui/src/composables/reservation-form'
import {
  RESERVATION_ERROR_CODES, isShortage, reservationErrorMessage,
} from '../../../invoicing-ui/src/composables/reservation-errors'
import { CANCEL_REASONS, reservationHistory } from '../../../invoicing-ui/src/composables/reservation-history'

/**
 * FR-22.37 — the rules behind the reservation dialogs and page: what a release leaves, how a
 * refusal is said, and how the history reads.
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

describe('a reservation\'s history', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 26, 8, n)).toISOString()
  const keys = (h: ReturnType<typeof reservationHistory>) => h.map((e) => [e.key.replace('invoicing.reservations.history.', ''), e.params])

  it('reads every reason the server writes', () => {
    const h = reservationHistory([
      { status: 'active', changedAt: at(0), changedBy: 'u1', reason: 'created' },
      { status: 'active', fromStatus: 'active', changedAt: at(1), changedBy: 'u1', reason: 'updated: quantity 5 → 3, client' },
      { status: 'active', fromStatus: 'active', changedAt: at(2), changedBy: 'u2', reason: 'updated with the order: quantity 3 → 4' },
      { status: 'active', fromStatus: 'active', changedAt: at(3), reason: 'manual (-2)' },
      { status: 'active', fromStatus: 'active', changedAt: at(4), reason: 'preempted (-1)' },
      { status: 'fulfilled', fromStatus: 'active', changedAt: at(5), reason: 'sync' },
      { status: 'active', fromStatus: 'fulfilled', changedAt: at(6), reason: 'sync' },
      { status: 'cancelled', fromStatus: 'active', changedAt: at(7), reason: 'internal_order_cancelled' },
    ])
    expect(keys(h)).toEqual([
      ['created', {}],
      ['quantity', { from: 5, to: 3 }],
      ['client', {}],
      ['quantity', { from: 3, to: 4 }],
      ['released', { quantity: 2 }],
      ['preempted', { quantity: 1 }],
      ['fulfilled', {}],
      ['reopened', {}],
      ['cancelled.internal_order_cancelled', {}],
    ])
    expect(h[0].by).toBe('u1')
    expect(h[3].by).toBe('u2')
    expect(h[4].by).toBeNull()
  })

  it('says where a reservation came from', () => {
    const born = (reason: string, opts = {}) => keys(reservationHistory([{ status: 'active', changedAt: at(0), reason }], opts))[0]
    expect(born('created with the order')).toEqual(['createdWithOrder', {}])
    expect(born('reserved again with the order', { repeatOfNumber: 'RES-2026-00004' })).toEqual(['repeatOf', { number: 'RES-2026-00004' }])
    expect(born('created', { repeatOfNumber: 'RES-2026-00004' })).toEqual(['repeatOf', { number: 'RES-2026-00004' }])
    expect(born('preempted from RES-2026-00002')).toEqual(['preemptedFrom', { number: 'RES-2026-00002' }])
    expect(born('generated for ORDI-2026-00007')).toEqual(['generatedFor', { number: 'ORDI-2026-00007' }])
    expect(born('something else')).toEqual(['other', { text: 'something else' }])
  })

  it('a migrated reservation born cancelled says why, from the document', () => {
    const h = reservationHistory(
      [{ status: 'cancelled', changedAt: at(0), reason: 'migrated from embedded order reservation' }],
      { cancelReason: 'external_order_cancelled' },
    )
    expect(keys(h)).toEqual([['migrated', {}], ['cancelled.external_order_cancelled', {}]])
  })

  it('is oldest first, whatever order the server keeps', () => {
    const h = reservationHistory([
      { status: 'cancelled', fromStatus: 'active', changedAt: at(9), reason: 'manual' },
      { status: 'active', changedAt: at(0), reason: 'created' },
    ])
    expect(keys(h).map(([k]) => k)).toEqual(['created', 'cancelled.manual'])
  })

  it('every key it can name is in all four languages', () => {
    const named = [
      'created', 'createdWithOrder', 'repeatOf', 'migrated', 'preemptedFrom', 'generatedFor', 'quantity', 'client',
      'released', 'preempted', 'fulfilled', 'reopened', 'other', ...CANCEL_REASONS.map((r) => `cancelled.${r}`),
    ]
    for (const locale of LOCALES) {
      const c = catalogue(locale)
      for (const k of named) {
        expect({ locale, k, ok: typeof valueAt(c, `invoicing.reservations.history.${k}`) === 'string' }).toEqual({ locale, k, ok: true })
      }
    }
  })
})
