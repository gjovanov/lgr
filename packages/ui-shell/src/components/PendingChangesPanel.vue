<template>
  <v-navigation-drawer
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    location="right"
    temporary
    :width="400"
  >
    <v-toolbar flat density="compact">
      <v-toolbar-title class="text-body-1 font-weight-bold">
        {{ $t('pendingChanges.title') }}
      </v-toolbar-title>
      <v-spacer />
      <v-btn
        v-if="entries.length > 0"
        variant="text"
        size="small"
        color="error"
        @click="confirmClearAll = true"
      >
        {{ $t('pendingChanges.clearAll') }}
      </v-btn>
      <v-btn icon="mdi-close" variant="text" size="small" @click="emit('update:modelValue', false)" />
    </v-toolbar>

    <v-divider />

    <div v-if="entries.length === 0" class="text-center text-medium-emphasis pa-8">
      <v-icon size="48" class="mb-4">mdi-check-circle-outline</v-icon>
      <div>{{ $t('pendingChanges.empty') }}</div>
    </div>

    <v-list v-else lines="three" class="pa-2">
      <v-list-item
        v-for="entry in entries"
        :key="entry.id"
        :prepend-icon="entry.icon || entityIcon(entry.entityType)"
        rounded
        class="mb-1"
        @click="emit('restore', entry)"
      >
        <v-list-item-title class="d-flex align-center ga-2">
          <span class="text-body-2 font-weight-medium">{{ entityLabel(entry.entityType) }}</span>
          <v-chip
            :color="entry.mode === 'create' ? 'success' : 'info'"
            size="x-small"
            label
          >
            {{ entry.mode === 'create' ? $t('pendingChanges.new') : $t('pendingChanges.edit') }}
          </v-chip>
        </v-list-item-title>
        <v-list-item-subtitle>
          <span v-for="(field, i) in entry.previewFields.slice(0, 2)" :key="i">
            {{ field.value }}<span v-if="i < Math.min(entry.previewFields.length, 2) - 1"> &middot; </span>
          </span>
        </v-list-item-subtitle>
        <v-list-item-subtitle class="text-caption text-medium-emphasis mt-1">
          {{ relativeTime(entry.capturedAt) }}
        </v-list-item-subtitle>
        <template #append>
          <v-btn
            icon="mdi-close"
            variant="text"
            size="x-small"
            @click.stop="emit('remove', entry.id)"
          />
        </template>
      </v-list-item>
    </v-list>

    <!-- Clear All Confirmation -->
    <v-dialog v-model="confirmClearAll" max-width="360">
      <v-card>
        <v-card-title class="text-body-1">{{ $t('pendingChanges.clearAllConfirm') }}</v-card-title>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirmClearAll = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="confirmClearAll = false; emit('remove-all')">{{ $t('common.confirm') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-navigation-drawer>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'

defineProps<{
  modelValue: boolean
  entries: PendingChangeEntry[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  restore: [entry: PendingChangeEntry]
  remove: [id: string]
  'remove-all': []
}>()

const { t } = useI18n()
const confirmClearAll = ref(false)

const ENTITY_ICONS: Record<string, string> = {
  product: 'mdi-package-variant',
  contact: 'mdi-contacts',
  salesInvoice: 'mdi-receipt-text-outline',
  purchaseInvoice: 'mdi-receipt-text',
  proformaInvoice: 'mdi-file-document-outline',
  creditNote: 'mdi-file-undo',
  debitNote: 'mdi-file-plus-outline',
  cashSale: 'mdi-cash-register',
  posDevice: 'mdi-printer-pos',
  category: 'mdi-shape',
  warehouse: 'mdi-warehouse',
  priceList: 'mdi-tag-multiple',
  stockMovement: 'mdi-swap-horizontal',
  inventoryCount: 'mdi-clipboard-check',
  paymentOrder: 'mdi-bank-transfer',
  cashOrder: 'mdi-cash',
  account: 'mdi-book-open-variant',
  bankAccount: 'mdi-bank',
  fixedAsset: 'mdi-domain',
  exchangeRate: 'mdi-currency-usd',
  taxReturn: 'mdi-file-percent',
  journalEntry: 'mdi-book-open-page-variant',
  employee: 'mdi-account',
  payrollRun: 'mdi-calculator',
  timesheet: 'mdi-clock-outline',
  permissionSet: 'mdi-shield-key',
}

function entityIcon(type: string): string {
  return ENTITY_ICONS[type] || 'mdi-file-edit'
}

function entityLabel(type: string): string {
  // Convert camelCase to title case
  return type.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('pendingChanges.justNow')
  if (mins < 60) return t('pendingChanges.minutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('pendingChanges.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  return t('pendingChanges.daysAgo', { n: days })
}
</script>
