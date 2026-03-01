<template>
  <v-combobox
    v-model="tags"
    v-model:search="searchQuery"
    :items="suggestions"
    :loading="loading"
    :label="label || $t('common.tags')"
    multiple
    chips
    closable-chips
    hide-details
    density="compact"
    :disabled="disabled"
    no-filter
    @update:model-value="onUpdate"
  >
    <template #chip="{ item, props: chipProps }">
      <v-chip v-bind="chipProps" size="small" color="primary" label>{{ item.title }}</v-chip>
    </template>
    <template #no-data>
      <v-list-item v-if="searchQuery && searchQuery.length >= 1">
        <v-list-item-title class="text-grey-darken-1">
          {{ $t('common.pressEnterToCreate') || 'Press Enter to create' }} "<strong>{{ searchQuery }}</strong>"
        </v-list-item-title>
      </v-list-item>
    </template>
  </v-combobox>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { httpClient } from '../composables/useHttpClient'

const props = defineProps<{
  modelValue: string[]
  type: string
  orgUrl: string
  label?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const tags = ref<string[]>([...props.modelValue])
const searchQuery = ref('')
const suggestions = ref<string[]>([])
const loading = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.modelValue, (val) => {
  tags.value = [...val]
})

watch(searchQuery, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!q || q.length < 1) {
    suggestions.value = []
    return
  }
  debounceTimer = setTimeout(() => fetchTags(q), 300)
})

async function fetchTags(query: string) {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/tags`, { params: { type: props.type, search: query } })
    suggestions.value = (data.tags || []).map((t: any) => t.value)
  } catch { /* */ } finally {
    loading.value = false
  }
}

function onUpdate(value: string[]) {
  tags.value = value
  emit('update:modelValue', value)
}
</script>
