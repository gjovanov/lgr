import { describe, it, expect } from 'bun:test'
// PURE module. In ui-shared since FR-22.6, with the contact picker that uses it.
import {
  buildContactPayload,
  isValidOptionalEmail,
  type ContactFormState,
} from 'ui-shared/composables/contact-payload'

/**
 * The contact forms used to post their reactive state verbatim. An empty email box failed the
 * API's email format check (users read the 422 as "email is required"), a cleared number box
 * sent `''` to a number field, and an "Add address" row left blank failed the model's required
 * street — each a server error naming a schema path. These pin what the forms send instead.
 */

function blankForm(over: Partial<ContactFormState> = {}): ContactFormState {
  return {
    companyName: 'Acme',
    firstName: '',
    lastName: '',
    type: 'customer',
    email: '',
    phone: '',
    mobile: '',
    taxId: '',
    taxNumber: '',
    vatNumber: '',
    registrationNumber: '',
    paymentTermsDays: 30,
    website: '',
    isActive: true,
    notes: '',
    addresses: [],
    bankDetails: [],
    tags: [],
    ...over,
  }
}

describe('isValidOptionalEmail', () => {
  it('accepts an empty box — the email is optional', () => {
    expect(isValidOptionalEmail('')).toBe(true)
    expect(isValidOptionalEmail('   ')).toBe(true)
    expect(isValidOptionalEmail(undefined)).toBe(true)
  })

  it('accepts a real address, surrounding spaces included (the payload trims them)', () => {
    expect(isValidOptionalEmail('office@example.bg')).toBe(true)
    expect(isValidOptionalEmail('  office@example.bg ')).toBe(true)
  })

  it('refuses what the API would refuse', () => {
    expect(isValidOptionalEmail('office')).toBe(false)
    expect(isValidOptionalEmail('office@')).toBe(false)
    expect(isValidOptionalEmail('office@regal')).toBe(false)
    expect(isValidOptionalEmail('a b@example.bg')).toBe(false)
  })
})

describe('buildContactPayload — create', () => {
  it('leaves out every empty text field, the email above all', () => {
    const body = buildContactPayload(blankForm(), 'create')
    expect(body).toEqual({ type: 'customer', companyName: 'Acme', paymentTermsDays: 30, isActive: true, tags: [], addresses: [], bankDetails: [] })
    expect('email' in body).toBe(false)
  })

  it('trims what was typed', () => {
    const body = buildContactPayload(blankForm({ email: ' office@example.bg ', vatNumber: ' BG123456786 ' }), 'create')
    expect(body.email).toBe('office@example.bg')
    expect(body.vatNumber).toBe('BG123456786')
  })

  it('drops a cleared number box instead of sending an empty string', () => {
    expect('paymentTermsDays' in buildContactPayload(blankForm({ paymentTermsDays: '' }), 'create')).toBe(false)
    expect('paymentTermsDays' in buildContactPayload(blankForm({ paymentTermsDays: null }), 'create')).toBe(false)
    expect(buildContactPayload(blankForm({ paymentTermsDays: '45' }), 'create').paymentTermsDays).toBe(45)
    expect(buildContactPayload(blankForm({ paymentTermsDays: 0 }), 'create').paymentTermsDays).toBe(0)
  })

  it('drops address and bank rows that were added and never filled in', () => {
    const body = buildContactPayload(blankForm({
      addresses: [{ type: 'billing', street: '', city: '', postalCode: '', country: '', isDefault: false }],
      bankDetails: [{ bankName: '', accountNumber: '', iban: '', swift: '', currency: 'EUR', isDefault: false }],
    }), 'create')
    expect(body.addresses).toEqual([])
    expect(body.bankDetails).toEqual([])
  })

  it('keeps a filled address, leaving empty parts out so the model default country applies', () => {
    const body = buildContactPayload(blankForm({
      addresses: [{ type: 'shipping', street: ' УЛ.ТЕСТОВА 101 ', city: 'Тестоград', postalCode: '', country: '', isDefault: true }],
    }), 'create')
    expect(body.addresses).toEqual([{ type: 'shipping', street: 'УЛ.ТЕСТОВА 101', city: 'Тестоград', isDefault: true }])
  })

  it('keeps a filled bank row, with a currency even if the box was cleared', () => {
    const body = buildContactPayload(blankForm({
      bankDetails: [{ bankName: 'ОББ', accountNumber: 'BG80BNBG96611020345678', iban: '', swift: '', currency: '', isDefault: false }],
    }), 'create')
    expect(body.bankDetails).toEqual([{ bankName: 'ОББ', accountNumber: 'BG80BNBG96611020345678', currency: 'EUR', isDefault: false }])
  })
})

describe('buildContactPayload — update', () => {
  it('sends empty text fields as "" so clearing a box clears the stored value', () => {
    const body = buildContactPayload(blankForm({ email: '' }), 'update')
    expect(body.email).toBe('')
    expect(body.phone).toBe('')
  })

  it('keeps the ids of existing address and bank rows', () => {
    const body = buildContactPayload(blankForm({
      addresses: [{ _id: 'a1', type: 'billing', street: 'Main 1', country: 'BG', isDefault: true }],
      bankDetails: [{ _id: 'b1', bankName: 'ОББ', accountNumber: '123', currency: 'EUR' }],
    }), 'update')
    expect(body.addresses[0]._id).toBe('a1')
    expect(body.bankDetails[0]._id).toBe('b1')
  })
})

describe('buildContactPayload — the other names („Also known as")', () => {
  it('sends them as the API stores them: trimmed, single-spaced, each once, never the contact\'s own name', () => {
    const body = buildContactPayload(blankForm({ companyName: 'Acme Ltd', aliases: ['  ACME ', 'acme', 'Acme   Fasteners', '', ' acme  ltd ', 'А+М'] }), 'update')
    expect(body.aliases).toEqual(['ACME', 'Acme Fasteners', 'А+М'])
  })

  it('a new contact with none sends no key; one that has some sends them', () => {
    expect('aliases' in buildContactPayload(blankForm({ aliases: [] }), 'create')).toBe(false)
    expect('aliases' in buildContactPayload(blankForm({ aliases: ['  '] }), 'create')).toBe(false)
    expect(buildContactPayload(blankForm({ aliases: ['Acme BG'] }), 'create').aliases).toEqual(['Acme BG'])
  })

  it('an edit that removes the last one sends an empty list, which clears what is stored', () => {
    expect(buildContactPayload(blankForm({ aliases: [] }), 'update').aliases).toEqual([])
  })

  it('a form with no such field (the picker\'s create dialog) leaves the key out, so nothing stored is touched', () => {
    expect('aliases' in buildContactPayload(blankForm(), 'create')).toBe(false)
    expect('aliases' in buildContactPayload(blankForm(), 'update')).toBe(false)
  })
})

/**
 * FR-25a: the МОЛ has a field of its own, which the importers fill. The contact form shows and saves it; a
 * payload that left it out would make the form a reader that can never write it, and one that sent `''` from a
 * form without the box would clear what an import stored.
 */
describe('buildContactPayload — the МОЛ (representative)', () => {
  it('a new contact sends it trimmed, and leaves an empty box out like every empty field', () => {
    expect(buildContactPayload(blankForm({ representative: '  Иван Тестов ' }), 'create').representative).toBe('Иван Тестов')
    expect('representative' in buildContactPayload(blankForm({ representative: '' }), 'create')).toBe(false)
    expect('representative' in buildContactPayload(blankForm({ representative: '   ' }), 'create')).toBe(false)
  })

  it('an edit sends what the box holds, and "" when it was cleared, which clears what is stored', () => {
    expect(buildContactPayload(blankForm({ representative: 'Иван Тестов' }), 'update').representative).toBe('Иван Тестов')
    expect(buildContactPayload(blankForm({ representative: '' }), 'update').representative).toBe('')
  })

  it('a form with no such field (the picker\'s create dialog) leaves the key out, so an import\'s МОЛ is never cleared', () => {
    expect('representative' in buildContactPayload(blankForm(), 'create')).toBe(false)
    expect('representative' in buildContactPayload(blankForm(), 'update')).toBe(false)
  })
})
