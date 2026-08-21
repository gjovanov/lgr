/**
 * Client for `/org/:orgId/doc-import/*` — upload → analyze → review → commit.
 *
 * Analysis and commit are background jobs (drafting runs a model at ~30s/document), so both
 * return a taskId that this composable follows. It polls rather than using the `/ws/tasks`
 * socket: nothing in the app connects that socket today, and at one update per document a
 * 1.5s poll is already finer-grained than the work being reported.
 */
import { computed, ref } from 'vue'
import { httpClient } from './useHttpClient'

export type ImportTarget = 'sales_invoice' | 'bill' | 'cash_sale' | 'movement'

export interface ExtractedFile {
  fileId: string
  filename: string
  kind: 'pdf' | 'xlsx' | 'unsupported'
  method?: string
  pages?: number
  chars: number
  text: string
  error?: string
}

export interface LineDiagnostic {
  sourceText: string
  matched: boolean
  productId?: string
  matchedBy: 'alias' | 'exact' | 'ws' | 'token' | 'ai' | null
  candidateNew?: { name: string; unit: string; cost: number; selling?: number; tiers: Record<string, number> }
}

export interface AnalyzedDoc {
  fileId: string
  filename: string
  docKind: string
  direction?: 'outgoing' | 'incoming'
  uncertain?: boolean
  validation?: { status: 'valid' | 'needs_review'; checks: any[] }
  duplicate?: { id: string; number: string; status?: string; reason: string }
  mapped?: any
  diagnostics: {
    perLine: LineDiagnostic[]
    contactSuggestion?: { name: string; eik?: string; vat?: string; address?: string; city?: string }
    warnings: string[]
  }
  error?: string
}

export interface CommitResult {
  fileId?: string
  ok: boolean
  id?: string
  number?: string
  issuedNumber?: string
  error?: string
}

/** Largest batch the server accepts — mirrors MAX_BATCH_FILES. */
export const MAX_IMPORT_FILES = 40

const POLL_MS = 1500
/** Generous: a 40-document batch drafts serially at roughly half a minute each. */
const POLL_MAX_MS = 45 * 60 * 1000

export function useDocImport(orgUrl: () => string) {
  const extracting = ref(false)
  const analyzing = ref(false)
  const committing = ref(false)
  const progress = ref(0)
  const statusText = ref('')
  const error = ref('')

  const extracted = ref<ExtractedFile[]>([])
  const analyzed = ref<AnalyzedDoc[]>([])
  const committed = ref<CommitResult[]>([])

  const busy = computed(() => extracting.value || analyzing.value || committing.value)
  const extractedOk = computed(() => extracted.value.filter(e => !e.error && e.text))

  function reset() {
    extracted.value = []
    analyzed.value = []
    committed.value = []
    progress.value = 0
    statusText.value = ''
    error.value = ''
  }

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const message = (e: any) => e?.response?.data?.message || String(e?.message || e)

  /** Upload files and pull their text out. Synchronous server-side — extraction is fast. */
  async function extract(files: File[], opts: { forceOcr?: boolean } = {}): Promise<ExtractedFile[]> {
    extracting.value = true
    error.value = ''
    try {
      const fd = new FormData()
      for (const f of files) fd.append('files', f)
      if (opts.forceOcr) fd.append('forceOcr', 'true')
      // Override the client's default application/json so the browser sets
      // multipart/form-data + boundary (otherwise the server can't parse the files).
      const { data } = await httpClient.post(`${orgUrl()}/doc-import/extract`, fd, {
        headers: { 'Content-Type': undefined },
      })
      extracted.value = data.files || []
      return extracted.value
    } catch (e: any) {
      error.value = message(e)
      throw e
    } finally {
      extracting.value = false
    }
  }

  /** Follow a background job to completion, mirroring its progress onto the refs. */
  async function waitForTask(taskId: string): Promise<any> {
    const deadline = Date.now() + POLL_MAX_MS
    for (;;) {
      await sleep(POLL_MS)
      const { data } = await httpClient.get(`${orgUrl()}/doc-import/task/${taskId}`)
      progress.value = data.progress ?? 0
      const lastLog = (data.logs || []).slice(-1)[0]
      if (lastLog) statusText.value = lastLog
      if (data.status === 'completed') return data.result
      if (data.status === 'failed') throw new Error(data.error || 'import job failed')
      if (Date.now() > deadline) throw new Error('import job timed out')
    }
  }

  /** Map the extracted text onto documents. Persists nothing — safe to run and walk away. */
  async function analyze(
    target: ImportTarget,
    items: Array<{ fileId: string; filename?: string; text?: string; parsed?: any; profile?: string }>,
    context: Record<string, any> = {},
    options: Record<string, any> = {},
  ): Promise<AnalyzedDoc[]> {
    analyzing.value = true
    error.value = ''
    progress.value = 0
    try {
      const { data } = await httpClient.post(`${orgUrl()}/doc-import/analyze`, { target, items, context, options })
      const result = await waitForTask(data.taskId)
      analyzed.value = result?.results || []
      return analyzed.value
    } catch (e: any) {
      error.value = message(e)
      throw e
    } finally {
      analyzing.value = false
    }
  }

  /** Write the reviewed mappings. */
  async function commit(
    target: ImportTarget,
    items: Array<{ fileId?: string; mapped: any; options?: Record<string, any> }>,
  ): Promise<CommitResult[]> {
    committing.value = true
    error.value = ''
    progress.value = 0
    try {
      const { data } = await httpClient.post(`${orgUrl()}/doc-import/commit`, { target, items })
      const result = await waitForTask(data.taskId)
      committed.value = result?.results || []
      return committed.value
    } catch (e: any) {
      error.value = message(e)
      throw e
    } finally {
      committing.value = false
    }
  }

  /** Issue committed drafts (or confirm movements). */
  async function convert(target: ImportTarget, ids: string[], adjustStock = true): Promise<CommitResult[]> {
    const { data } = await httpClient.post(`${orgUrl()}/doc-import/convert`, { target, ids, adjustStock })
    return data.results || []
  }

  return {
    extracting, analyzing, committing, busy, progress, statusText, error,
    extracted, extractedOk, analyzed, committed,
    reset, extract, analyze, commit, convert,
  }
}
