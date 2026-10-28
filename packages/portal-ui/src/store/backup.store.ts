import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { downloadAsSession } from 'ui-shared/composables/useSessionDownload'
import { useAppStore } from './app.store'

/**
 * FR-13.27–13.37 (#24) — the state behind `admin/backup`.
 *
 * ⚠ Nothing here is a security control. Portal routes carry no client-side role gating, so a
 * signed-in user can type `/admin/backup` and this store will happily call every endpoint;
 * `sysAdmin` below only decides what is worth SHOWING. The server's `requireSysAdmin`
 * allow-list is the whole of the authorisation, and every method here expects to be refused.
 *
 * Method names mirror the desktop shell's Tauri commands (`archive.rs`: `create_archive`,
 * `restore_archive`, `list_archives`, …) per FR-13.28, so `desktop-ui` can later be pointed at
 * this same view rather than growing a second, divergent one.
 */
export const useBackupStore = defineStore('backup', () => {
  const appStore = useAppStore()

  const runs = ref<any[]>([])
  const restores = ref<any[]>([])
  /** Whether the server would let this caller use §5.7 at all. Presentation only. */
  const sysAdmin = ref(false)
  /** False when `BACKUP_SYS_ADMINS` is unset on the server — nobody can, not just this user. */
  const configured = ref(false)
  const loading = ref(false)
  const busy = ref(false)
  const error = ref('')
  /** The last Inspect, which is what authorises an apply (FR-13.33). */
  const inspection = ref<any>(null)
  const lastRestore = ref<any>(null)

  const orgId = () => appStore.currentOrg?.id
  const base = () => `/org/${orgId()}/backup`

  /** Every call funnels through here so a 403 renders as a message rather than a broken screen. */
  async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
    error.value = ''
    busy.value = true
    try {
      return await fn()
    } catch (e: any) {
      const d = e?.response?.data
      error.value = [d?.message, d?.detail].filter(Boolean).join(' — ') || e?.message || 'Request failed'
      return null
    } finally {
      busy.value = false
    }
  }

  async function checkAccess() {
    if (!orgId()) return
    try {
      const { data } = await httpClient.get(`${base()}/access`)
      sysAdmin.value = !!data.sysAdmin
      configured.value = !!data.configured
    } catch {
      sysAdmin.value = false
      configured.value = false
    }
  }

  async function listArchives() {
    if (!orgId()) return
    loading.value = true
    try {
      const { data } = await httpClient.get(`${base()}/runs`, { params: { size: 50 } })
      runs.value = data.runs || []
    } catch {
      runs.value = []
    } finally {
      loading.value = false
    }
  }

  async function listRestores() {
    if (!orgId() || !sysAdmin.value) return
    try {
      const { data } = await httpClient.get(`${base()}/restores`, { params: { size: 20 } })
      restores.value = data.runs || []
    } catch {
      restores.value = []
    }
  }

  /** FR-13.29 — dispatches a `BackgroundTask` and returns its id; it never blocks. */
  async function createArchive(variant: 'data' | 'full') {
    return guarded(async () => {
      const { data } = await httpClient.post(`${base()}/create`, { variant })
      return data
    })
  }

  async function taskStatus(taskId: string) {
    const { data } = await httpClient.get(`${base()}/task/${taskId}`)
    return data
  }

  /**
   * Download a bundle as THIS tab's session. A plain link would carry only the session cookie,
   * which names whichever org this browser entered last (multi-org sign-in: each tab has its own).
   */
  function download(runId: string) {
    return downloadAsSession(`${base()}/${runId}/download`, 'backup')
  }

  async function verifyArchive(runId: string) {
    return guarded(async () => {
      const { data } = await httpClient.get(`${base()}/${runId}/verify`)
      return data
    })
  }

  /** FR-13.30 — multipart, with the server's own size cap rather than `upload.maxFileSize`. */
  async function uploadBundle(file: File) {
    return guarded(async () => {
      const form = new FormData()
      form.append('file', file)
      const { data } = await httpClient.post(`${base()}/upload`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return data
    })
  }

  /** FR-13.33 — writes nothing; its result is the precondition for a writing restore. */
  async function inspect(source: { type: string; runId?: string; path?: string }) {
    inspection.value = null
    const data = await guarded(async () => {
      const { data } = await httpClient.post(`${base()}/restore/inspect`, { source })
      return data
    })
    if (data) inspection.value = data
    return data
  }

  async function restoreArchive(opts: {
    source: { type: string; runId?: string; path?: string }
    mode: 'merge' | 'replace'
    remap?: boolean
    confirmSlug?: string
    restoreFiles?: boolean
  }) {
    const data = await guarded(async () => {
      const { data } = await httpClient.post(`${base()}/restore/apply`, {
        ...opts,
        inspectionId: inspection.value?._id,
      })
      return data
    })
    if (data) {
      lastRestore.value = data
      // The screen must not keep offering an Inspect that has already been spent: a second
      // apply from the same result would be a second write nobody re-examined.
      inspection.value = null
      await listRestores()
      await listArchives()   // the safety bundle is new history too
    }
    return data
  }

  return {
    runs, restores, sysAdmin, configured, loading, busy, error, inspection, lastRestore,
    checkAccess, listArchives, listRestores, createArchive, taskStatus, download,
    verifyArchive, uploadBundle, inspect, restoreArchive,
  }
})
