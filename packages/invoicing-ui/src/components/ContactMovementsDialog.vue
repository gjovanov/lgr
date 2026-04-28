<template>
  <v-dialog :model-value="modelValue" max-width="1100" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-swap-horizontal</v-icon>
        {{ $t('invoicing.movements') }}
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="emit('update:modelValue', false)" />
      </v-card-title>

      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="total"
          :loading="loading"
          :page="page + 1"
          :items-per-page="pageSize"
          density="compact"
          hover
          @update:options="onUpdateOptions"
        >
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="x-small" label :color="typeColor(item.type)">{{ item.type }}</v-chip>
          </template>
          <template #item.warehouseName="{ item }">{{ item.warehouseName || item.warehouseId }}</template>
          <template #item.totalValue="{ item }">{{ formatCurrency(item.totalValue || 0) }}</template>
        </v-data-table-server>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'

const props = defineProps<{
  modelValue: boolean
  contactId: string
  orgUrl: string
}>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const items = ref<any[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(25)
const loading = ref(false)

const headers = computed(() => [
  { title: t('common.date'),       key: 'date',          sortable: true },
  { title: t('common.type'),       key: 'type',          sortable: true },
  { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: false },
  { title: t('invoicing.reference'), key: 'reference',   sortable: true },
  { title: t('common.total'),      key: 'totalValue',    sortable: false, align: 'end' as const },
])

async function fetch() {
  if (!props.contactId) return
  loading.value = true
  try {
    const params = new URLSearchParams({
      contactId: props.contactId,
      page: String(page.value),
      size: String(pageSize.value),
    })
    const { data } = await httpClient.get(`${props.orgUrl}/warehouse/movement?${params.toString()}`)
    items.value = data.movements || data.items || []
    total.value = data.total || items.value.length
  } catch {
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function onUpdateOptions(opts: { page: number; itemsPerPage: number }) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 25
  fetch()
}

function typeColor(type: string): string {
  if (type === 'receipt' || type === 'in') return 'success'
  if (type === 'dispatch' || type === 'out') return 'warning'
  if (type === 'transfer') return 'info'
  return 'default'
}

watch(() => props.modelValue, (open) => {
  if (open) {
    page.value = 0
    fetch()
  }
})
</script>
