<template>
  <v-container>
    <HubPageHeader
      :title="$t('files.audit.title')"
      :subtitle="$t('files.audit.subtitle')"
      :back-label="$t('files.backToHub')"
    >
      <template #actions>
        <v-btn-toggle v-model="detailed" mandatory density="compact" variant="outlined">
          <v-btn :value="false" size="small">{{ $t('files.audit.compact') }}</v-btn>
          <v-btn :value="true" size="small">{{ $t('files.audit.detailed') }}</v-btn>
        </v-btn-toggle>
      </template>
    </HubPageHeader>

    <v-card variant="outlined" class="mb-3">
      <v-card-text class="d-flex flex-wrap ga-3">
        <v-select v-model="action" :items="actionItems" :label="$t('files.col.action')" density="compact" variant="outlined" hide-details clearable style="max-width: 200px" @update:model-value="reload" />
        <v-text-field v-model="dateFrom" type="date" :label="$t('files.audit.from')" density="compact" variant="outlined" hide-details clearable style="max-width: 180px" @update:model-value="reload" />
        <v-text-field v-model="dateTo" type="date" :label="$t('files.audit.to')" density="compact" variant="outlined" hide-details clearable style="max-width: 180px" @update:model-value="reload" />
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
      :show-expand="detailed"
      v-model:expanded="expanded"
      item-value="_id"
      @update:options="onOptions"
    >
      <template #item.timestamp="{ item }">{{ new Date(item.timestamp).toLocaleString() }}</template>
      <template #item.action="{ item }"><v-chip size="x-small" :color="actionColor(item.action)" label>{{ item.action }}</v-chip></template>
      <template #item.actor="{ item }">{{ actorName(item) }}</template>
      <template #expanded-row="{ columns, item }">
        <tr>
          <td :colspan="columns.length" class="pa-3">
            <div v-if="(item.changes || []).length">
              <div v-for="(c, i) in item.changes" :key="i" class="text-caption">
                <strong>{{ c.field }}</strong>: <span class="text-grey">{{ fmt(c.oldValue) }}</span> → {{ fmt(c.newValue) }}
              </div>
            </div>
            <div v-else class="text-caption text-grey">{{ $t('files.audit.noChanges') }}</div>
          </td>
        </tr>
      </template>
    </v-data-table-server>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import HubPageHeader from 'ui-shell/components/HubPageHeader'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const appStore = useAppStore()
const { showError } = useSnackbar()

const items = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(0)
const size = ref(25)
const detailed = ref(false)
const expanded = ref<string[]>([])
const action = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

const actionItems = ['upload', 'overwrite', 'ocr', 'analyze', 'commit', 'reconcile', 'delete']
const headers = computed(() => [
  { title: t('files.col.time'), key: 'timestamp' },
  { title: t('files.col.action'), key: 'action' },
  { title: t('files.col.document'), key: 'entityName' },
  { title: t('files.col.actor'), key: 'actor', sortable: false },
])

function actionColor(a: string) {
  return { upload: 'success', overwrite: 'warning', delete: 'error', commit: 'primary', reconcile: 'deep-purple', analyze: 'info', ocr: 'grey' }[a] || 'grey'
}
function actorName(item: any) {
  const u = item.user || item.userId
  if (u && typeof u === 'object') return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.email || ''
  return item.operatorCode || ''
}
function fmt(v: any) { return v === null || v === undefined ? '∅' : String(v) }

async function reload() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files/audit`, {
      params: { page: page.value, size: size.value, action: action.value || undefined, dateFrom: dateFrom.value || undefined, dateTo: dateTo.value || undefined },
    })
    items.value = data.logs || data.auditLogs || data.data || []
    total.value = data.total || items.value.length
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}
function onOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  size.value = opts.itemsPerPage || 25
  reload()
}

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
  reload()
})
</script>
