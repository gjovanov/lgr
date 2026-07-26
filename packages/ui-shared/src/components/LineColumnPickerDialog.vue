<template>
  <v-dialog
    :model-value="modelValue"
    max-width="640"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-view-column-outline</v-icon>
        {{ $t('invoicing.linePicker.title') }}
      </v-card-title>
      <v-card-text class="pa-2">
        <p class="text-body-2 text-medium-emphasis px-2 mb-2">
          {{ $t('invoicing.linePicker.hint') }}
        </p>
        <!-- Reorderable list: checkbox toggles visibility, arrows reorder (like the grid picker). -->
        <v-list density="compact">
          <v-list-item v-for="(col, idx) in entries" :key="col.key" class="px-2">
            <template #prepend>
              <v-checkbox-btn
                :model-value="col.visible"
                :disabled="col.locked"
                density="compact"
                @update:model-value="emit('toggle', col.key)"
              />
            </template>
            <v-list-item-title :class="col.visible ? '' : 'text-medium-emphasis'">{{ $t(col.i18n) }}</v-list-item-title>
            <template #append>
              <v-btn icon="mdi-arrow-up" size="x-small" variant="text" :disabled="col.locked || idx <= 1" :aria-label="$t('grid.moveUp')" @click="emit('move', col.key, -1)" />
              <v-btn icon="mdi-arrow-down" size="x-small" variant="text" :disabled="col.locked || idx === entries.length - 1" :aria-label="$t('grid.moveDown')" @click="emit('move', col.key, 1)" />
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions class="px-4 py-2">
        <v-btn size="small" variant="text" @click="emit('select-all')">{{ $t('common.selectAll') }}</v-btn>
        <v-btn size="small" variant="text" @click="emit('select-none')">{{ $t('common.selectNone') }}</v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-restore" @click="emit('reset-defaults')">{{ $t('grid.reset') }}</v-btn>
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="emit('update:modelValue', false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import type { LineColumnEntry } from '../composables/useInvoiceLineColumns'

defineProps<{
  modelValue: boolean
  entries: LineColumnEntry[]
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  toggle: [key: string]
  move: [key: string, dir: -1 | 1]
  'select-all': []
  'select-none': []
  'reset-defaults': []
}>()
</script>
