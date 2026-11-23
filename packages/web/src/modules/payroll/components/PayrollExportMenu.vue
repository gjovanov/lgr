<template>
  <!-- #830: a payroll list's Export, Excel or PDF, on the list's filters. The page itself needs what the export needs
       (the list's read), so it shows wherever the list does; `cap` hides it from anyone else. -->
  <span v-cap="cap">
    <v-menu>
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          variant="outlined"
          prepend-icon="mdi-download"
          :loading="loading"
          data-testid="payroll-export"
        >
          {{ $t('common.export') }}
        </v-btn>
      </template>
      <v-list density="compact">
        <v-list-item prepend-icon="mdi-microsoft-excel" data-testid="payroll-export-xlsx" @click="emit('export', 'xlsx')">
          <v-list-item-title>Excel (.xlsx)</v-list-item-title>
        </v-list-item>
        <v-list-item prepend-icon="mdi-file-pdf-box" data-testid="payroll-export-pdf" @click="emit('export', 'pdf')">
          <v-list-item-title>PDF</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </span>
</template>

<script setup lang="ts">
import type { ExportFormat } from '../composables/payroll-export'

defineProps<{ cap: string; loading?: boolean }>()

const emit = defineEmits<{ export: [format: ExportFormat] }>()
</script>
