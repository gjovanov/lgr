<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.sequences') }}</h1>
    </div>

    <v-alert type="info" variant="tonal" class="mb-4" density="compact">
      {{ $t('sequences.hint') }}
    </v-alert>

    <v-card>
      <v-card-text>
        <v-data-table
          :headers="headers"
          :items="rows"
          :loading="loading"
          density="compact"
          items-per-page="-1"
          hide-default-footer
        >
          <template #item.group="{ item }">
            <span class="font-weight-medium">{{ groupLabel(item.group) }}</span>
          </template>
          <template #item.variant="{ item }">
            <v-chip :color="item.variant === 'draft' ? 'warning' : 'success'" size="small" label>
              {{ item.variant === 'draft' ? $t('common.draft') : $t('sequences.issued') }}
            </v-chip>
          </template>
          <template #item.displayPrefix="{ item }">
            <div class="d-flex align-center ga-2">
              <v-text-field
                :model-value="editing[`${item.prefix}:${item.variant}`] ?? item.displayPrefix"
                density="compact"
                variant="outlined"
                hide-details
                style="max-width: 180px"
                @update:model-value="onEdit(item, $event)"
              />
              <v-btn
                v-if="isDirty(item)"
                size="x-small"
                color="primary"
                variant="flat"
                :loading="saving === keyOf(item)"
                @click="save(item)"
              >
                {{ $t('common.save') }}
              </v-btn>
            </div>
          </template>
          <template #item.lastNumber="{ item }">
            <span class="text-mono">{{ String(item.lastNumber).padStart(5, '0') }}</span>
          </template>
          <template #no-data>
            <EmptyState
              icon="mdi-format-list-numbered"
              :title="$t('sequences.empty')"
              :description="$t('sequences.emptyHint')"
            />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import EmptyState from 'ui-shared/components/EmptyState.vue'

interface SequenceRow {
  prefix: string
  defaultDisplay: string
  displayPrefix: string
  group: 'invoice' | 'proforma' | 'credit_note' | 'debit_note' | 'bill' | 'cash_sale' | 'order' | 'internal_order' | 'reservation'
  variant: 'draft' | 'issued'
  year: number
  lastNumber: number
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const rows = ref<SequenceRow[]>([])
const loading = ref(false)
const saving = ref<string | null>(null)
const editing = reactive<Record<string, string>>({})

const headers = computed(() => [
  { title: t('common.type'), key: 'group', sortable: false },
  { title: t('sequences.variant'), key: 'variant', sortable: false },
  { title: t('sequences.storagePrefix'), key: 'prefix', sortable: false },
  { title: t('sequences.displayPrefix'), key: 'displayPrefix', sortable: false },
  { title: t('sequences.lastNumber'), key: 'lastNumber', align: 'end' as const, sortable: false },
])

function keyOf(item: SequenceRow): string {
  return `${item.prefix}:${item.variant}`
}

function groupLabel(group: string): string {
  const map: Record<string, string> = {
    invoice: t('nav.salesInvoices'),
    proforma: t('nav.proforma'),
    credit_note: t('nav.creditNotes'),
    debit_note: t('nav.debitNotes'),
    bill: t('nav.purchaseInvoices'),
    cash_sale: t('invoicing.cashSales'),
    order: t('nav.externalOrders'),
    internal_order: t('nav.internalOrders'),
    reservation: t('nav.reservations'),
  }
  return map[group] || group
}

function isDirty(item: SequenceRow): boolean {
  const k = keyOf(item)
  return editing[k] !== undefined && editing[k] !== item.displayPrefix
}

function onEdit(item: SequenceRow, value: string) {
  editing[keyOf(item)] = value
}

async function load() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/sequences`)
    rows.value = data.sequences || []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function save(item: SequenceRow) {
  const k = keyOf(item)
  const next = editing[k]
  if (next === undefined) return
  saving.value = k
  try {
    await httpClient.put(`${appStore.orgUrl()}/invoicing/sequences/${item.prefix}`, {
      displayPrefix: next || null,
    })
    showSuccess(t('common.savedSuccessfully'))
    delete editing[k]
    await load()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = null
  }
}

onMounted(() => { load() })
</script>

<style scoped>
.text-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
