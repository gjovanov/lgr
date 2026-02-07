<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.cashOrders') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-0">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="['receipt', 'disbursement']" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" :no-data-text="$t('common.noData')" item-value="_id" hover>
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="item.type === 'receipt' ? 'success' : 'error'">{{ item.type }}</v-chip>
          </template>
          <template #item.amount="{ item }">{{ fmtCurrency(item.amount) }}</template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="item.status === 'confirmed' ? 'success' : 'grey'">{{ item.status }}</v-chip>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.cashOrders') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-select
              v-model="form.type"
              :label="$t('common.type')"
              :items="[
                { title: $t('invoicing.receipt'), value: 'receipt' },
                { title: $t('invoicing.disbursement'), value: 'disbursement' },
              ]"
              :rules="[rules.required]"
            />
            <v-text-field v-model="form.party" :label="$t('invoicing.party')" :rules="[rules.required]" />
            <v-row>
              <v-col cols="6">
                <v-text-field v-model.number="form.amount" :label="$t('common.amount')" type="number" step="0.01" :rules="[rules.required]" />
              </v-col>
              <v-col cols="6">
                <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-text-field v-model="form.account" :label="$t('invoicing.account')" />
            <v-textarea v-model="form.description" :label="$t('common.description')" rows="2" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteCashOrderConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from '../../composables/useHttpClient'
import { useCurrency } from '../../composables/useCurrency'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface Item { _id: string; number: string; type: string; party: string; date: string; amount: number; status: string; account?: string; description?: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const loading = ref(false)
const items = ref<Item[]>([])
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const typeFilter = ref<string | null>(null)

const form = ref({ type: 'receipt', party: '', date: new Date().toISOString().split('T')[0], amount: 0, account: '', description: '' })

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== 0) || t('validation.required') }

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('invoicing.party'), key: 'party', sortable: true },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('common.amount'), key: 'amount', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.description'), key: 'description' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const filteredItems = computed(() => {
  let r = items.value
  if (typeFilter.value) r = r.filter(i => i.type === typeFilter.value)
  return r
})

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() {
  editing.value = false
  form.value = { type: 'receipt', party: '', date: new Date().toISOString().split('T')[0], amount: 0, account: '', description: '' }
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = { type: item.type, party: item.party, date: item.date?.split('T')[0] || '', amount: item.amount, account: item.account || '', description: item.description || '' }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    if (editing.value) await httpClient.put(`${orgUrl()}/cash-orders/${selectedId.value}`, form.value)
    else await httpClient.post(`${orgUrl()}/cash-orders`, form.value)
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${orgUrl()}/cash-orders/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
function onExport(format: string) { console.log('Export cash orders as', format) }

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/cash-orders`); items.value = data.cashOrders || [] }
  finally { loading.value = false }
}

onMounted(() => { fetchItems() })
</script>
