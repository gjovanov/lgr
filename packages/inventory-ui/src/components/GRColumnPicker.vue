<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="720">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-view-column-outline</v-icon>
        {{ $t('warehouse.grPicker.title') }}
      </v-card-title>
      <v-card-text>
        <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('warehouse.grPicker.hint') }}</p>

        <div class="d-flex align-center mb-2">
          <strong>{{ selected.length }}</strong>
          <span class="ml-1 text-medium-emphasis">/ {{ GR_COLUMNS.length }} {{ $t('warehouse.grPicker.selected') }}</span>
          <v-spacer />
          <v-btn size="small" variant="text" @click="selectAll">{{ $t('common.selectAll') }}</v-btn>
          <v-btn size="small" variant="text" @click="selectNone">{{ $t('common.selectNone') }}</v-btn>
          <v-btn size="small" variant="text" @click="resetDefaults">{{ $t('warehouse.grPicker.reset') }}</v-btn>
        </div>

        <div v-for="section in sections" :key="section" class="mb-4">
          <div class="text-overline mb-1">{{ $t('warehouse.grPicker.section.' + section) }}</div>
          <v-row dense>
            <v-col v-for="col in columnsBySection[section]" :key="col.key" cols="12" sm="6" md="4">
              <v-checkbox
                :model-value="selected.includes(col.key)"
                :label="$t(col.i18n)"
                density="compact"
                hide-details
                @update:model-value="toggle(col.key)"
              />
            </v-col>
          </v-row>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { GR_COLUMNS, type GRColumnSection } from '../composables/useGRColumns'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

// Composable shared with the parent view — re-use to keep in sync.
import { useGRColumns } from '../composables/useGRColumns'
const { selected, toggle, selectAll, selectNone, resetDefaults } = useGRColumns()

const sections: GRColumnSection[] = ['basic', 'pricing', 'tier']
const columnsBySection = computed(() => {
  const out: Record<GRColumnSection, typeof GR_COLUMNS> = { basic: [], pricing: [], tier: [] }
  for (const c of GR_COLUMNS) out[c.section].push(c)
  return out
})
</script>
