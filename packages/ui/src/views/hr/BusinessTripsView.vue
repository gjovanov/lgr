<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('hr.businessTrips') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable class="mb-4" />
        <v-data-table :headers="headers" :items="items" :search="search" :loading="loading" item-value="_id">
          <template #item.status="{ item }"><v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip></template>
          <template #item.budget="{ item }">{{ formatCurrency(item.budget, currency, localeCode) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status === 'pending'" icon="mdi-check" size="small" variant="text" color="success" @click="approveTrip(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.employeeName" :label="t('payroll.employee')" :rules="[rules.required]" />
            <v-text-field v-model="form.destination" :label="t('hr.destination')" :rules="[rules.required]" />
            <v-text-field v-model="form.purpose" :label="t('hr.purpose')" :rules="[rules.required]" />
            <v-text-field v-model="form.startDate" :label="t('common.dateFrom')" type="date" :rules="[rules.required]" />
            <v-text-field v-model="form.endDate" :label="t('common.dateTo')" type="date" :rules="[rules.required]" />
            <v-text-field v-model.number="form.budget" :label="t('hr.budget')" type="number" />
          </v-form>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn><v-btn color="primary" :loading="loading" @click="save">{{ t('common.save') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from '../../composables/useHttpClient'
import { formatCurrency } from '../../composables/useCurrency'

interface Item { _id: string; employeeName: string; destination: string; purpose: string; startDate: string; endDate: string; status: string; budget: number }

const { t } = useI18n()
const appStore = useAppStore()
const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))
const search = ref(''); const loading = ref(false); const items = ref<Item[]>([]); const dialog = ref(false); const editing = ref(false); const formRef = ref(); const selectedId = ref('')
const form = ref({ employeeName: '', destination: '', purpose: '', startDate: '', endDate: '', budget: 0 })

const headers = [
  { title: t('payroll.employee'), key: 'employeeName' }, { title: t('hr.destination'), key: 'destination' },
  { title: t('hr.purpose'), key: 'purpose' }, { title: t('common.dateFrom'), key: 'startDate' },
  { title: t('common.dateTo'), key: 'endDate' }, { title: t('common.status'), key: 'status' },
  { title: t('hr.budget'), key: 'budget', align: 'end' as const }, { title: t('common.actions'), key: 'actions', sortable: false },
]

function statusColor(s: string) { return ({ pending: 'warning', approved: 'success', completed: 'primary', rejected: 'error' }[s] || 'grey') }
const rules = { required: (v: string) => !!v || t('validation.required') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() { editing.value = false; form.value = { employeeName: '', destination: '', purpose: '', startDate: '', endDate: '', budget: 0 }; dialog.value = true }
function openEdit(item: Item) { editing.value = true; selectedId.value = item._id; form.value = { employeeName: item.employeeName, destination: item.destination, purpose: item.purpose, startDate: item.startDate?.split('T')[0], endDate: item.endDate?.split('T')[0], budget: item.budget }; dialog.value = true }
async function save() { const { valid } = await formRef.value.validate(); if (!valid) return; loading.value = true; try { if (editing.value) await httpClient.put(`${orgUrl()}/hr/business-trip/${selectedId.value}`, form.value); else await httpClient.post(`${orgUrl()}/hr/business-trip`, form.value); await fetchItems(); dialog.value = false } finally { loading.value = false } }
async function approveTrip(item: Item) { loading.value = true; try { await httpClient.post(`${orgUrl()}/hr/business-trip/${item._id}/approve`); await fetchItems() } finally { loading.value = false } }
async function fetchItems() { loading.value = true; try { const { data } = await httpClient.get(`${orgUrl()}/hr/business-trip`); items.value = data.businessTrips || [] } finally { loading.value = false } }

onMounted(() => { fetchItems() })
</script>
