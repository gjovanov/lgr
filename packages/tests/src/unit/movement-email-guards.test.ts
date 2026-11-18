import { describe, it, expect } from 'bun:test'
// Import-pure modules (no db/models): this file must never boot Mongoose, as `doc-email-guards.test.ts`.
import { MOVEMENT_EMAIL_WORK, MOVEMENT_READS, mayEmailMovements, movementEmailSkip } from 'warehouse-api/src/lib/movement-email-guards'
import { writesTransfersOnly } from 'warehouse-api/src/lib/movement-access'
import { accessRuleFor, templateGrant, type CapabilityId, type Grant } from 'config/access'
import { DOC_EMAIL_BLOCKS, DOC_EMAIL_SKIPS } from 'config/doc-email'
import { ROLES, type Role } from 'config/constants'

/**
 * Which of the movements list's ticked movements go by e-mail (2026-11-16): the rule per movement.
 *
 * One function decides the preview and the mail request (`lib/movement-email.ts` calls it for both), so the dialog
 * never promises a movement the request then refuses. Here it is asked without a server: who, which movement, in
 * what state, and in what ORDER the reasons are given.
 */

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
/** A role as its token compiles today: its default permissions, and FR-26's areas where the role has them. */
/** A built-in role's grant (FR-27 P3-6: the legacy model is gone; the templates are its access, pinned). */
const legacy = (role: Role) => templateGrant(role)

const WORKER = caps('movements.view', 'movements.create', 'movements.edit', 'movements.delete')
/** A Seller's part of it (FR-26.7): reads the movements, writes transfers. */
const SELLER = caps('movements.lookup', 'movements.create:transfer')
const READER = caps('movements.view', 'movements.lookup')

const TYPES = ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out']
const movement = (type: string, status = 'confirmed') => ({ type, status })

describe('who mails a movement at all', () => {
  it('whoever works on movements, or writes a Seller\'s transfers', () => {
    for (const cap of MOVEMENT_EMAIL_WORK) expect(mayEmailMovements(caps('movements.view', cap)), cap).toBe(true)
    expect(mayEmailMovements({ all: true })).toBe(true)
    expect(mayEmailMovements(WORKER)).toBe(true)
    expect(mayEmailMovements(SELLER)).toBe(true)
  })

  it('a session that only reads them mails none, nor does no session', () => {
    expect(mayEmailMovements(READER)).toBe(false)
    expect(mayEmailMovements(caps('sales-docs.view', 'sales-docs.edit', 'products.edit'))).toBe(false)
    expect(mayEmailMovements(caps())).toBe(false)
    expect(mayEmailMovements(null)).toBe(false)
    expect(mayEmailMovements(undefined)).toBe(false)
  })

  it('is the rule both mail routes are reached by, in the route table of the new model', () => {
    const anyOf = (rule: unknown) => [...((rule as { anyOf?: readonly string[] })?.anyOf ?? [])].sort()
    for (const rest of ['warehouse/movement/email', 'warehouse/movement/email/preview']) {
      expect(anyOf(accessRuleFor('POST', rest)), rest).toEqual([...MOVEMENT_EMAIL_WORK].sort())
    }
  })

  it('and reading one is the rule the movement and its printed sheet are reached by', () => {
    const anyOf = (rule: unknown) => [...((rule as { anyOf?: readonly string[] })?.anyOf ?? [])].sort()
    for (const rest of ['warehouse/movement/0123456789abcdef01234567', 'warehouse/movement/0123456789abcdef01234567/export']) {
      expect(anyOf(accessRuleFor('GET', rest)), rest).toEqual([...MOVEMENT_READS].sort())
    }
  })

  it('by built-in role', () => {
    const mails = ROLES.filter(role => mayEmailMovements(legacy(role)))
    expect(mails).toEqual(['admin', 'manager', 'warehouse_manager', 'seller', 'sales_consultant'])
  })
})

describe('a transfer-only session', () => {
  it('is one that writes movements without movements.create', () => {
    expect(writesTransfersOnly(SELLER)).toBe(true)
    expect(writesTransfersOnly(caps('movements.view', 'movements.edit', 'movements.delete'))).toBe(true)
    expect(writesTransfersOnly(WORKER)).toBe(false)
    expect(writesTransfersOnly({ all: true })).toBe(false)
    expect(writesTransfersOnly(null)).toBe(true)
  })

  it('by built-in role: the two FR-26 roles, and nobody who works on movements', () => {
    expect(writesTransfersOnly(legacy('seller'))).toBe(true)
    expect(writesTransfersOnly(legacy('sales_consultant'))).toBe(true)
    for (const role of ['admin', 'manager', 'warehouse_manager'] as const) expect(writesTransfersOnly(legacy(role)), role).toBe(false)
  })
})

describe('one movement', () => {
  it('a booked movement of any type goes for a session that works on movements', () => {
    for (const type of TYPES) {
      for (const status of ['confirmed', 'completed']) {
        expect(movementEmailSkip({ grant: WORKER, movement: movement(type, status) }), `${type} ${status}`).toBeNull()
      }
    }
    expect(movementEmailSkip({ grant: { all: true }, movement: movement('receipt') })).toBeNull()
  })

  it('no such movement, and a session that reads no movements, are the same answer', () => {
    expect(movementEmailSkip({ grant: WORKER, movement: null })).toBe('not_found')
    expect(movementEmailSkip({ grant: WORKER, movement: undefined })).toBe('not_found')
    // It holds the work and not the read: it is told nothing a missing id would not tell it.
    expect(movementEmailSkip({ grant: caps('movements.create', 'movements.edit'), movement: movement('receipt') })).toBe('not_found')
    expect(movementEmailSkip({ grant: caps('movements.create:transfer'), movement: movement('transfer') })).toBe('not_found')
    expect(movementEmailSkip({ grant: null, movement: movement('transfer') })).toBe('not_found')
    expect(movementEmailSkip({ grant: undefined, movement: movement('transfer') })).toBe('not_found')
  })

  it('each of the three reads is enough to read one', () => {
    for (const read of MOVEMENT_READS) {
      expect(movementEmailSkip({ grant: caps(read, 'movements.create'), movement: movement('receipt') }), read).toBeNull()
    }
  })

  it('a movement the session reads and does not work on is forbidden', () => {
    for (const type of TYPES) expect(movementEmailSkip({ grant: READER, movement: movement(type) }), type).toBe('forbidden')
    // The sales documents' read reaches a dispatch's movement; it is no work on movements.
    expect(movementEmailSkip({ grant: caps('sales-docs.view', 'sales-docs.edit'), movement: movement('dispatch') })).toBe('forbidden')
  })

  it('a transfer-only session mails a transfer, and no other type', () => {
    expect(movementEmailSkip({ grant: SELLER, movement: movement('transfer') })).toBeNull()
    expect(movementEmailSkip({ grant: SELLER, movement: movement('transfer', 'completed') })).toBeNull()
    for (const type of TYPES.filter(t => t !== 'transfer')) {
      expect(movementEmailSkip({ grant: SELLER, movement: movement(type) }), type).toBe('forbidden')
    }
    // As its writes go: without `movements.create`, the rest of the work is on transfers too.
    const editor = caps('movements.view', 'movements.edit', 'movements.delete')
    expect(movementEmailSkip({ grant: editor, movement: movement('transfer') })).toBeNull()
    expect(movementEmailSkip({ grant: editor, movement: movement('receipt') })).toBe('forbidden')
  })

  it('a draft does not go: it is not booked', () => {
    for (const type of TYPES) expect(movementEmailSkip({ grant: WORKER, movement: movement(type, 'draft') }), type).toBe('draft')
    expect(movementEmailSkip({ grant: SELLER, movement: movement('transfer', 'draft') })).toBe('draft')
  })

  it('a cancelled one does not go: it moved nothing', () => {
    for (const type of TYPES) expect(movementEmailSkip({ grant: WORKER, movement: movement(type, 'cancelled') }), type).toBe('cancelled')
    expect(movementEmailSkip({ grant: SELLER, movement: movement('transfer', 'cancelled') })).toBe('cancelled')
  })

  it('the reasons come in order: unread, then not its work, then the state, then the double click', () => {
    // A session that reads none is told nothing of the state or of its own rights.
    expect(movementEmailSkip({ grant: caps('movements.create'), movement: movement('receipt', 'draft'), recentSend: true })).toBe('not_found')
    // A Seller is not told a receipt is a draft, or cancelled: it is not its to mail in any state.
    expect(movementEmailSkip({ grant: SELLER, movement: movement('receipt', 'draft') })).toBe('forbidden')
    expect(movementEmailSkip({ grant: SELLER, movement: movement('receipt', 'cancelled'), recentSend: true })).toBe('forbidden')
    expect(movementEmailSkip({ grant: READER, movement: movement('transfer', 'cancelled') })).toBe('forbidden')
    // The state before the double click: a draft that somehow went a moment ago is still a draft.
    expect(movementEmailSkip({ grant: WORKER, movement: movement('receipt', 'draft'), recentSend: true })).toBe('draft')
    expect(movementEmailSkip({ grant: WORKER, movement: movement('receipt', 'cancelled'), recentSend: true })).toBe('cancelled')
    expect(movementEmailSkip({ grant: WORKER, movement: movement('receipt'), recentSend: true })).toBe('just_sent')
    expect(movementEmailSkip({ grant: SELLER, movement: movement('transfer'), recentSend: true })).toBe('just_sent')
    expect(movementEmailSkip({ grant: WORKER, movement: null, recentSend: true })).toBe('not_found')
  })

  it('every reason is one the dialog has words for, and only the double click needs an address', () => {
    const grants = [WORKER, SELLER, READER, caps('movements.create'), caps(), null, { all: true } as Grant]
    const movements = [null, ...TYPES.flatMap(type => ['draft', 'confirmed', 'completed', 'cancelled'].map(status => movement(type, status)))]
    const asked = new Set<string>()
    for (const grant of grants) {
      for (const m of movements) {
        const preview = movementEmailSkip({ grant, movement: m })
        const mail = movementEmailSkip({ grant, movement: m, recentSend: true })
        if (preview) expect(DOC_EMAIL_BLOCKS as readonly string[]).toContain(preview)
        if (mail) expect(DOC_EMAIL_SKIPS as readonly string[]).toContain(mail)
        // What the preview blocks, the mail request skips for the same reason: the address changes nothing of it.
        if (preview) expect(mail).toBe(preview)
        else expect(mail).toBe('just_sent')
        for (const reason of [preview, mail]) if (reason) asked.add(reason)
      }
    }
    expect([...asked].sort()).toEqual(['cancelled', 'draft', 'forbidden', 'just_sent', 'not_found'])
  })

  it('by role, on the legacy model: a booked receipt and a booked transfer', () => {
    const answers = Object.fromEntries(ROLES.map(role => [role, [
      movementEmailSkip({ grant: legacy(role), movement: movement('receipt') }),
      movementEmailSkip({ grant: legacy(role), movement: movement('transfer') }),
    ]]))
    expect(answers).toEqual({
      admin: [null, null],
      manager: [null, null],
      warehouse_manager: [null, null],
      // FR-26.7: stock between warehouses, and nothing else.
      seller: ['forbidden', null],
      sales_consultant: ['forbidden', null],
      // They read the movements (`inventory.read`) and work on none.
      accountant: ['forbidden', 'forbidden'],
      sales: ['forbidden', 'forbidden'],
      member: ['forbidden', 'forbidden'],
      nra_auditor: ['forbidden', 'forbidden'],
      // No inventory and no invoicing: a movement is nothing it reads.
      hr_manager: ['not_found', 'not_found'],
    })
  })
})
