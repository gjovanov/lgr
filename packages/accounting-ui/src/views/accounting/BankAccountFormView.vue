<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('accounting.bankAccount') : $t('common.create') + ' ' + $t('accounting.bankAccount')"
    :subtitle="isEdit ? form.name : ''"
    :actions="formActions"
    :loading="loading"
    back-to="/bank-accounts"
    :back-label="$t('accounting.bankAccounts')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="form.name"
            :label="$t('common.name')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="form.bankName"
            :label="$t('accounting.bank')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="form.accountNumber"
            :label="$t('accounting.accountNumber')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="form.iban"
            :label="$t('accounting.iban')"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="form.swift"
            :label="$t('accounting.swift')"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-autocomplete
            v-model="form.accountId"
            :label="$t('accounting.linkedAccount')"
            :items="accountOptions"
            item-title="label"
            item-value="_id"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.currency"
            :label="$t('common.currency')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch
            v-model="form.isDefault"
            :label="$t('accounting.defaultAccount')"
            color="primary"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch
            v-model="form.isActive"
            :label="$t('common.active')"
            color="primary"
            density="compact"
          />
        </v-col>
      </v-row>
    </v-form>

    <!-- FR-25a §3.3: the books' analytic that points here (`БАНКОВИ СМЕТКИ:<iban>`), read-only. None: nothing shows. -->
    <div v-if="analytics.length" class="d-flex align-center flex-wrap ga-2 mt-2" data-testid="bank-account-analytic">
      <v-icon size="small">mdi-lock-outline</v-icon>
      <span class="text-body-2 text-medium-emphasis" :title="$t('accounting.bankAccountBooks.analyticHint')">{{ $t('accounting.bankAccountBooks.analytic') }}:</span>
      <entity-link v-for="a in analytics" :key="a._id" :label="a.path" :to="{ name: 'accounting.analytic', params: { id: a._id } }" />
    </div>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="bankAccount" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import EntityLink from 'ui-shared/components/EntityLink.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useAccountingStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)

/** FR-25a §3.3: the analytics that point at this bank account (the import links one per account). */
const analytics = ref<{ _id: string; path: string }[]>([])

async function loadAnalytics() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/analytics`, { params: { bankAccountId: route.params.id, size: 5 } })
    analytics.value = data.analytics ?? []
  } catch {
    // A role that reads bank accounts but not the chart's analytics sees the form as before.
    analytics.value = []
  }
}

const form = ref({
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

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'bankAccount',
  icon: 'mdi-bank',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Name', value: form.value.name || '' },
    { label: 'IBAN', value: form.value.iban || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const accountOptions = computed(() =>
  store.accounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), color: 'primary', handler: handleSubmit, cap: isEdit.value ? ['bank-accounts.create', 'bank-accounts.edit'] : 'bank-accounts.create', loading: loading.value },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/accounting/bank-account/${route.params.id}`, form.value)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/bank-account`, form.value)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.bank-accounts' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function loadBankAccount() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/bank-account/${route.params.id}`)
    const bank = data.bankAccount || data
    form.value = {
      name: bank.name || '',
      bankName: bank.bankName || '',
      accountNumber: bank.accountNumber || '',
      iban: bank.iban || '',
      swift: bank.swift || '',
      accountId: bank.accountId || '',
      currency: bank.currency || 'EUR',
      isDefault: bank.isDefault || false,
      isActive: bank.isActive !== false,
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (isEdit.value) void loadAnalytics()
  await store.fetchAccounts()
  if (tryRestore()) return
  if (isEdit.value) {
    await loadBankAccount()
  }
})
</script>
