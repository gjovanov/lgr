import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** `invoicing-api/src/controllers/sequence-config.controller.ts`, `/org/:orgId/invoicing/sequences`. */
const BASE = '/invoicing/sequences'

/** One series of numbers (a group and its variant), as the list answers it for the current year. */
export interface SequenceRow {
  prefix: string
  defaultDisplay: string
  displayPrefix: string
  group: 'invoice' | 'proforma' | 'offer' | 'bill' | 'cash_sale' | 'order'
    | 'internal_order' | 'reservation' | 'certificate' | 'pp_protocol' | 'pos_session'
  variant: 'draft' | 'issued'
  year: number
  lastNumber: number
  /** The org may number this series without a year (the sales documents). */
  mayBeContinuous: boolean
  /** It does: ten digits, no year, on through the years. */
  continuous: boolean
  padLength: number
}

export async function listSequences(): Promise<{ sequences: SequenceRow[]; year: number }> {
  const { data } = await httpClient.get(orgPath(BASE))
  return data
}

/**
 * The body of `PUT /:prefix`, as its schema declares it: each setting is changed only when it is named. `null` takes
 * the display prefix back to the series' own.
 */
export interface SequenceUpdateBody {
  displayPrefix?: string | null
  continuous?: boolean
}

export async function updateSequence(prefix: string, body: SequenceUpdateBody): Promise<{ prefix: string; displayPrefix: string | null; continuous: boolean }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${prefix}`), body)
  return data
}
