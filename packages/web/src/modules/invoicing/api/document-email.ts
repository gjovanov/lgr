import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/**
 * `api/src/invoicing/controllers/invoice-export.controller.ts`, `POST /org/:orgId/invoicing/export/:id/email`: one
 * document mailed as the PDF Print makes. Not "send": `/invoices/:id/send` issues a document.
 */

/** The body, as the route's schema declares it. */
export interface DocumentEmailBody {
  to: string
  subject?: string
  message?: string
  /** The PDF's and the mail's language. */
  locale?: string
  note?: string
  columns?: string[]
}

/**
 * Sent (`sent: true`), or, on a server, queued for lgrai.app to send (FR-20.86, a 202): the document's send history is
 * updated when it has gone. A provider that is not configured is a 503, one that refused the mail a 502.
 */
export type DocumentEmailAnswer = { sent: true; to: string } | { sent: false; queued: true; to: string }

export async function emailDocument(id: string, body: DocumentEmailBody): Promise<DocumentEmailAnswer> {
  const { data } = await httpClient.post(orgPath(`/invoicing/export/${id}/email`), body)
  return data
}
