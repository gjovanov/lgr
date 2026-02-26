<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.bankAccounts') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.add') }}
      </v-btn>
    </div>

    <data-table
      :headers="headers"
      :items="store.bankAccounts"
      :loading="store.loading"
      @click:row="openDialog($event)"
    >
      <template #item.balance="{ item }">
        {{ formatCurrency(item.balance, item.currency || currency, localeCode) }}
      </template>
      <template #item.isDefault="{ item }">
        <v-icon v-if="item.isDefault" color="primary">mdi-star</v-icon>
      </template>
      <template #item.isActive="{ item }">
        <v-icon :color="item.isActive ? 'success' : 'grey'">
          {{ item.isActive ? 'mdi-check-circle' : 'mdi-close-circle' }}
        </v-icon>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="openDialog(item)" />
        <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
      </template>
    </data-table>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.add') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field
              v-model="form.name"
              :label="$t('common.name')"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.bankName"
              :label="$t('accounting.bank')"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.accountNumber"
              :label="$t('accounting.accountNumber')"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.iban"
              :label="$t('accounting.iban')"
            />
            <v-text-field
              v-model="form.swift"
              :label="$t('accounting.swift')"
            />
            <v-autocomplete
              v-model="form.accountId"
              :label="$t('accounting.linkedAccount')"
              :items="accountOptions"
              item-title="label"
              item-value="_id"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="form.currency"
              :label="$t('common.currency')"
              :rules="[rules.required]"
            />
            <v-switch
              v-model="form.isDefault"
              :label="$t('accounting.defaultAccount')"
              color="primary"
            />
            <v-switch
              v-model="form.isActive"
              :label="$t('common.active')"
              color="primary"
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
import { useAccountingStore, type BankAccount } from '../../store/accounting.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import DataTable from 'ui-shared/components/DataTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

const appStore = useAppStore()
const store = useAccountingStore()
const { t } = useI18n()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const accountOptions = computed(() =>
  store.accounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const emptyForm = () => ({
  name: '',
  bankName: '',
  accountNumber: '',
  iban: '',
  swift: '',
  accountId: '',
  currency: 'EUR',
  isDefault: false,
  isActive: true,
})

const form = ref(emptyForm())

const headers = computed(() => [
  { title: t('common.name'), key: 'name' },
  { title: t('accounting.bank'), key: 'bankName' },
  { title: t('accounting.accountNumber'), key: 'accountNumber' },
  { title: t('accounting.iban'), key: 'iban' },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.balance'), key: 'balance', align: 'end' as const },
  { title: t('accounting.default'), key: 'isDefault', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const rules = {
  required: (v: string) => !!v || 'Required',
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function openDialog(item?: BankAccount | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    const bank = item as BankAccount
    editing.value = true
    selectedId.value = bank._id
    form.value = {
      name: bank.name,
      bankName: (bank as any).bankName || '',
      accountNumber: bank.accountNumber,
      iban: (bank as any).iban || '',
      swift: (bank as any).swift || '',
      accountId: (bank as any).accountId || '',
      currency: bank.currency,
      isDefault: (bank as any).isDefault || false,
      isActive: bank.isActive,
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
    await httpClient.put(`${orgUrl()}/accounting/bank-account/${selectedId.value}`, form.value)
  } else {
    await httpClient.post(`${orgUrl()}/accounting/bank-account`, form.value)
  }
  await store.fetchBankAccounts()
  dialog.value = false
}

function confirmDelete(item: BankAccount) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  await httpClient.delete(`${orgUrl()}/accounting/bank-account/${selectedId.value}`)
  await store.fetchBankAccounts()
  deleteDialog.value = false
}

onMounted(() => {
  store.fetchBankAccounts()
  store.fetchAccounts()
})
</script>
