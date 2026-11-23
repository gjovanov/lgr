import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/invoicing/controllers/contact.controller.ts`, `/org/:orgId/invoicing/contact`: the inventory screens' pickers. */
const BASE = '/invoicing/contact'

/** A contact as the list answers it: the fields the pickers name it by. */
export interface Contact {
  _id: string
  id: string
  type: string
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
  isActive?: boolean
}

export interface ContactListParams {
  search?: string
  /** The contact's kind, as the route filters it (`supplier` for the suppliers tab). */
  type?: string
  page?: number
  size?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export async function listContacts(params: ContactListParams): Promise<ListPage & { contacts: Contact[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}
