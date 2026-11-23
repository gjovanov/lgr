import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/**
 * `api/src/invoicing/controllers/number-clash.controller.ts`, `/org/:orgId/invoicing/number-clashes`: a legal number
 * issued twice (FR-20.51), and its correction (`services/biz/number-clash.service.ts`).
 */
const BASE = '/invoicing/number-clashes'

/** One document of a pair, as the list names it. */
export interface ClashDocument {
  id: string
  invoiceNumber: string
  type: string
  direction: string
  status: string
  issueDate: string | null
  total: number
  currency: string | null
  contact: string | null
  importedFrom: string | null
}

/** A document of a drafted correction. */
export interface ClashCorrectionDocument { id: string; number: string; status: string }

export interface NumberClash {
  /** The flagged document's id. */
  id: string
  number: string
  source: string
  at: string
  flagged: ClashDocument
  other: ClashDocument | null
  /** Which of the two is the later one, the one corrected. */
  later: 'flagged' | 'other'
  /** Only a sales invoice is annulled and re-issued here. */
  correctable: boolean
  correction: {
    target: string
    preparedAt: string
    creditNote: ClashCorrectionDocument | null
    reissue: ClashCorrectionDocument | null
  } | null
  /** Both drafts of the correction are issued. */
  resolved: boolean
}

export async function listNumberClashes(): Promise<{ clashes: NumberClash[] }> {
  const { data } = await httpClient.get(orgPath(BASE))
  return data
}

/** Drafts the credit note and the re-issue of the later document. A refusal carries its `code`. */
export async function prepareClashCorrection(id: string): Promise<{ correction: { target: string; creditNote: { id: string; number: string }; reissue: { id: string; number: string } } }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/prepare`))
  return data
}
