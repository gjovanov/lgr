<template>
  <v-btn-toggle
    :model-value="modelValue"
    density="compact"
    mandatory
    divided
    variant="outlined"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <v-btn
      v-for="view in views"
      :key="view"
      :value="view"
      size="small"
    >
      <v-icon size="small">{{ iconMap[view] }}</v-icon>
      <v-tooltip activator="parent" location="bottom">{{ labelMap[view] }}</v-tooltip>
    </v-btn>
  </v-btn-toggle>
</template>

<script setup lang="ts">
defineProps<{
  views: ('list' | 'kanban' | 'pivot' | 'chart')[]
  modelValue: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()

const iconMap: Record<string, string> = {
  list: 'mdi-format-list-bulleted',
  kanban: 'mdi-view-column',
  pivot: 'mdi-table-pivot',
  chart: 'mdi-chart-bar',
}

const labelMap: Record<string, string> = {
  list: 'List',
  kanban: 'Kanban',
  pivot: 'Pivot',
  chart: 'Chart',
}
</script>
