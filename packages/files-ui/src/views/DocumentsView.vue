<template>
  <v-container>
    <div class="mb-4">
      <h1 class="text-h5 mb-1">{{ $t('files.documents.title') }}</h1>
      <p class="text-body-2 text-grey mb-0">{{ $t('files.documents.subtitle') }}</p>
    </div>

    <v-card variant="outlined" class="mb-3">
      <v-card-text class="d-flex flex-wrap ga-3">
        <v-text-field v-model="search" :label="$t('common.search')" prepend-inner-icon="mdi-magnify" density="compact" variant="outlined" hide-details clearable style="max-width: 240px" @update:model-value="reload" />
        <v-select v-model="docType" :items="typeItems" :label="$t('files.col.type')" density="compact" variant="outlined" hide-details clearable style="max-width: 200px" @update:model-value="reload" />
        <v-text-field v-model="docDate" :label="$t('files.col.date')" placeholder="YYYY-MM-DD" density="compact" variant="outlined" hide-details clearable style="max-width: 160px" @update:model-value="reload" />
        <v-spacer />
        <v-btn variant="text" icon="mdi-refresh" @click="reload" />
      </v-card-text>
    </v-card>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="total"
      :loading="loading"
      :items-per-page="size"
      :page="page + 1"
      density="compact"
      @update:options="onOptions"
    >
      <template #item.docType="{ item }"><v-chip size="x-small" label>{{ item.docType }}</v-chip></template>
      <template #item.status="{ item }"><v-chip size="x-small" :color="statusColor(item.status)" label>{{ item.status }}</v-chip></template>
      <template #item.version="{ item }">
        <v-btn v-if="item.version > 1" size="x-small" variant="tonal" @click="openVersions(item)">v{{ item.version }} · {{ $t('files.versions') }}</v-btn>
        <span v-else>v1</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(item)" target="_blank" />
      </template>
    </v-data-table-server>

    <v-dialog v-model="versionsOpen" max-width="640">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ $t('files.versions') }} — {{ activeDoc?.originalName }}</v-card-title>
        <v-list density="compact">
          <v-list-item v-if="versionData?.current" :title="`v${versionData.current.version} · ${versionData.current.name}`" :subtitle="$t('files.currentVersion')">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(activeDoc)" target="_blank" /></template>
          </v-list-item>
          <v-divider />
          <v-list-item v-for="v in versionData?.versions || []" :key="v.name" :title="v.name" :subtitle="new Date(v.archivedAt).toLocaleString()">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(activeDoc, v.name)" target="_blank" /></template>
          </v-list-item>
          <v-list-item v-if="!(versionData?.versions || []).length" :title="$t('files.noVersions')" />
        </v-list>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="versionsOpen = false">{{ $t('common.close') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const appStore = useAppStore()
const { showError } = useSnackbar()

const items = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(0)
const size = ref(25)
const search = ref('')
const docType = ref<string | null>(null)
const docDate = ref('')

const typeItems = ['invoice', 'cash_register', 'goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations', 'store_availability', 'unknown']
const headers = [
  { title: t('files.col.type'), key: 'docType' },
  { title: t('files.col.number'), key: 'docNumber' },
  { title: t('files.col.date'), key: 'docDate' },
  { title: t('files.col.status'), key: 'status' },
  { title: t('files.col.version'), key: 'version', sortable: false },
  { title: '', key: 'actions', sortable: false },
]

function statusColor(s: string) {
  return { uploaded: 'grey', extracted: 'info', analyzed: 'warning', committed: 'success', superseded: 'error' }[s] || 'grey'
}
function base() {
  const dev = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : '/api'
  return `${dev}${appStore.orgUrl()}/files`
}
function downloadUrl(item: any, version?: string) {
  const v = version ? `?version=${encodeURIComponent(version)}` : ''
  return `${base()}/${item.docFileId || item._id}/download${v}`
}

async function reload() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, {
      params: { page: page.value, size: size.value, search: search.value || undefined, docType: docType.value || undefined, docDate: docDate.value || undefined },
    })
    items.value = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
    total.value = data.total || 0
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

function onOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  size.value = opts.itemsPerPage || 25
  reload()
}

const versionsOpen = ref(false)
const activeDoc = ref<any>(null)
const versionData = ref<any>(null)
async function openVersions(item: any) {
  activeDoc.value = item
  versionsOpen.value = true
  versionData.value = null
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files/${item._id}/versions`)
    versionData.value = data
  } catch { /* ignore */ }
}

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
  reload()
})
</script>
