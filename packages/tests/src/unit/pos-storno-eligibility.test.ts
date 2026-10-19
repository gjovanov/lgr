import { describe, it, expect } from 'bun:test'
import { canStornoTransaction, STORNO_ROLES } from '../../../pos-ui/src/composables/storno'

/**
 * #145 — the STORNO button must never be offered where the server would refuse it
 * (`POST /session/:id/storno`: admin / manager / warehouse_manager, a completed non-storno sale).
 */
describe('canStornoTransaction', () => {
  it('offers storno on a completed sale to the roles the server accepts', () => {
    for (const role of STORNO_ROLES) {
      expect(canStornoTransaction({ type: 'sale', status: 'completed' }, role), role).toBe(true)
    }
  })

  it('never to a cashier or a read-only role', () => {
    for (const role of ['member', 'accountant', 'nra_auditor', 'cashier', '', undefined]) {
      expect(canStornoTransaction({ type: 'sale', status: 'completed' }, role as any), String(role)).toBe(false)
    }
  })

  it('never on a storno, a cancelled (already reversed) sale, or nothing', () => {
    expect(canStornoTransaction({ type: 'storno', status: 'completed' }, 'admin')).toBe(false)
    expect(canStornoTransaction({ type: 'sale', status: 'cancelled' }, 'admin')).toBe(false)
    expect(canStornoTransaction(null, 'admin')).toBe(false)
  })
})
