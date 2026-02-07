<template>
  <div>
    <v-file-input
      v-model="files"
      :label="label || $t('common.uploadFiles')"
      :accept="accept"
      :multiple="multiple"
      prepend-icon="mdi-paperclip"
      show-size
      @update:model-value="onFilesChanged"
    />
    <v-progress-linear v-if="uploading" :model-value="progress" color="primary" class="mt-2" />
    <v-list v-if="uploadedFiles.length" density="compact">
      <v-list-item v-for="file in uploadedFiles" :key="file.id" :title="file.name" :subtitle="formatSize(file.size)">
        <template #prepend>
          <v-icon :icon="getFileIcon(file.mimeType)" />
        </template>
        <template #append>
          <v-btn icon="mdi-delete" size="small" variant="text" @click="removeFile(file.id)" />
        </template>
      </v-list-item>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  label?: string
  accept?: string
  multiple?: boolean
}>()

const emit = defineEmits<{
  uploaded: [files: any[]]
}>()

const files = ref<File[]>([])
const uploadedFiles = ref<any[]>([])
const uploading = ref(false)
const progress = ref(0)

function onFilesChanged(newFiles: File[]) {
  if (newFiles?.length) {
    emit('uploaded', newFiles.map(f => ({ name: f.name, size: f.size, type: f.type })))
  }
}

function removeFile(id: string) {
  uploadedFiles.value = uploadedFiles.value.filter(f => f.id !== id)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(mimeType: string): string {
  if (mimeType?.startsWith('image/')) return 'mdi-file-image'
  if (mimeType === 'application/pdf') return 'mdi-file-pdf-box'
  if (mimeType?.includes('spreadsheet') || mimeType?.includes('excel')) return 'mdi-file-excel'
  if (mimeType?.includes('word')) return 'mdi-file-word'
  return 'mdi-file'
}
</script>
