import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** The part of the org's settings the inventory screens read: the VAT rate documents preselect. */
export interface OrgSettings {
  taxConfig?: { defaultVatRate?: number }
}

/** The org as `GET /org/:orgId` answers it (`api/src/controllers/org.controller.ts`, `orgForClient`): the fields read here. */
export interface Org {
  name: string
  settings?: OrgSettings
}

export async function getOrg(): Promise<{ org: Org }> {
  const { data } = await httpClient.get(orgPath())
  return data
}
