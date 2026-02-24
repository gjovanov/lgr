<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.exchangeRates') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.add') }}
      </v-btn>
    </div>

    <data-table
      :headers="headers"
      :items="store.exchangeRates"
      :loading="store.loading"
      @click:row="openDialog($event)"
    >
      <template #item.rate="{ item }">
        {{ item.rate.toFixed(6) }}
      </template>
      <template #item.date="{ item }">
        {{ item.date?.split('T')[0] }}
      </template>
      <template #item.source="{ item }">
        <v-chip v-if="item.source" size="small" variant="outlined">
          {{ item.source }}
        </v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="openDialog(item)" />
        <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
      </template>
    </data-table>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="500">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.add') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field
              v-model="form.fromCurrency"
              :label="$t('accounting.fromCurrency')"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.toCurrency"
              :label="$t('accounting.toCurrency')"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model.number="form.rate"
              :label="$t('accounting.rate')"
              type="number"
              step="0.000001"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.date"
              :label="$t('common.date')"
              type="date"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.source"
              :label="$t('accounting.source')"
            />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">
            {{ $t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirmDelete') }}</v-card-title>
        <v-card-text>{{ $t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doDelete">
            {{ $t('common.delete') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore, type ExchangeRate } from '../../store/accounting.store'
import { httpClient } from '../../composables/useHttpClient'
import DataTable from '../../components/shared/DataTable.vue'
import ExportMenu from '../../components/shared/ExportMenu.vue'

const appStore = useAppStore()
const store = useAccountingStore()
const { t } = useI18n()

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const emptyForm = () => ({
  fromCurrency: '',
  toCurrency: '',
  rate: 1,
  date: new Date().toISOString().split('T')[0],
  source: '',
})

const form = ref(emptyForm())

const headers = computed(() => [
  { title: t('accounting.fromCurrency'), key: 'fromCurrency' },
  { title: t('accounting.toCurrency'), key: 'toCurrency' },
  { title: t('accounting.rate'), key: 'rate', align: 'end' as const },
  { title: t('common.date'), key: 'date' },
  { title: t('accounting.source'), key: 'source' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const rules = {
  required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || 'Required',
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function openDialog(item?: ExchangeRate | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    const rate = item as ExchangeRate
    editing.value = true
    selectedId.value = rate._id
    form.value = {
      fromCurrency: rate.fromCurrency,
      toCurrency: rate.toCurrency,
      rate: rate.rate,
      date: rate.date?.split('T')[0] || '',
      source: '',
    }
  } else {
    editing.value = false
    form.value = emptyForm()
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await httpClient.put(`${orgUrl()}/accounting/exchange-rate/${selectedId.value}`, form.value)
  } else {
    await httpClient.post(`${orgUrl()}/accounting/exchange-rate`, form.value)
  }
  await store.fetchExchangeRates()
  dialog.value = false
}

function confirmDelete(item: ExchangeRate) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  await httpClient.delete(`${orgUrl()}/accounting/exchange-rate/${selectedId.value}`)
  await store.fetchExchangeRates()
  deleteDialog.value = false
}

onMounted(() => {
  store.fetchExchangeRates()
})
</script>
