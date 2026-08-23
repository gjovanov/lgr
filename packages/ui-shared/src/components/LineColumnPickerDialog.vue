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
        <!-- FR-05 (#12): drag & drop reorder. The anchor row (description) is rendered
             outside the draggable zone — it can neither move nor be displaced. -->
        <v-list density="compact">
          <v-list-item v-if="anchorEntry" class="px-2">
            <template #prepend>
              <v-icon class="mr-1" size="small" color="medium-emphasis" style="opacity: 0.3">mdi-drag-vertical</v-icon>
              <v-checkbox-btn :model-value="anchorEntry.visible" :disabled="true" density="compact" />
            </template>
            <v-list-item-title>{{ $t(anchorEntry.i18n) }}</v-list-item-title>
          </v-list-item>
        </v-list>
        <draggable
          v-model="localEntries"
          item-key="key"
          handle=".drag-handle"
          :animation="150"
          :delay="150"
          :delay-on-touch-only="true"
          ghost-class="drag-ghost"
          tag="div"
          class="v-list v-list--density-compact"
          @end="onDragEnd"
        >
          <template #item="{ element: col }">
            <v-list-item class="px-2">
              <template #prepend>
                <v-icon class="drag-handle mr-1" size="small" color="medium-emphasis" style="cursor: grab">
                  mdi-drag-vertical
                </v-icon>
                <v-checkbox-btn
                  :model-value="col.visible"
                  :disabled="col.locked"
                  density="compact"
                  @update:model-value="emit('toggle', col.key)"
                />
              </template>
              <v-list-item-title :class="col.visible ? '' : 'text-medium-emphasis'">{{ $t(col.i18n) }}</v-list-item-title>
            </v-list-item>
          </template>
        </draggable>
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
import { ref, computed, watch } from 'vue'
import draggable from 'vuedraggable'
import type { LineColumnEntry } from '../composables/useInvoiceLineColumns'

const props = defineProps<{
  modelValue: boolean
  entries: LineColumnEntry[]
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  toggle: [key: string]
  /** Reorderable (non-anchor) keys after a drag; the composable re-pins the anchor. */
  reorder: [keys: string[]]
  'select-all': []
  'select-none': []
  'reset-defaults': []
}>()

// The anchor (first, locked) row stays put; only the rest participates in dragging.
const anchorEntry = computed(() => (props.entries[0]?.locked ? props.entries[0] : undefined))
const localEntries = ref<LineColumnEntry[]>([])
watch(
  () => props.entries,
  (v) => { localEntries.value = anchorEntry.value ? v.slice(1) : [...v] },
  { immediate: true },
)

function onDragEnd() {
  emit('reorder', localEntries.value.map(e => e.key))
}
</script>

<style scoped>
.drag-ghost {
  opacity: 0.4;
}
</style>
