<template>
  <v-dialog v-model="show" max-width="440">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-download</v-icon>
        <span>{{ $t ? $t('common.export') : 'Export' }}</span>
      </v-card-title>
      <v-card-text>
        <v-radio-group v-model="format" :label="$t ? $t('common.format') : 'Format'" density="compact" inline>
          <v-radio label="Excel (.xlsx)" value="xlsx" />
          <v-radio label="PDF" value="pdf" />
        </v-radio-group>
        <v-radio-group v-model="mode" :label="$t ? $t('common.mode') : 'Mode'" density="compact" inline hide-details>
          <v-radio :label="$t ? $t('export.compact') : 'Compact'" value="compact" />
          <v-radio :label="$t ? $t('export.detailed') : 'Detailed'" value="detailed" />
        </v-radio-group>
        <div class="text-caption text-medium-emphasis mt-2">
          <span v-if="mode === 'compact'">{{ $t ? $t('export.compactHint') : 'One row per document, summary columns.' }}</span>
          <span v-else>{{ $t ? $t('export.detailedHint') : 'Includes line items (one row per line).' }}</span>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="show = false" :disabled="loading">{{ $t ? $t('common.cancel') : 'Cancel' }}</v-btn>
        <v-btn color="primary" :loading="loading" @click="onConfirm">
          {{ $t ? $t('common.download') : 'Download' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  hideMode?: boolean
  defaultMode?: 'compact' | 'detailed'
  defaultFormat?: 'xlsx' | 'pdf'
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  confirm: [opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed' }]
}>()

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const format = ref<'xlsx' | 'pdf'>(props.defaultFormat || 'xlsx')
const mode = ref<'compact' | 'detailed'>(props.defaultMode || 'compact')

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      format.value = props.defaultFormat || 'xlsx'
      mode.value = props.defaultMode || 'compact'
    }
  },
)

function onConfirm() {
  emit('confirm', { format: format.value, mode: mode.value })
}
</script>
