<template>
  <v-select
    :model-value="modelValue"
    @update:model-value="onUpdate"
    :label="label"
    :items="items"
    item-title="title"
    item-value="value"
    multiple
    hide-details
    density="compact"
    clearable
    :menu-props="{ maxHeight: 400 }"
  >
    <!-- Single-line text summary ("All statuses" / "Draft" / "Draft +2") so the control
         stays the same height as the sibling filter fields. No chips (chips-mode makes the
         field taller and breaks the row baseline). -->
    <template #selection="{ index }">
      <span v-if="index === 0" class="text-truncate" :class="{ 'text-primary': allSelected }">
        {{ summaryLabel }}
      </span>
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
  /** Summary text when nothing / everything is selected. Defaults to "All statuses". */
  allLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const { t } = useI18n()

/**
 * The selection in the items' order, whatever order it was clicked in: re-ticking every status
 * then serialises exactly like the default, so the list's URL goes back to bare (FR-22.15).
 */
function onUpdate(value: string[] | null) {
  const picked = value || []
  emit('update:modelValue', props.items.map(i => i.value).filter(v => picked.includes(v)))
}

const allSelected = computed(() =>
  props.items.length > 0 && props.modelValue.length === props.items.length,
)

const summaryLabel = computed(() => {
  // Selected items in display order, so the "first" is stable regardless of click order.
  const selected = props.items.filter(i => props.modelValue.includes(i.value))
  if (selected.length === 0 || allSelected.value) return props.allLabel || t('common.allStatuses')
  if (selected.length === 1) return selected[0].title
  return `${selected[0].title} ${t('common.plusOthers', { n: selected.length - 1 })}`
})
</script>
