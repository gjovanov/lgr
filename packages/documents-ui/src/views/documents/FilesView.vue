<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" :to="{ name: 'documents.workspaces' }" />
      <h1 class="text-h5 ml-2">{{ $t('documents.files') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-upload" @click="openUpload">{{ $t('documents.upload') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" @update:model-value="debounceFetch" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="archivedFilter" :label="$t('documents.showArchived')" :items="archivedOptions" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="total"
          :loading="store.loading"
          :page="page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.mimeType="{ item }">
            <v-icon :color="mimeColor(item.mimeType)">{{ mimeIcon(item.mimeType) }}</v-icon>
            <span class="ml-1 text-caption">{{ item.mimeType }}</span>
          </template>
          <template #item.size="{ item }">{{ formatSize(item.size) }}</template>
          <template #item.tags="{ item }">
            <v-chip v-for="tag in (item.tags || []).slice(0, 3)" :key="tag" size="x-small" class="mr-1">{{ tag }}</v-chip>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-share-variant" size="small" variant="text" color="info" :title="$t('documents.share')" @click="openShare(item)" />
            <v-btn icon="mdi-archive" size="small" variant="text" :color="item.isArchived ? 'success' : 'warning'" :title="item.isArchived ? $t('documents.unarchive') : $t('documents.archive')" @click="toggleArchive(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Upload Dialog (metadata) -->
    <v-dialog v-model="uploadDialog" max-width="500">
      <v-card>
        <v-card-title>{{ $t('documents.upload') }}</v-card-title>
        <v-card-text>
          <v-form ref="uploadFormRef">
            <v-text-field v-model="uploadForm.name" :label="$t('common.name')" :rules="[v => !!v || $t('required')]" />
            <v-text-field v-model="uploadForm.fileId" :label="$t('documents.fileId')" :rules="[v => !!v || $t('required')]" />
            <v-text-field v-model="uploadForm.mimeType" :label="$t('documents.mimeType')" :rules="[v => !!v || $t('required')]" />
            <v-text-field v-model.number="uploadForm.size" :label="$t('documents.size')" type="number" :rules="[v => v >= 0 || $t('required')]" />
            <v-text-field v-model="uploadForm.notes" :label="$t('common.notes')" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="uploadDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="doUpload">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Share Dialog -->
    <v-dialog v-model="shareDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('documents.share') }}</v-card-title>
        <v-card-text>
          <v-form ref="shareFormRef">
            <v-text-field v-model="shareForm.userId" :label="$t('documents.userId')" :rules="[v => !!v || $t('required')]" />
            <v-select v-model="shareForm.permission" :label="$t('documents.permission')" :items="['view', 'edit', 'admin']" :rules="[v => !!v || $t('required')]" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="shareDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="doShare">{{ $t('documents.share') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDocumentsStore, type Document } from '../../store/documents.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const route = useRoute()
const store = useDocumentsStore()
const { showSuccess, showError } = useSnackbar()

const workspaceId = computed(() => route.params.workspaceId as string)
const search = ref('')
const archivedFilter = ref<string | null>(null)
const archivedOptions = [
  { title: 'All', value: 'all' },
  { title: 'Active only', value: 'false' },
  { title: 'Archived only', value: 'true' },
]
const items = ref<Document[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)

const uploadDialog = ref(false)
const uploadFormRef = ref()
const uploadForm = ref({ name: '', fileId: '', mimeType: '', size: 0, notes: '' })

const shareDialog = ref(false)
const shareFormRef = ref()
const shareForm = ref({ userId: '', permission: 'view' })
const shareDocId = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | null = null

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('documents.mimeType'), key: 'mimeType', sortable: true },
  { title: t('documents.size'), key: 'size', sortable: true, align: 'end' as const },
  { title: t('documents.version'), key: 'version', align: 'center' as const },
  { title: t('documents.owner'), key: 'ownerName' },
  { title: t('common.tags'), key: 'tags', sortable: false },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function mimeIcon(mime: string) {
  if (mime?.startsWith('image/')) return 'mdi-file-image'
  if (mime?.includes('pdf')) return 'mdi-file-pdf-box'
  if (mime?.includes('spreadsheet') || mime?.includes('excel')) return 'mdi-file-excel'
  if (mime?.includes('word') || mime?.includes('document')) return 'mdi-file-word'
  return 'mdi-file'
}

function mimeColor(mime: string) {
  if (mime?.startsWith('image/')) return 'purple'
  if (mime?.includes('pdf')) return 'red'
  if (mime?.includes('spreadsheet') || mime?.includes('excel')) return 'green'
  if (mime?.includes('word') || mime?.includes('document')) return 'blue'
  return 'grey'
}

function formatSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(1)} ${units[i]}`
}

async function fetchFiles() {
  const params: Record<string, any> = {
    workspaceId: workspaceId.value,
    page: page.value,
    size: pageSize.value,
  }
  if (search.value) params.search = search.value
  if (archivedFilter.value && archivedFilter.value !== 'all') params.isArchived = archivedFilter.value

  const data = await store.fetchDocuments(params)
  items.value = store.documents
  total.value = data?.total || 0
}

function debounceFetch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { page.value = 0; fetchFiles() }, 300)
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 10
  fetchFiles()
}

function openUpload() {
  uploadForm.value = { name: '', fileId: '', mimeType: '', size: 0, notes: '' }
  uploadDialog.value = true
}

async function doUpload() {
  const { valid } = await uploadFormRef.value.validate()
  if (!valid) return
  try {
    await store.createDocument({
      ...uploadForm.value,
      workspaceId: workspaceId.value,
    } as any)
    uploadDialog.value = false
    showSuccess(t('common.createdSuccessfully'))
    await fetchFiles()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function openShare(doc: Document) {
  shareDocId.value = doc._id
  shareForm.value = { userId: '', permission: 'view' }
  shareDialog.value = true
}

async function doShare() {
  const { valid } = await shareFormRef.value.validate()
  if (!valid) return
  try {
    await store.shareDocument(shareDocId.value, shareForm.value.userId, shareForm.value.permission)
    shareDialog.value = false
    showSuccess(t('documents.sharedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function toggleArchive(doc: Document) {
  try {
    await store.archiveDocument(doc._id)
    showSuccess(doc.isArchived ? t('documents.unarchived') : t('documents.archived'))
    await fetchFiles()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchFiles() })
</script>
