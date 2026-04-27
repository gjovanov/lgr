<template>
  <div>
    <v-autocomplete
      :model-value="modelValue"
      @update:model-value="$emit('update:modelValue', $event)"
      :label="label"
      :items="allItems"
      item-title="companyName"
      item-value="_id"
      :rules="required ? [rules.required] : []"
      clearable
      :no-filter="false"
    >
      <template #append-item>
        <v-divider />
        <v-list-item prepend-icon="mdi-plus" :title="$t('invoicing.createContact')" @click="openCreateDialog" />
      </template>
    </v-autocomplete>

    <!-- Inline Create Contact Dialog — wide, mirrors ContactFormView layout -->
    <v-dialog v-model="createDialog" max-width="1400" scrollable persistent>
      <v-card>
        <v-toolbar color="surface" flat density="compact">
          <v-toolbar-title class="text-body-1 font-weight-bold">{{ $t('invoicing.createContact') }}</v-toolbar-title>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="createDialog = false" />
        </v-toolbar>
        <v-card-text class="pa-4">
          <v-form ref="createFormRef">
            <v-defaults-provider :defaults="{
              VTextField: { density: 'compact', variant: 'outlined' },
              VSelect: { density: 'compact', variant: 'outlined' },
              VAutocomplete: { density: 'compact', variant: 'outlined' },
              VTextarea: { density: 'compact', variant: 'outlined' },
            }">
              <h3 class="text-subtitle-2 font-weight-bold mb-2">{{ $t('invoicing.generalInfo') }}</h3>
              <v-row dense>
                <v-col cols="12" md="6">
                  <v-text-field v-model="newContact.companyName" :label="$t('invoicing.companyName')" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="6">
                  <v-select
                    v-model="newContact.type"
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
                  <v-text-field v-model="newContact.firstName" :label="$t('common.firstName')" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.lastName" :label="$t('common.lastName')" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.email" :label="$t('invoicing.email')" type="email" />
                </v-col>
              </v-row>
              <v-row dense>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.phone" :label="$t('invoicing.phone')" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.mobile" :label="$t('invoicing.mobile')" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.taxId" :label="$t('invoicing.taxId')" />
                </v-col>
              </v-row>
              <v-row dense>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.taxNumber" :label="$t('invoicing.taxNumber')">
                    <template #append-inner>
                      <v-btn icon="mdi-magnify" size="x-small" variant="text" :loading="lookingUp" :title="$t('invoicing.lookupCompany')" @click="doLookup(newContact.taxNumber)" />
                    </template>
                  </v-text-field>
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.vatNumber" :label="$t('invoicing.vatNumber')">
                    <template #append-inner>
                      <v-btn icon="mdi-magnify" size="x-small" variant="text" :loading="lookingUp" :title="$t('invoicing.lookupCompany')" @click="doLookup(newContact.vatNumber)" />
                    </template>
                  </v-text-field>
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="newContact.website" :label="$t('invoicing.website')" />
                </v-col>
              </v-row>

              <v-divider class="my-4" />

              <!-- Addresses -->
              <div class="d-flex align-center mb-2">
                <h3 class="text-subtitle-2 font-weight-bold">{{ $t('invoicing.addresses') }}</h3>
                <v-spacer />
                <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addAddress">
                  {{ $t('invoicing.addAddress') }}
                </v-btn>
              </div>
              <div v-for="(addr, i) in newContact.addresses" :key="`addr-${i}`" class="mb-3 pa-3 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-caption">{{ $t('invoicing.address') }} {{ i + 1 }}</span>
                  <v-chip v-if="addr.type" size="x-small" class="ml-2" label>{{ addr.type }}</v-chip>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="x-small" color="error" @click="newContact.addresses.splice(i, 1)" />
                </div>
                <v-row dense>
                  <v-col cols="12" md="3">
                    <v-select v-model="addr.type" :label="$t('common.type')" :items="['billing', 'shipping', 'office']" />
                  </v-col>
                  <v-col cols="12" md="9">
                    <v-text-field v-model="addr.street" :label="$t('invoicing.street')" />
                  </v-col>
                </v-row>
                <v-row dense>
                  <v-col cols="4">
                    <v-text-field v-model="addr.city" :label="$t('invoicing.city')" />
                  </v-col>
                  <v-col cols="4">
                    <v-text-field v-model="addr.postalCode" :label="$t('invoicing.postalCode')" />
                  </v-col>
                  <v-col cols="4">
                    <v-text-field v-model="addr.country" :label="$t('invoicing.country')" />
                  </v-col>
                </v-row>
              </div>

              <v-divider class="my-4" />

              <!-- Bank Details -->
              <div class="d-flex align-center mb-2">
                <h3 class="text-subtitle-2 font-weight-bold">{{ $t('invoicing.bankDetails') }}</h3>
                <v-spacer />
                <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addBankAccount">
                  {{ $t('invoicing.addBankAccount') }}
                </v-btn>
              </div>
              <div v-for="(bank, i) in newContact.bankDetails" :key="`bank-${i}`" class="mb-3 pa-3 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-caption">{{ $t('invoicing.bankAccount') }} {{ i + 1 }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="x-small" color="error" @click="newContact.bankDetails.splice(i, 1)" />
                </div>
                <v-row dense>
                  <v-col cols="12" md="4"><v-text-field v-model="bank.bankName" :label="$t('invoicing.bankName')" /></v-col>
                  <v-col cols="12" md="4"><v-text-field v-model="bank.accountNumber" :label="$t('invoicing.accountNumber')" /></v-col>
                  <v-col cols="12" md="4"><v-text-field v-model="bank.currency" :label="$t('common.currency')" /></v-col>
                </v-row>
                <v-row dense>
                  <v-col cols="12" md="6"><v-text-field v-model="bank.iban" label="IBAN" /></v-col>
                  <v-col cols="12" md="6"><v-text-field v-model="bank.swift" label="SWIFT/BIC" /></v-col>
                </v-row>
              </div>
            </v-defaults-provider>
          </v-form>
        </v-card-text>
        <v-card-actions class="px-4 py-2">
          <v-spacer />
          <v-btn variant="text" @click="createDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" @click="saveContact">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

interface Contact { _id: string; companyName: string; [key: string]: any }

const props = defineProps<{
  modelValue: string
  contacts: Contact[]
  label: string
  required?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'contact-created': [contact: Contact]
}>()

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const createDialog = ref(false)
const createFormRef = ref()
const saving = ref(false)
const lookingUp = ref(false)

const emptyAddress = () => ({ type: 'billing', street: '', city: '', postalCode: '', country: '', isDefault: true })
const emptyBank = () => ({ bankName: '', accountNumber: '', iban: '', swift: '', currency: 'EUR', isDefault: false })
const emptyContact = () => ({
  companyName: '',
  type: 'customer',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  mobile: '',
  taxId: '',
  taxNumber: '',
  vatNumber: '',
  website: '',
  addresses: [] as Array<ReturnType<typeof emptyAddress>>,
  bankDetails: [] as Array<ReturnType<typeof emptyBank>>,
})
const newContact = ref(emptyContact())

function addAddress() { newContact.value.addresses.push(emptyAddress()) }
function addBankAccount() { newContact.value.bankDetails.push(emptyBank()) }

const allItems = computed(() => props.contacts)
const rules = { required: (v: string) => !!v || t('validation.required') }

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreateDialog() {
  newContact.value = emptyContact()
  createDialog.value = true
}

async function doLookup(value: string) {
  if (!value?.trim()) return
  lookingUp.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact/lookup/${encodeURIComponent(value.trim())}`)
    const info = data.company || data
    if (info.taxNumber) newContact.value.taxNumber = info.taxNumber
    if (info.vatNumber) newContact.value.vatNumber = info.vatNumber
    if (info.companyName) newContact.value.companyName = info.companyName
    if (info.address) {
      const billing = newContact.value.addresses.find(a => a.type === 'billing') || emptyAddress()
      billing.street = info.address.street || billing.street
      billing.city = info.address.city || billing.city
      billing.postalCode = info.address.postalCode || billing.postalCode
      billing.country = info.address.country || billing.country
      if (!newContact.value.addresses.includes(billing)) newContact.value.addresses.push(billing)
    }
    showSuccess(info.companyName ? t('invoicing.companyFound') : t('invoicing.vatConfirmed'))
  } catch {
    showError(t('invoicing.companyNotFound'))
  } finally {
    lookingUp.value = false
  }
}

async function saveContact() {
  const { valid } = await createFormRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    const payload: Record<string, any> = {
      companyName: newContact.value.companyName,
      type: newContact.value.type,
    }
    for (const k of ['firstName', 'lastName', 'email', 'phone', 'mobile', 'taxId', 'taxNumber', 'vatNumber', 'website'] as const) {
      const v = (newContact.value as any)[k]
      if (v) payload[k] = v
    }
    const validAddresses = newContact.value.addresses.filter(a => a.street || a.city || a.postalCode || a.country)
    if (validAddresses.length) payload.addresses = validAddresses
    const validBanks = newContact.value.bankDetails.filter(b => b.bankName || b.accountNumber || b.iban)
    if (validBanks.length) payload.bankDetails = validBanks

    const { data } = await httpClient.post(`${orgUrl()}/invoicing/contact`, payload)
    const created = data.contact || data
    showSuccess(t('invoicing.contactCreated'))
    emit('contact-created', created)
    emit('update:modelValue', created._id || created.id)
    createDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}
</script>
