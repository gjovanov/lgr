<template>
  <v-select
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :label="label"
    :items="items"
    item-title="title"
    item-value="value"
    multiple
    chips
    hide-details
    density="compact"
    clearable
    :menu-props="{ maxHeight: 400 }"
  >
    <!-- Render exactly one summary chip regardless of how many statuses are selected.
         This keeps the row single-line next to the other compact filter controls. -->
    <template #selection="{ index }">
      <v-chip
        v-if="index === 0"
        size="small"
        label
        :color="allSelected ? 'primary' : 'default'"
      >
        {{ summaryLabel }}
      </v-chip>
    </template>
  </v-select>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

interface StatusOption {
  title: string
  value: string
}

const props = defineProps<{
  modelValue: string[]
  items: StatusOption[]
  label?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const { t } = useI18n()

const allSelected = computed(() =>
  props.items.length > 0 && props.modelValue.length === props.items.length,
)

const summaryLabel = computed(() => {
  if (props.modelValue.length === 0) return t('common.allStatuses')
  if (allSelected.value) return t('common.allStatuses')
  return t('common.itemsSelected', { n: props.modelValue.length })
})
</script>
