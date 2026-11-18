import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type Done, type ListPage } from './org-path'

/** `invoicing-api/src/controllers/contact.controller.ts`, `/org/:orgId/invoicing/contact`. */
const BASE = '/invoicing/contact'

/** The three kinds the create and update schemas accept. */
export type ContactType = 'customer' | 'supplier' | 'both'

export interface ContactAddress {
  type?: string
  street?: string
  street2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  isDefault?: boolean
}

export interface ContactBankDetails {
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string
  isDefault?: boolean
}

/**
 * A contact as the routes answer it (the repository's entity). The list's rows (`fields=list`, FR-30.7) leave out the
 * notes and the search mirrors, so what a row may lack is optional here.
 */
export interface Contact {
  _id: string
  id: string
  type: ContactType
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
  currency?: string
  paymentTermsDays?: number
  creditLimit?: number
  discount?: number
  notes?: string
  /** The МОЛ (FR-25a). */
  representative?: string
  tags?: string[]
  /** Its other names („Also known as", FR-28.12). */
  aliases?: string[]
  isActive?: boolean
  addresses?: ContactAddress[]
  bankDetails?: ContactBankDetails[]
}

/** The body of `POST /`, as its schema declares it. ⚠ A field it does not name is dropped, and the route answers 200. */
export interface ContactCreateBody {
  type: ContactType
  companyName?: string
  firstName?: string
  lastName?: string
  /** `''` is how a form says "none". */
  email?: string
  phone?: string
  mobile?: string
  website?: string
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  registrationNumber?: string
  currency?: string
  paymentTermsDays?: number
  creditLimit?: number
  discount?: number
  notes?: string
  representative?: string
  tags?: string[]
  aliases?: string[]
  isActive?: boolean
  addresses?: ContactAddress[]
  bankDetails?: ContactBankDetails[]
}

/** The body of `PUT /:id`: every field of the create, each optional. */
export type ContactUpdateBody = Partial<ContactCreateBody>

export interface ContactListParams {
  search?: string
  /** `customer` and `supplier` take the contacts that are both too. */
  type?: string
  tags?: string
  page?: number
  size?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  /** FR-22.25: a document's side first, by recent use (a picker; never with `sortBy`). */
  prefer?: 'customer' | 'supplier'
  /** FR-30.7: `list` answers rows, without the notes and the search mirrors. */
  fields?: 'list'
  /** FR-30.12: a type-ahead counts nothing. */
  count?: 'none'
}

export async function listContacts(params: ContactListParams): Promise<ListPage & { contacts: Contact[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

/** A missing contact is a 404. */
export async function getContact(id: string): Promise<{ contact: Contact }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

export async function createContact(body: ContactCreateBody): Promise<{ contact: Contact }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updateContact(id: string, body: ContactUpdateBody): Promise<{ contact: Contact }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** Deactivates it (the route keeps the record). */
export async function deleteContact(id: string): Promise<Done> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}

/**
 * The contact form's smart buttons (Invoices / Open Balance / Movements). The balance is in the documents' one currency,
 * and null when they are in several (`mixedCurrency`).
 */
export interface ContactSummary {
  invoiceCount: number
  openBalance: number | null
  currency: string | null
  mixedCurrency: boolean
  movementCount: number
}

export async function getContactSummary(id: string): Promise<ContactSummary> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}/summary`))
  return data
}

/** A document behind the Open Balance button, with what it still owes. Its amounts are signed like `due` (#447). */
export interface UnpaidDocument {
  _id: string
  type: string
  direction: 'outgoing' | 'incoming'
  invoiceNumber: string
  issueDate: string
  dueDate?: string
  status: string
  currency?: string
  total: number
  amountPaid: number
  due: number
}

/** At most `UNPAID_LIST_MAX` rows; the count and the balance are of them all. */
export interface ContactUnpaid {
  documents: UnpaidDocument[]
  count: number
  openBalance: number | null
  currency: string | null
  mixedCurrency: boolean
}

export async function getContactUnpaid(id: string): Promise<ContactUnpaid> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}/unpaid`))
  return data
}

/** A company found in the registries (`services/biz/company-lookup.service.ts#CompanyInfo`). */
export interface CompanyInfo {
  companyName: string
  taxNumber: string
  vatNumber: string
  address?: { street: string; city: string; postalCode: string; country: string }
  founders?: string[]
  owners?: string[]
  isValid: boolean
}

/** A Bulgarian EIK or an EU VAT number. Not found is a 404; an EU number this server cannot check, a 503. */
export async function lookupCompany(vatNumber: string): Promise<{ company: CompanyInfo }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/lookup/${encodeURIComponent(vatNumber)}`))
  return data
}
