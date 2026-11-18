import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/**
 * The accounting routes the invoicing screens read: the chart of accounts (`accounting-api/src/controllers/
 * account.controller.ts`, `/org/:orgId/accounting/account`) and the bank accounts (`bank-account.controller.ts`,
 * `/org/:orgId/accounting/bank-account`), for the cash and payment orders' pickers.
 */

/** An account of the chart (the repository's entity). */
export interface Account {
  _id: string
  id: string
  code: string
  name: string
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  subType: string
  parentId?: string
  isActive: boolean
}

/** A bank account of the org (the repository's entity). */
export interface BankAccount {
  _id: string
  id: string
  name: string
  bankName?: string
  accountNumber: string
  iban?: string
  currency?: string
}

/** `size: 0` is the whole chart, past the list's ceiling (FR-30.8). */
export async function listAccounts(params: { size?: number }): Promise<ListPage & { accounts: Account[] }> {
  const { data } = await httpClient.get(orgPath('/accounting/account'), { params })
  return data
}

export async function listBankAccounts(params: { size?: number }): Promise<ListPage & { bankAccounts: BankAccount[] }> {
  const { data } = await httpClient.get(orgPath('/accounting/bank-account'), { params })
  return data
}
