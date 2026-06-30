<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editContact') : $t('invoicing.newContact')"
    :subtitle="isEdit ? contactName : ''"
    :actions="formActions"
    :smart-buttons="isEdit ? smartButtons : undefined"
    :loading="loading"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
    back-to="/contacts"
  >
    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-defaults-provider :defaults="{
            VTextField: { density: 'compact', variant: 'outlined' },
            VSelect: { density: 'compact', variant: 'outlined' },
            VAutocomplete: { density: 'compact', variant: 'outlined' },
            VTextarea: { density: 'compact', variant: 'outlined' },
            VSwitch: { density: 'compact' },
          }">
            <!-- General Info -->
            <h3 class="text-subtitle-2 font-weight-bold mb-2">{{ $t('invoicing.generalInfo') }}</h3>
            <v-row dense>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.companyName" :label="$t('invoicing.companyName')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select
                  v-model="form.type"
                  :label="$t('common.type')"
                  :items="[
                    { title: $t('invoicing.customer'), value: 'customer' },
                    { title: $t('invoicing.supplier'), value: 'supplier' },
                    { title: $t('invoicing.both'), value: 'both' },
                  ]"
                  :rules="[rules.required]"
                />
              </v-col>
            </v-row>
            <v-row dense>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.firstName" :label="$t('common.firstName')" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.lastName" :label="$t('common.lastName')" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.email" :label="$t('invoicing.email')" type="email" />
              </v-col>
            </v-row>
            <v-row dense>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.phone" :label="$t('invoicing.phone')" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.mobile" :label="$t('invoicing.mobile')" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.taxId" :label="$t('invoicing.taxId')" />
              </v-col>
            </v-row>
            <v-row dense>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.taxNumber" :label="$t('invoicing.taxNumber')">
                  <template #append-inner>
                    <v-btn icon="mdi-magnify" size="x-small" variant="text" :loading="lookingUp" :title="$t('invoicing.lookupCompany')" :aria-label="$t('invoicing.lookupCompany')" @click="lookupByTaxNumber" />
                  </template>
                </v-text-field>
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.vatNumber" :label="$t('invoicing.vatNumber')">
                  <template #append-inner>
                    <v-btn icon="mdi-magnify" size="x-small" variant="text" :loading="lookingUp" :title="$t('invoicing.lookupCompany')" :aria-label="$t('invoicing.lookupCompany')" @click="lookupByVatNumber" />
                  </template>
                </v-text-field>
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field
                  v-model.number="form.paymentTermsDays"
                  :label="$t('invoicing.paymentTerms')"
                  type="number"
                  :suffix="$t('invoicing.days')"
                />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.website" :label="$t('invoicing.website')" />
              </v-col>
              <v-col cols="12" md="4">
                <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" />
              </v-col>
            </v-row>
            <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" />

            <v-divider class="my-4" />

            <AddressBankEditor v-model:addresses="form.addresses" v-model:bankDetails="form.bankDetails" />

            <TagInput v-model="form.tags" type="contact" :org-url="orgUrl()" class="mt-4" />
          </v-defaults-provider>
        </v-form>
      </v-card-text>
    </v-card>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="contact" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog v-model="invoicesDialog" :contact-id="route.params.id as string" :org-url="orgUrl()" :selectable="false" />
    <ContactLedgerDialog v-model="balanceDialog" :contact-id="route.params.id as string" :org-url="orgUrl()" :selectable="false" />
    <ContactMovementsDialog v-model="movementsDialog" :contact-id="route.params.id as string" :org-url="orgUrl()" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TagInput from 'ui-shared/components/TagInput.vue'
import AddressBankEditor from 'ui-shared/components/AddressBankEditor.vue'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import ContactMovementsDialog from '../components/ContactMovementsDialog.vue'
import type { FormAction, SmartButtonDef } from 'ui-shared/components/EntityFormShell.vue'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useCurrency } from 'ui-shared/composables/useCurrency'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')

const invoicesDialog = ref(false)
const balanceDialog = ref(false)
const movementsDialog = ref(false)
const summary = ref<{ invoiceCount: number; openBalance: number | null; currency: string | null; mixedCurrency: boolean; movementCount: number }>({
  invoiceCount: 0,
  openBalance: 0,
  currency: null,
  mixedCurrency: false,
  movementCount: 0,
})

async function fetchSummary() {
  if (!isEdit.value) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact/${route.params.id}/summary`)
    summary.value = data
  } catch { /* keep defaults */ }
}

const form = reactive({
  companyName: '',
  firstName: '',
  lastName: '',
  type: 'customer' as string,
  email: '',
  phone: '',
  mobile: '',
  taxId: '',
  taxNumber: '',
  vatNumber: '',
  registrationNumber: '',
  paymentTermsDays: 30,
  website: '',
  isActive: true,
  notes: '',
  addresses: [] as Array<{ type: string; street: string; city: string; postalCode: string; country: string; isDefault: boolean }>,
  bankDetails: [] as Array<{ bankName: string; accountNumber: string; iban: string; swift: string; currency: string; isDefault: boolean }>,
  tags: [] as string[],
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'contact',
  icon: 'mdi-contacts',
  getFormData: () => ({ ...form }),
  getPreviewFields: () => [
    { label: 'Company', value: form.companyName },
    { label: 'Type', value: form.type },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const lookingUp = ref(false)

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const contactName = computed(() => {
  const parts = [form.companyName, form.firstName, form.lastName].filter(Boolean)
  return parts.join(' — ') || ''
})

const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = [
    {
      label: t('common.save'),
      icon: 'mdi-content-save',
      color: 'primary',
      handler: handleSubmit,
      loading: loading.value,
    },
  ]
  if (isEdit.value && form.isActive) {
    actions.push({
      label: t('common.archive'),
      icon: 'mdi-archive',
      color: 'warning',
      variant: 'outlined',
      handler: () => {
        form.isActive = false
        handleSubmit()
      },
    })
  }
  return actions
})

const balanceLabel = computed(() => {
  if (summary.value.mixedCurrency) return '—'
  return formatCurrency(summary.value.openBalance ?? 0, summary.value.currency || baseCurrency.value)
})

const smartButtons = computed<SmartButtonDef[]>(() => [
  {
    label: t('invoicing.invoices'),
    value: summary.value.invoiceCount,
    icon: 'mdi-receipt-text',
    handler: () => { invoicesDialog.value = true },
  },
  {
    label: t('invoicing.openBalance'),
    value: balanceLabel.value,
    icon: 'mdi-cash',
    handler: () => { balanceDialog.value = true },
  },
  {
    label: t('invoicing.movements'),
    value: summary.value.movementCount,
    icon: 'mdi-swap-horizontal',
    handler: () => { movementsDialog.value = true },
  },
])

async function doLookup(value: string) {
  if (!value?.trim()) return
  lookingUp.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact/lookup/${encodeURIComponent(value.trim())}`)
    const info = data.company || data
    // Always fill taxNumber/vatNumber when returned
    if (info.taxNumber) form.taxNumber = info.taxNumber
    if (info.vatNumber) form.vatNumber = info.vatNumber
    if (info.companyName) form.companyName = info.companyName
    if (info.address) {
      if (!form.addresses.length) {
        form.addresses.push({ type: 'billing', street: '', city: '', postalCode: '', country: '', isDefault: true })
      }
      const addr = form.addresses[0]
      if (info.address.street) addr.street = info.address.street
      if (info.address.city) addr.city = info.address.city
      if (info.address.postalCode) addr.postalCode = info.address.postalCode
      if (info.address.country) addr.country = info.address.country
    }
    showSuccess(info.companyName ? t('invoicing.companyFound') : t('invoicing.vatConfirmed'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('invoicing.companyNotFound'))
  } finally {
    lookingUp.value = false
  }
}

function lookupByTaxNumber() {
  doLookup(form.taxNumber)
}

function lookupByVatNumber() {
  doLookup(form.vatNumber)
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoicing/contact/${route.params.id}`, form)
    } else {
      await httpClient.post(`${orgUrl()}/invoicing/contact`, form)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'invoicing.contacts' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (tryRestore()) return
  if (isEdit.value) {
    fetchSummary()
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact/${route.params.id}`)
      const contact = data.contact || data
      Object.assign(form, {
        companyName: contact.companyName || '',
        firstName: contact.firstName || '',
        lastName: contact.lastName || '',
        type: contact.type || 'customer',
        email: contact.email || '',
        phone: contact.phone || '',
        mobile: contact.mobile || '',
        taxId: contact.taxId || '',
        taxNumber: contact.taxNumber || '',
        vatNumber: contact.vatNumber || '',
        registrationNumber: contact.registrationNumber || '',
        paymentTermsDays: contact.paymentTermsDays ?? 30,
        website: contact.website || '',
        isActive: contact.isActive ?? true,
        notes: contact.notes || '',
        addresses: contact.addresses || [],
        bankDetails: contact.bankDetails || [],
        tags: contact.tags || [],
      })
    } catch (err) {
      console.error('Failed to load contact:', err)
    }
  }
})
</script>
