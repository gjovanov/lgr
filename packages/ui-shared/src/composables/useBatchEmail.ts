import { computed, reactive, ref } from 'vue'
import {
  DOC_EMAIL_FAILURES, NO_PARTNER, chunkDocuments, groupByPartner, idsThatWent, planByPartner, planForOneAddress, planTotals,
  sendableRows, wentOut,
  type DocEmailAnswer, type DocEmailFailure, type DocEmailPlan, type DocEmailPreviewAnswer, type DocEmailPreviewRow,
  type DocEmailRecipientGroup, type DocEmailRequest, type DocEmailResult,
} from 'config/doc-email'
import { httpClient } from './useHttpClient'
import { rememberedSetting } from './useUserDefaults'

/**
 * E-mailing a list's ticked documents (2026-11-16): everything `BatchEmailDialog` knows and does, without its words.
 *
 * Generic over the KIND of document. A kind is a name and two endpoints relative to the org's URL, a preview and the
 * mail request, and every kind speaks `config/doc-email`'s wire types. Nothing here knows an invoice from a supplier
 * order's sheet: a new kind (a stock movement's document) brings its two routes and is served as it is.
 *
 * - `open(ids)` asks the preview what will go and what will not, and seeds the two ways to address the batch:
 *   „До клиента / доставчика" (a line per partner, its card's address filled in) and „До един адрес" (the address
 *   this person used last time for this kind, in this organization).
 * - `send()` mails ONE recipient per request, at most `MAX_DOCS_PER_MAIL` documents to a request, one request after
 *   the other, so the progress is true and a refusal that concerns the whole batch can stop the rest.
 *
 * ⚠ The one address is remembered only after a mail to it has gone: a typo that bounced is not what the field
 * should start with next time.
 */

export type BatchEmailMode = 'partner' | 'single'
/** `idle`: not open. `loading`: the preview is on its way. `compose`, `sending`, then `done`: the results. */
export type BatchEmailPhase = 'idle' | 'loading' | 'compose' | 'sending' | 'done'

/** What became of one recipient's documents. */
export interface BatchEmailRecipientResult {
  to: string
  /**
   * One per document asked of this recipient: the server's own row, or, for a request that was refused or never
   * left, a row made here (`failed` with the server's words, and its `code` as the reason when that is one a
   * document can fail on; `skipped` without a reason when the batch had stopped).
   */
  results: DocEmailResult[]
  /** A mail of this recipient waits for lgrai.app (an organization's own server, FR-20.86). */
  queued: boolean
}

export interface BatchEmailOutcome {
  /** The ticked ids whose every document went: they leave the list's selection. */
  went: string[]
  /** How many documents went, and to how many addresses. */
  documents: number
  recipients: number
  queued: boolean
  /** Everything that was asked went: the dialog has nothing left to say. */
  allFine: boolean
}

export interface BatchEmailOptions {
  /** The kind as its endpoints take it: `invoice`, `order`… */
  kind: () => string
  /** The org's API root (`/org/<id>`). */
  orgUrl: () => string
  /** The kind's two endpoints, relative to the org's URL. */
  previewPath: () => string
  emailPath: () => string
  locale?: () => string | undefined
  /** For a kind whose print has columns (an invoice): the person's own. Read when the batch leaves. */
  columns?: () => string[] | undefined
  /** What the subject starts as, from the documents that will go. */
  defaultSubject?: (sendable: DocEmailPreviewRow[]) => string
  /** The request itself, so a test can stand in for the server. */
  post?: <T>(url: string, body: unknown) => Promise<{ data: T }>
  /** Where the one address is remembered, so a test can stand in for the browser. */
  remembered?: { read(): string | null; write(value: string): void }
}

/**
 * A refusal that is about the whole batch, never about one recipient: mail is not set up on this server, the session
 * is gone, the role does not mail this kind, or the organization is not written here. Asking again for the next
 * recipient would be told the same, so the rest is not asked.
 */
export function stopsTheBatch(error: any): boolean {
  const status = error?.response?.status
  if (status === 401 || status === 403 || status === 409) return true
  return status === 503 && error?.response?.data?.code === 'not_configured'
}

/**
 * A run of document numbers, cut for reading: all of a few, or the first ones and how many more there are. A hundred
 * ticked drafts are one line of the dialog, not a wall of numbers.
 */
export function shortList(numbers: readonly string[], max = 6): { shown: string[]; more: number } {
  if (numbers.length <= max) return { shown: [...numbers], more: 0 }
  return { shown: numbers.slice(0, max - 1), more: numbers.length - (max - 1) }
}

/**
 * A refused request's `code`, when it is one of the reasons a single document can fail on (`not_configured`): its
 * rows then read in the reader's language, as the same failure reads when the server reports it per document.
 */
function failureOf(error: any): DocEmailFailure | undefined {
  const code = error?.response?.data?.code
  return (DOC_EMAIL_FAILURES as readonly string[]).includes(code) ? code : undefined
}

export function useBatchEmail(options: BatchEmailOptions) {
  const post = options.post ?? (<T>(url: string, body: unknown) => httpClient.post<T>(url, body))
  /** Per kind, as well as per user and org: an accountant's address for bills is not where sales invoices go. */
  const remembered = () => options.remembered ?? rememberedSetting<string>(`doc-email-to-${options.kind()}`)

  const phase = ref<BatchEmailPhase>('idle')
  /** The preview was refused, and the server's words for it (none when it did not answer at all). */
  const loadFailed = ref(false)
  const loadError = ref('')
  const rows = ref<DocEmailPreviewRow[]>([])

  const mode = ref<BatchEmailMode>('partner')
  /** The address of each partner line as it stands, by `group.key`. */
  const addresses = reactive<Record<string, string>>({})
  const singleTo = ref('')
  const subject = ref('')
  const message = ref('')

  const progress = reactive({ done: 0, total: 0 })
  const results = ref<BatchEmailRecipientResult[]>([])
  /** A refusal stopped the batch, and the server's words for it. */
  const halted = ref(false)
  const stopped = ref('')

  const sendable = computed(() => sendableRows(rows.value))
  const blocked = computed(() => rows.value.filter(r => r.blocked))
  const groups = computed<DocEmailRecipientGroup[]>(() => groupByPartner(rows.value))
  /** At least one document that will go has a customer or a supplier: the partner mode has someone to address. */
  const hasPartner = computed(() => groups.value.some(g => g.key !== NO_PARTNER))

  const plan = computed<DocEmailPlan>(() =>
    mode.value === 'partner' ? planByPartner(groups.value, addresses) : planForOneAddress(rows.value, singleTo.value))
  const totals = computed(() => planTotals(plan.value))
  const canSend = computed(() => phase.value === 'compose' && !loadFailed.value && totals.value.documents > 0 && plan.value.invalid.length === 0)

  const url = (path: string) => `${options.orgUrl()}${path}`
  const said = (error: any): string => String(error?.response?.data?.message || error?.message || '')

  /** A dialog closed and opened again while its preview was still on its way keeps the later answer only. */
  let asked = 0

  function reset() {
    loadFailed.value = false
    loadError.value = ''
    rows.value = []
    for (const key of Object.keys(addresses)) delete addresses[key]
    singleTo.value = ''
    subject.value = ''
    message.value = ''
    progress.done = 0
    progress.total = 0
    results.value = []
    halted.value = false
    stopped.value = ''
  }

  async function open(ids: readonly string[]): Promise<void> {
    const mine = ++asked
    reset()
    phase.value = 'loading'
    try {
      const { data } = await post<DocEmailPreviewAnswer>(url(options.previewPath()), { kind: options.kind(), ids: [...ids] })
      if (mine !== asked) return
      rows.value = Array.isArray(data?.documents) ? data.documents : []
      for (const group of groups.value) addresses[group.key] = group.email
      mode.value = hasPartner.value ? 'partner' : 'single'
      singleTo.value = String(remembered().read() ?? '')
      subject.value = options.defaultSubject?.(sendable.value) ?? ''
    } catch (error: any) {
      if (mine !== asked) return
      loadFailed.value = true
      loadError.value = said(error)
    }
    phase.value = 'compose'
  }

  function close() {
    asked++
    phase.value = 'idle'
  }

  /**
   * Mails the batch as the dialog stands. Resolves with what went, once every request has been answered, refused,
   * or left unasked because a refusal stopped the batch.
   */
  async function send(): Promise<BatchEmailOutcome | null> {
    if (!canSend.value) return null
    const entries = plan.value.entries
    const single = mode.value === 'single'
    const requests = entries.flatMap(entry => chunkDocuments(entry.rows).map(chunk => ({ to: entry.to, rows: chunk })))
    const byRecipient = new Map<string, BatchEmailRecipientResult>(entries.map(e => [e.to, { to: e.to, results: [], queued: false }]))
    const shared: Pick<DocEmailRequest, 'subject' | 'message' | 'locale' | 'columns'> = {
      subject: subject.value.trim() || undefined,
      message: message.value.trim() || undefined,
      locale: options.locale?.(),
      columns: options.columns?.(),
    }

    phase.value = 'sending'
    progress.done = 0
    progress.total = requests.length
    halted.value = false
    stopped.value = ''

    for (const request of requests) {
      const recipient = byRecipient.get(request.to)!
      const made = (status: 'failed' | 'skipped', why?: string, reason?: DocEmailFailure): DocEmailResult[] =>
        request.rows.map(r => ({
          id: r.id, ...(r.groupId ? { groupId: r.groupId } : {}), number: r.number, status,
          ...(reason ? { reason } : {}), ...(why ? { message: why } : {}),
        }))
      if (halted.value) {
        recipient.results.push(...made('skipped'))
        progress.done++
        continue
      }
      try {
        const body: DocEmailRequest = {
          kind: options.kind(),
          to: request.to,
          items: request.rows.map(r => ({ id: r.id, ...(r.groupId ? { groupId: r.groupId } : {}) })),
          ...shared,
        }
        const { data } = await post<DocEmailAnswer>(url(options.emailPath()), body)
        recipient.results.push(...(Array.isArray(data?.results) ? data.results : []))
        if (data?.queued) recipient.queued = true
      } catch (error: any) {
        recipient.results.push(...made('failed', said(error), failureOf(error)))
        if (stopsTheBatch(error)) {
          halted.value = true
          stopped.value = said(error)
        }
      }
      progress.done++
    }

    const recipients = [...byRecipient.values()]
    const all = recipients.flatMap(r => r.results)
    const went = all.filter(wentOut)
    if (single && went.length) remembered().write(singleTo.value.trim())

    results.value = recipients
    phase.value = 'done'
    return {
      went: idsThatWent(rows.value, all),
      documents: went.length,
      recipients: recipients.filter(r => r.results.some(wentOut)).length,
      queued: recipients.some(r => r.queued),
      allFine: all.length > 0 && all.length === went.length,
    }
  }

  return {
    phase, loadFailed, loadError, rows, sendable, blocked, groups, hasPartner,
    mode, addresses, singleTo, subject, message,
    plan, totals, canSend,
    progress, results, halted, stopped,
    open, close, send,
  }
}
