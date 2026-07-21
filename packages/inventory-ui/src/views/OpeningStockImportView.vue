<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <v-icon icon="mdi-database-import-outline" class="mr-2" />
      <h2 class="text-h5">{{ $t('openingStock.title') }}</h2>
    </div>

    <v-card flat class="pa-4" max-width="820">
      <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('openingStock.intro') }}</p>
      <v-row>
        <v-col cols="12" md="5">
          <v-select
            v-model="warehouseId"
            :items="warehouses"
            item-title="name"
            item-value="_id"
            :label="$t('openingStock.warehouse')"
            variant="outlined"
            density="comfortable"
          />
        </v-col>
        <v-col cols="12" md="7">
          <v-file-input
            v-model="file"
            :label="$t('openingStock.selectFile')"
            accept=".xlsx"
            prepend-icon="mdi-file-excel"
            show-size
            variant="outlined"
            density="comfortable"
          />
        </v-col>
      </v-row>

      <v-btn color="primary" :loading="running" :disabled="!warehouseId || !file" prepend-icon="mdi-upload" @click="doImport">
        {{ $t('openingStock.import') }}
      </v-btn>

      <div v-if="running" class="mt-4">
        <v-progress-linear :model-value="progress" color="primary" height="8" rounded />
        <p class="text-caption text-medium-emphasis mt-1">{{ statusText }}</p>
      </div>

      <v-alert v-if="result" type="success" variant="tonal" class="mt-4" density="comfortable">
        <div><strong>{{ $t('openingStock.done') }}</strong></div>
        <div class="text-body-2 mt-1">
          {{ $t('openingStock.summary', { rows: result.rows, matched: result.matched, adjusted: result.adjusted, unmatched: result.unmatched }) }}
        </div>
        <div v-if="result.movementNumber" class="text-caption mt-1">{{ $t('openingStock.movement') }}: {{ result.movementNumber }}</div>
        <div v-if="result.unmatchedSamples?.length" class="text-caption mt-2">
          {{ $t('openingStock.unmatchedSamples') }}: {{ result.unmatchedSamples.slice(0, 10).join(', ') }}{{ result.unmatched > 10 ? '…' : '' }}
        </div>
      </v-alert>
      <v-alert v-if="errorMsg" type="error" variant="tonal" class="mt-4" density="comfortable">{{ errorMsg }}</v-alert>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const appStore = useAppStore()
const { showError } = useSnackbar()

const warehouses = ref<{ _id: string; name: string }[]>([])
const warehouseId = ref('')
const file = ref<File | File[] | null>(null)
const running = ref(false)
const progress = ref(0)
const statusText = ref('')
const result = ref<any>(null)
const errorMsg = ref('')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

onMounted(async () => {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`)
    warehouses.value = data.warehouses || data.data || []
    const def = warehouses.value.find((w: any) => w.isDefault) || warehouses.value[0]
    if (def) warehouseId.value = def._id
  } catch { /* ignore */ }
})

async function doImport() {
  running.value = true
  result.value = null
  errorMsg.value = ''
  progress.value = 0
  statusText.value = t('openingStock.uploading')
  try {
    const f = Array.isArray(file.value) ? file.value[0] : file.value
    const fd = new FormData()
    fd.append('file', f as File)
    fd.append('warehouseId', warehouseId.value)
    const { data } = await httpClient.post(`${appStore.orgUrl()}/warehouse/opening-stock`, fd, {
      headers: { 'Content-Type': undefined },
    })
    const taskId = data.taskId
    for (let i = 0; i < 600; i++) {
      await sleep(2000)
      const { data: s } = await httpClient.get(`${appStore.orgUrl()}/warehouse/opening-stock/status/${taskId}`)
      progress.value = s.progress ?? 0
      statusText.value = t('openingStock.processing', { rows: data.rows })
      if (s.status === 'completed') { result.value = s.result; break }
      if (s.status === 'failed') { errorMsg.value = s.error || 'failed'; break }
    }
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.message || String(e)
    showError(errorMsg.value)
  } finally {
    running.value = false
  }
}
</script>
