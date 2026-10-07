/**
 * The request body for saving a contact, built from a contact form's state.
 *
 * PURE — no Vue, no I/O — so it is unit-tested directly
 * (`packages/tests/src/unit/contact-payload.test.ts`). Both contact editors use it: the
 * Contacts page and the "create contact" dialog on the invoice forms.
 *
 * It exists because the forms used to post their reactive state as-is, and three ordinary
 * things a person does each came back as a server error naming a schema path:
 *  - leaving the email empty: `''` failed the API's email format check, which users read as
 *    "email is required";
 *  - clearing a number box: `v-model.number` yields `''`, which the API's number type refuses;
 *  - pressing "Add address" / "Add bank account" and leaving the row blank: the model refuses
 *    an address with no street and a bank account with no name or number.
 */

export interface ContactFormAddress {
  _id?: string
  type?: string
  street?: string
  street2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  isDefault?: boolean
}

export interface ContactFormBankDetail {
  _id?: string
  bankName?: string
  accountNumber?: string
  iban?: string
  swift?: string
  currency?: string
  isDefault?: boolean
}

export interface ContactFormState {
  type: string
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  mobile?: string
  website?: string
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  registrationNumber?: string
  notes?: string
  paymentTermsDays?: number | string | null
  isActive?: boolean
  tags?: string[]
  addresses?: ContactFormAddress[]
  bankDetails?: ContactFormBankDetail[]
}

const TEXT_FIELDS = [
  'companyName', 'firstName', 'lastName', 'email', 'phone', 'mobile', 'website',
  'taxId', 'taxNumber', 'vatNumber', 'registrationNumber', 'notes',
] as const

/**
 * The API's own email check (Elysia's `format: 'email'`), so the form refuses exactly what the
 * server would and nothing more.
 */
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

/** Empty is valid — the email is optional; anything typed must be an address the API accepts. */
export function isValidOptionalEmail(v: unknown): boolean {
  const s = typeof v === 'string' ? v.trim() : ''
  return !s || EMAIL_RE.test(s)
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
}

/** `''` / null / not-a-number → undefined (the field is left out); anything else → a number. */
function toNumber(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function cleanAddresses(list: ContactFormAddress[]): ContactFormAddress[] {
  const out: ContactFormAddress[] = []
  for (const a of list) {
    const street = text(a.street)
    const rest = {
      street2: text(a.street2),
      city: text(a.city),
      state: text(a.state),
      postalCode: text(a.postalCode),
      country: text(a.country),
    }
    // A row added and never filled in is not an address — drop it instead of failing the save.
    if (!street && !Object.values(rest).some(Boolean)) continue
    const addr: ContactFormAddress = { type: a.type || 'billing', street, isDefault: !!a.isDefault }
    if (a._id) addr._id = a._id
    // Empty optional parts are left out; an empty country lets the model's default (BG) apply.
    for (const [k, v] of Object.entries(rest)) if (v) (addr as any)[k] = v
    out.push(addr)
  }
  return out
}

function cleanBankDetails(list: ContactFormBankDetail[]): ContactFormBankDetail[] {
  const out: ContactFormBankDetail[] = []
  for (const b of list) {
    const bank = {
      bankName: text(b.bankName),
      accountNumber: text(b.accountNumber),
      iban: text(b.iban),
      swift: text(b.swift),
    }
    if (!Object.values(bank).some(Boolean)) continue
    const row: ContactFormBankDetail = {
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      currency: text(b.currency) || 'EUR',
      isDefault: !!b.isDefault,
    }
    if (b._id) row._id = b._id
    if (bank.iban) row.iban = bank.iban
    if (bank.swift) row.swift = bank.swift
    out.push(row)
  }
  return out
}

/**
 * `create` leaves out every text field left empty. `update` sends `''`, so that clearing a box
 * on an existing contact actually clears the stored value.
 */
export function buildContactPayload(form: ContactFormState, mode: 'create' | 'update'): Record<string, any> {
  const out: Record<string, any> = { type: form.type }
  for (const k of TEXT_FIELDS) {
    if (!(k in form)) continue
    const v = text(form[k])
    if (!v && mode === 'create') continue
    out[k] = v
  }
  const days = toNumber(form.paymentTermsDays)
  if (days !== undefined) out.paymentTermsDays = days
  if (typeof form.isActive === 'boolean') out.isActive = form.isActive
  if (Array.isArray(form.tags)) out.tags = form.tags
  if (Array.isArray(form.addresses)) out.addresses = cleanAddresses(form.addresses)
  if (Array.isArray(form.bankDetails)) out.bankDetails = cleanBankDetails(form.bankDetails)
  return out
}
