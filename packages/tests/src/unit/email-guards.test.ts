import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models) — this file must never boot Mongoose, same reasoning as
// export-access.test.ts.
import {
  emailRequestBlock,
  isValidRecipient,
  RESEND_WINDOW_MS,
} from 'invoicing-api/src/lib/email-guards'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-10 (#19) — the gates on `POST /invoicing/export/:id/email`.
 *
 * The service contract (attachments, outcomes, logging) is pinned in `email-service.test.ts`.
 * This is the other half, and the one the acceptance criteria are actually written about:
 * who may send, what may be sent, and what happens on a double click.
 *
 * These are pure functions rather than HTTP calls because Elysia's `handle()` does not route
 * under `bun test` in this repo — a bare `new Elysia().get('/x')` answers NOT_FOUND — so the
 * endpoint cannot be driven in-process. The controller now consists of one call to the
 * function under test, so the coverage is real.
 */

const asUser = (role: string) => ({
  role,
  permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS],
})

const issued = { direction: 'outgoing', status: 'sent' }
const TO = 'customer@example.com'

describe('recipient validation', () => {
  it('accepts an ordinary address, trimmed', () => {
    expect(isValidRecipient('  someone@example.com ')).toBe(true)
    expect(isValidRecipient('first.last+tag@sub.example.co.uk')).toBe(true)
  })

  it('rejects the shapes a typo produces', () => {
    for (const bad of ['', '   ', 'nope@', '@example.com', 'no-at-sign', 'two@@example.com', 'trailing@dot.', null, undefined]) {
      expect(isValidRecipient(bad as any), String(bad)).toBe(false)
    }
  })
})

describe('who may send (FR-10.4)', () => {
  it('refuses a read-only member — printing is not sending', () => {
    const block = emailRequestBlock({ user: asUser('member'), to: TO, invoice: issued })
    expect(block?.status).toBe(403)
  })

  it('refuses the nra_auditor — it may read everything and send nothing', () => {
    const block = emailRequestBlock({ user: asUser('nra_auditor'), to: TO, invoice: issued })
    expect(block?.status).toBe(403)
  })

  it('refuses an anonymous caller', () => {
    expect(emailRequestBlock({ user: null, to: TO, invoice: issued })?.status).toBe(403)
  })

  it('lets the write-holding roles through', () => {
    for (const role of ['admin', 'manager', 'accountant']) {
      expect(emailRequestBlock({ user: asUser(role), to: TO, invoice: issued }), role).toBeNull()
    }
  })

  it('checks permission BEFORE the recipient — a member learns nothing from a typo', () => {
    // Order matters: answering 400 here would confirm the endpoint exists for them.
    const block = emailRequestBlock({ user: asUser('member'), to: 'garbage', invoice: issued })
    expect(block?.status).toBe(403)
  })
})

describe('what may be sent (FR-10.5)', () => {
  const admin = asUser('admin')

  it('404s a document that is not in this org', () => {
    const block = emailRequestBlock({ user: admin, to: TO, invoice: null })
    expect(block?.status).toBe(404)
  })

  it('refuses an incoming bill — you do not email a supplier their own invoice', () => {
    const block = emailRequestBlock({ user: admin, to: TO, invoice: { direction: 'incoming', status: 'received' } })
    expect(block?.status).toBe(422)
    expect(block?.message).toContain('outgoing')
  })

  it('refuses a draft — a DRF- number must never reach a customer', () => {
    const block = emailRequestBlock({ user: admin, to: TO, invoice: { direction: 'outgoing', status: 'draft' } })
    expect(block?.status).toBe(422)
    expect(block?.message).toContain('Issue the document')
  })

  it('allows every non-draft outgoing status', () => {
    for (const status of ['sent', 'partially_paid', 'paid', 'overdue', 'voided']) {
      expect(emailRequestBlock({ user: admin, to: TO, invoice: { direction: 'outgoing', status } }), status).toBeNull()
    }
  })

  it('validates the recipient before looking at the document', () => {
    // A bad address on a draft reports the address: it is the thing the user can fix.
    const block = emailRequestBlock({ user: admin, to: 'nope@', invoice: { direction: 'outgoing', status: 'draft' } })
    expect(block?.status).toBe(400)
  })
})

describe('duplicate-send guard (FR-10.6)', () => {
  const admin = asUser('admin')

  it('blocks a second identical send inside the window', () => {
    const block = emailRequestBlock({ user: admin, to: TO, invoice: issued, recentSend: true })
    expect(block?.status).toBe(429)
  })

  it('is the LAST gate — a draft is still reported as a draft', () => {
    const block = emailRequestBlock({
      user: admin, to: TO, invoice: { direction: 'outgoing', status: 'draft' }, recentSend: true,
    })
    expect(block?.status).toBe(422)
  })

  it('does not block when there is no recent send', () => {
    expect(emailRequestBlock({ user: admin, to: TO, invoice: issued, recentSend: false })).toBeNull()
  })

  it('keeps the window at one minute — long enough for a double click, short enough to retry', () => {
    expect(RESEND_WINDOW_MS).toBe(60_000)
  })
})
