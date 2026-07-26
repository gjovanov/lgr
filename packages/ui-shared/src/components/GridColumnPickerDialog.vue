<template>
  <v-dialog :model-value="modelValue" max-width="440" @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-toolbar color="surface" flat density="compact">
        <v-toolbar-title class="text-body-1 font-weight-bold">{{ $t('grid.columns') }}</v-toolbar-title>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="emit('update:modelValue', false)" />
      </v-toolbar>
      <v-card-text class="pa-2">
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
            <v-list-item-title :class="col.visible ? '' : 'text-medium-emphasis'">{{ col.title || col.key }}</v-list-item-title>
            <template #append>
              <v-btn
                icon="mdi-arrow-up"
                size="x-small"
                variant="text"
                :disabled="idx === 0"
                :aria-label="$t('grid.moveUp')"
                @click="emit('move', col.key, -1)"
              />
              <v-btn
                icon="mdi-arrow-down"
                size="x-small"
                variant="text"
                :disabled="idx === entries.length - 1"
                :aria-label="$t('grid.moveDown')"
                @click="emit('move', col.key, 1)"
              />
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions class="px-4 py-2">
        <v-btn variant="text" prepend-icon="mdi-restore" @click="emit('reset')">{{ $t('grid.reset') }}</v-btn>
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="emit('update:modelValue', false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import type { GridColumnEntry } from '../composables/useGridColumns'

defineProps<{
  modelValue: boolean
  entries: GridColumnEntry[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'toggle': [key: string]
  'move': [key: string, dir: -1 | 1]
  'reset': []
}>()
</script>
