/**
 * E-mailing several documents at once (2026-11-16): what the server and the dialog both read.
 *
 * A list's ticked documents go out by e-mail, each as its printed PDF: to its own customer or supplier, or all to
 * one address (a colleague, the accountant). Two endpoints per KIND of document carry it, and every kind speaks the
 * wire types below, so one dialog (`ui-shared/BatchEmailDialog`) and one engine (`services/biz/doc-email`) serve
 * them all:
 *   - `…/email/preview`  `{ kind, ids }`                → `{ documents: DocEmailPreviewRow[] }`, and writes nothing;
 *   - `…/email`          `{ kind, to, items, … }`       → `DocEmailAnswer`, ONE recipient per request.
 *
 * ⚠ Never "send" in a route or a function of this feature: `POST /invoices/:id/send` ISSUES a document.
 *
 * Import-pure: the SPA bundles it.
 */

/** The most documents one request mails, and so the most attachments one mail carries (the relay's cap, FR-20.59). */
export const MAX_DOCS_PER_MAIL = 10
/** The most ticked documents one dialog takes. More is 422 `selection_too_large`. */
export const MAX_SELECTION = 100

/**
 * FR-10.6: the same document to the same address again inside this window is a double click, not a second mail
 * (`just_sent`). A FAILED attempt is no block: the failure is why the person asks again.
 */
export const RESEND_WINDOW_MS = 60_000

/** Deliberately permissive — the real validation is the provider bouncing it. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isValidRecipient(to: unknown): boolean {
  return EMAIL_RE.test(String(to ?? '').trim())
}

/**
 * Why a document will not go, as the preview says it. `cancelled` is a stock movement's: one that was called off
 * moved nothing, and its sheet says nothing true to whoever receives it.
 */
export const DOC_EMAIL_BLOCKS = ['not_found', 'forbidden', 'draft', 'cancelled'] as const
export type DocEmailBlock = (typeof DOC_EMAIL_BLOCKS)[number]

/** …and as the mail request says it: the same, and the double-click window, which only a recipient can answer. */
export const DOC_EMAIL_SKIPS = [...DOC_EMAIL_BLOCKS, 'just_sent'] as const
export type DocEmailSkip = (typeof DOC_EMAIL_SKIPS)[number]

/** Why a document that was let through did not go after all. */
export const DOC_EMAIL_FAILURES = ['render_failed', 'too_large', 'provider_error', 'not_configured'] as const
export type DocEmailFailure = (typeof DOC_EMAIL_FAILURES)[number]

export interface DocEmailPartner {
  id: string
  name: string
  /** The address on the partner's card, when it has one. */
  email?: string
}

/**
 * One document the dialog was opened on. A supplier order is one row per supplier GROUP (`groupId`): each group is a
 * sheet of its own, for its own supplier.
 *
 * ⚠ A row blocked `not_found` carries the id it was asked by and nothing else: a document of another organization, of
 * a kind the caller does not read, and one that does not exist are the same row.
 */
export interface DocEmailPreviewRow {
  id: string
  groupId?: string
  number: string
  /** What the document is, for the dialog to name: `invoice`, `credit_note`, `bill`, `order`, a movement's `transfer`… */
  docType: string
  /** ISO date. */
  date?: string
  status?: string
  /** The customer of an outgoing document; the supplier of a bill or of an order's group; a stock movement's contact. */
  partner?: DocEmailPartner
  blocked?: DocEmailBlock
}

export interface DocEmailPreviewRequest {
  kind: string
  ids: string[]
}

export interface DocEmailPreviewAnswer {
  documents: DocEmailPreviewRow[]
}

export interface DocEmailItem {
  id: string
  groupId?: string
}

export interface DocEmailRequest {
  kind: string
  to: string
  /** 1 to `MAX_DOCS_PER_MAIL`. */
  items: DocEmailItem[]
  subject?: string
  message?: string
  locale?: string
  /** The line columns of a printed invoice, as the person's „Печат" has them. Other kinds ignore it. */
  columns?: string[]
}

export type DocEmailStatus = 'sent' | 'queued' | 'skipped' | 'failed'

export interface DocEmailResult {
  id: string
  groupId?: string
  number: string
  status: DocEmailStatus
  /** A `DocEmailSkip` when skipped, a `DocEmailFailure` when failed. */
  reason?: DocEmailSkip | DocEmailFailure
  /** The server's own words for a failure (the renderer's, the provider's). */
  message?: string
}

export interface DocEmailAnswer {
  to: string
  /** Mails that left, or were queued. */
  mails: number
  /** On an organization's own server a mail waits for lgrai.app (FR-20.86): queued, never said to be sent. */
  queued: boolean
  results: DocEmailResult[]
}

// ── The dialog's two ways to address a batch ─────────────────────────────────────────────────────

/** `data-partner` and the address map's key for the documents that have no partner. */
export const NO_PARTNER = 'none'

export interface DocEmailRecipientGroup {
  /** The partner's id, or `NO_PARTNER`. */
  key: string
  partner?: DocEmailPartner
  /** The address the line starts with: the partner card's, or none. */
  email: string
  rows: DocEmailPreviewRow[]
}

export function sendableRows(rows: readonly DocEmailPreviewRow[]): DocEmailPreviewRow[] {
  return rows.filter(r => !r.blocked)
}

/**
 * „До клиента / доставчика": a line per partner, in the order their first document was ticked, and the documents
 * with no partner last, in a line of their own. Blocked rows are in no line.
 */
export function groupByPartner(rows: readonly DocEmailPreviewRow[]): DocEmailRecipientGroup[] {
  const groups = new Map<string, DocEmailRecipientGroup>()
  const orphans: DocEmailPreviewRow[] = []
  for (const row of sendableRows(rows)) {
    if (!row.partner?.id) {
      orphans.push(row)
      continue
    }
    const had = groups.get(row.partner.id)
    if (had) had.rows.push(row)
    else groups.set(row.partner.id, { key: row.partner.id, partner: row.partner, email: (row.partner.email ?? '').trim(), rows: [row] })
  }
  const out = [...groups.values()]
  if (orphans.length) out.push({ key: NO_PARTNER, email: '', rows: orphans })
  return out
}

export interface DocEmailPlanEntry {
  to: string
  rows: DocEmailPreviewRow[]
}

export interface DocEmailPlan {
  /** One entry per ADDRESS: two lines typed to the same address share its mails. */
  entries: DocEmailPlanEntry[]
  /** Sendable documents whose line has no address: they stay behind. */
  unaddressed: DocEmailPreviewRow[]
  /** Keys of the lines whose address is typed and is no address: the dialog does not send while there is one. */
  invalid: string[]
}

/** The plan of the partner mode, from each line's address as it stands in the dialog (`addresses[group.key]`). */
export function planByPartner(groups: readonly DocEmailRecipientGroup[], addresses: Readonly<Record<string, string | undefined>>): DocEmailPlan {
  const entries = new Map<string, DocEmailPlanEntry>()
  const unaddressed: DocEmailPreviewRow[] = []
  const invalid: string[] = []
  for (const group of groups) {
    const to = String(addresses[group.key] ?? '').trim()
    if (!to) {
      unaddressed.push(...group.rows)
      continue
    }
    if (!isValidRecipient(to)) {
      invalid.push(group.key)
      continue
    }
    // An address is one recipient however it is capitalised; the first spelling typed is the one mailed.
    const key = to.toLowerCase()
    const had = entries.get(key)
    if (had) had.rows.push(...group.rows)
    else entries.set(key, { to, rows: [...group.rows] })
  }
  return { entries: [...entries.values()], unaddressed, invalid }
}

/** The key the one-address mode reports an invalid address under. */
export const SINGLE_ADDRESS = 'single'

/** „До един адрес": every sendable document to the one address typed. */
export function planForOneAddress(rows: readonly DocEmailPreviewRow[], address: string | undefined): DocEmailPlan {
  const sendable = sendableRows(rows)
  const to = String(address ?? '').trim()
  if (!to) return { entries: [], unaddressed: sendable, invalid: [] }
  if (!isValidRecipient(to)) return { entries: [], unaddressed: [], invalid: [SINGLE_ADDRESS] }
  return { entries: sendable.length ? [{ to, rows: sendable }] : [], unaddressed: [], invalid: [] }
}

/** A recipient's requests: its documents, at most `size` to a request, in their order. */
export function chunkDocuments<T>(items: readonly T[], size: number = MAX_DOCS_PER_MAIL): T[][] {
  const step = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step))
  return out
}

/** How many documents a plan mails, and to how many addresses: what the dialog's button says. */
export function planTotals(plan: DocEmailPlan): { documents: number; recipients: number; requests: number } {
  return {
    documents: plan.entries.reduce((n, e) => n + e.rows.length, 0),
    recipients: plan.entries.length,
    requests: plan.entries.reduce((n, e) => n + chunkDocuments(e.rows).length, 0),
  }
}

/** Did this document go: sent, or queued on a server that mails through lgrai.app. */
export function wentOut(result: Pick<DocEmailResult, 'status'>): boolean {
  return result.status === 'sent' || result.status === 'queued'
}

/**
 * The ticked ids that leave the selection after a batch: those whose every sendable row went. A supplier order of two
 * groups where one sheet failed stays ticked, so the person can try it again.
 */
export function idsThatWent(rows: readonly DocEmailPreviewRow[], results: readonly DocEmailResult[]): string[] {
  const key = (r: { id: string; groupId?: string }) => `${r.id}:${r.groupId ?? ''}`
  const went = new Set(results.filter(wentOut).map(key))
  const byId = new Map<string, boolean>()
  for (const row of sendableRows(rows)) byId.set(row.id, (byId.get(row.id) ?? true) && went.has(key(row)))
  return [...byId.entries()].filter(([, all]) => all).map(([id]) => id)
}
