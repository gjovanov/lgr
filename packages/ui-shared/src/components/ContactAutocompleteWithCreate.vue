<template>
  <div>
    <v-autocomplete
      :model-value="modelValue"
      @update:model-value="$emit('update:modelValue', $event)"
      @update:search="onSearch"
      :label="label"
      :items="allItems"
      :item-title="contactTitle"
      item-value="_id"
      :rules="required ? [rules.required] : []"
      clearable
      no-filter
      :loading="loading"
      :disabled="disabled"
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
                  <v-text-field v-model="newContact.companyName" :label="`${$t('invoicing.companyName')} *`" :rules="[rules.required]" autofocus />
                </v-col>
                <v-col cols="12" md="6">
                  <v-select
                    v-model="newContact.type"
                    :label="`${$t('common.type')} *`"
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
                  <v-text-field v-model="newContact.email" :label="$t('invoicing.email')" type="email" :rules="[rules.email]" />
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

              <AddressBankEditor v-model:addresses="newContact.addresses" v-model:bankDetails="newContact.bankDetails" />

              <p class="text-caption text-medium-emphasis mt-3 mb-0">{{ $t('common.requiredFieldsNote') }}</p>
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
/**
 * A party picker that can also create the party: the invoice forms' „Клиент", the cash sale's
 * customer and the goods receipt's „Доставчик".
 *
 * Promoted from invoicing-ui (FR-22.6) so the receipt form in inventory-ui could use it. It only
 * SHOWS `contacts`: the caller owns the list and answers `update:search` with a server query —
 * `useContactSearch` does that for a form that has no list of its own, `useDocumentForm` does it
 * for the invoice forms.
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../composables/useHttpClient'
import { useSnackbar } from '../composables/useSnackbar'
import { contactTitle } from '../composables/useContactSearch'
import { buildContactPayload, isValidOptionalEmail } from '../composables/contact-payload'
import AddressBankEditor from './AddressBankEditor.vue'

interface Contact { _id: string; companyName?: string; [key: string]: any }

const props = defineProps<{
  modelValue: string | null | undefined
  contacts: Contact[]
  label: string
  /** `/org/<id>` of the tab's org: where a new contact is created and looked up. */
  orgUrl: string
  required?: boolean
  loading?: boolean
  disabled?: boolean
  /** The type a contact created here starts as: a supplier on a receipt, a customer elsewhere. */
  newContactType?: 'customer' | 'supplier' | 'both'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:search': [value: string]
  'contact-created': [contact: Contact]
}>()

const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

/**
 * Vuetify writes the chosen contact's name back into the search box. That is not a query: passed
 * on, it would narrow the list to the one contact already chosen.
 */
function onSearch(text: string) {
  const chosen = props.contacts.find(c => c._id === props.modelValue)
  if (chosen && text === contactTitle(chosen)) return
  emit('update:search', text)
}

const createDialog = ref(false)
const createFormRef = ref()
const saving = ref(false)
const lookingUp = ref(false)

const emptyAddress = () => ({ type: 'billing', street: '', city: '', postalCode: '', country: '', isDefault: true })
const emptyBank = () => ({ bankName: '', accountNumber: '', iban: '', swift: '', currency: 'EUR', isDefault: false })
const emptyContact = () => ({
  companyName: '',
  type: props.newContactType || 'customer',
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

const allItems = computed(() => props.contacts)
const rules = {
  required: (v: string) => !!v || t('validation.required'),
  email: (v: string) => isValidOptionalEmail(v) || t('validation.invalidEmail'),
}

function orgUrl() { return props.orgUrl }

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
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/contact`, buildContactPayload(newContact.value, 'create'))
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

// The document banner has its own "new contact" button: the create entry at the foot of the
// dropdown is only found by scrolling past every listed contact.
defineExpose({ openCreateDialog })
</script>
