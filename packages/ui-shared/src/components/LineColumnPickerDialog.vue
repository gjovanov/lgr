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
      <v-card-text>
        <p class="text-body-2 text-medium-emphasis mb-3">
          {{ $t('invoicing.linePicker.hint') }}
        </p>

        <div class="d-flex align-center mb-2">
          <strong>{{ selected.length }}</strong>
          <span class="ml-1 text-medium-emphasis">
            / {{ availableColumns.length }} {{ $t('invoicing.linePicker.selected') }}
          </span>
          <v-spacer />
          <v-btn size="small" variant="text" @click="emit('select-all')">
            {{ $t('common.selectAll') }}
          </v-btn>
          <v-btn size="small" variant="text" @click="emit('select-none')">
            {{ $t('common.selectNone') }}
          </v-btn>
          <v-btn size="small" variant="text" @click="emit('reset-defaults')">
            {{ $t('invoicing.linePicker.reset') }}
          </v-btn>
        </div>

        <v-row dense>
          <v-col v-for="col in availableColumns" :key="col.key" cols="12" sm="6">
            <v-checkbox
              :model-value="selected.includes(col.key)"
              :label="$t(col.i18n)"
              :disabled="col.key === 'description'"
              density="compact"
              hide-details
              @update:model-value="emit('toggle', col.key)"
            />
          </v-col>
        </v-row>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import type { LineColumn } from '../composables/useInvoiceLineColumns'

defineProps<{
  modelValue: boolean
  selected: string[]
  availableColumns: LineColumn[]
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  toggle: [key: string]
  'select-all': []
  'select-none': []
  'reset-defaults': []
}>()
</script>
