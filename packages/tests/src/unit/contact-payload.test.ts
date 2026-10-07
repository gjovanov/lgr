import { describe, it, expect } from 'bun:test'
// PURE module — reached by path like document-payload: `invoicing-ui` is a private app package.
import {
  buildContactPayload,
  isValidOptionalEmail,
  type ContactFormState,
} from '../../../invoicing-ui/src/composables/contact-payload'

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
    expect(isValidOptionalEmail('office@regal.bg')).toBe(true)
    expect(isValidOptionalEmail('  office@regal.bg ')).toBe(true)
  })

  it('refuses what the API would refuse', () => {
    expect(isValidOptionalEmail('office')).toBe(false)
    expect(isValidOptionalEmail('office@')).toBe(false)
    expect(isValidOptionalEmail('office@regal')).toBe(false)
    expect(isValidOptionalEmail('a b@regal.bg')).toBe(false)
  })
})

describe('buildContactPayload — create', () => {
  it('leaves out every empty text field, the email above all', () => {
    const body = buildContactPayload(blankForm(), 'create')
    expect(body).toEqual({ type: 'customer', companyName: 'Acme', paymentTermsDays: 30, isActive: true, tags: [], addresses: [], bankDetails: [] })
    expect('email' in body).toBe(false)
  })

  it('trims what was typed', () => {
    const body = buildContactPayload(blankForm({ email: ' office@regal.bg ', vatNumber: ' BG112500982 ' }), 'create')
    expect(body.email).toBe('office@regal.bg')
    expect(body.vatNumber).toBe('BG112500982')
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
      addresses: [{ type: 'shipping', street: ' ПЛОВДИВСКА 110 ', city: 'Пазарджик', postalCode: '', country: '', isDefault: true }],
    }), 'create')
    expect(body.addresses).toEqual([{ type: 'shipping', street: 'ПЛОВДИВСКА 110', city: 'Пазарджик', isDefault: true }])
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
