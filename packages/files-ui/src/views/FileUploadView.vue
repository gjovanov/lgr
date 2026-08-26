<template>
  <v-container>
    <div class="mb-4 d-flex align-center">
      <div>
        <h1 class="text-h5 mb-1">{{ $t('files.upload.title') }}</h1>
        <p class="text-body-2 text-grey mb-0">{{ $t('files.upload.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-file-document-multiple" @click="router.push({ name: 'files.documents' })">
        {{ $t('files.documents.title') }}
      </v-btn>
    </div>

    <v-card variant="outlined" class="mb-4">
      <v-card-text>
        <v-file-input
          v-model="files"
          :label="$t('files.upload.pick')"
          prepend-icon="mdi-paperclip"
          multiple
          chips
          counter
          show-size
          accept=".pdf,.xlsx"
          :disabled="uploading"
        />
        <div class="d-flex align-center">
          <span class="text-caption text-grey">{{ $t('files.upload.hint') }}</span>
          <v-spacer />
          <v-btn color="primary" :loading="uploading" :disabled="!files.length" prepend-icon="mdi-cloud-upload" @click="doUpload">
            {{ $t('files.upload.action') }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-card v-if="results.length" variant="outlined">
      <v-card-title class="text-subtitle-1">{{ $t('files.upload.results') }}</v-card-title>
      <v-data-table
        :headers="headers"
        :items="results"
        density="compact"
        :items-per-page="-1"
        hide-default-footer
      >
        <template #item.docType="{ item }"><v-chip size="x-small" label>{{ item.docType }}</v-chip></template>
        <template #item.docDate="{ item }">{{ item.docDate || $t('files.upload.inbox') }}</template>
        <template #item.outcome="{ item }">
          <v-chip size="x-small" :color="outcomeColor(item.outcome)" label>{{ item.outcome }}</v-chip>
        </template>
      </v-data-table>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const files = ref<File[]>([])
const uploading = ref(false)
const results = ref<any[]>([])

const headers = [
  { title: t('files.col.name'), key: 'name' },
  { title: t('files.col.type'), key: 'docType' },
  { title: t('files.col.number'), key: 'docNumber' },
  { title: t('files.col.date'), key: 'docDate' },
  { title: t('files.col.version'), key: 'version' },
  { title: t('files.col.outcome'), key: 'outcome' },
]

function outcomeColor(o: string) {
  if (o === 'created') return 'success'
  if (o === 'duplicate') return 'grey'
  return 'warning' // overwrote vN
}

async function doUpload() {
  if (!files.value.length) return
  uploading.value = true
  try {
    const fd = new FormData()
    for (const f of files.value) fd.append('files', f)
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/upload`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    results.value = data.results
    showSuccess(t('files.upload.done', { n: data.results.length }))
    files.value = []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    uploading.value = false
  }
}
</script>
