import type { TenantEntity } from '../types.js'

export interface IOwnRecordsConfig {
  sales?: boolean; purchase?: boolean; project?: boolean; helpdesk?: boolean
  crm?: boolean; payroll?: boolean; hr?: boolean; documents?: boolean
  subscriptions?: boolean; planning?: boolean; fleet?: boolean; erp?: boolean
}

export interface IPermissionSet extends TenantEntity {
  name: string
  description?: string
  permissions: string[]
  ownRecordsOnly: IOwnRecordsConfig
  /** FR-26: absent = every area, `[]` = none. */
  areas?: string[]
  isDefault: boolean
  isAdmin: boolean
  isSystem: boolean
}
