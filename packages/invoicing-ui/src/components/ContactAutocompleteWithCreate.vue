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

    <!-- Inline Create Contact Dialog -->
    <v-dialog v-model="createDialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ $t('invoicing.createContact') }}</v-card-title>
        <v-card-text>
          <v-form ref="createFormRef">
            <v-row>
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
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="newContact.taxNumber" :label="$t('invoicing.taxNumber')">
                  <template #append-inner>
                    <v-btn icon="mdi-magnify" size="x-small" variant="text" :loading="lookingUp" @click="doLookup(newContact.taxNumber)" />
                  </template>
                </v-text-field>
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="newContact.vatNumber" :label="$t('invoicing.vatNumber')">
                  <template #append-inner>
                    <v-btn icon="mdi-magnify" size="x-small" variant="text" :loading="lookingUp" @click="doLookup(newContact.vatNumber)" />
                  </template>
                </v-text-field>
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="newContact.email" :label="$t('invoicing.email')" type="email" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="newContact.phone" :label="$t('invoicing.phone')" />
              </v-col>
            </v-row>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="createDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="saveContact">{{ $t('common.save') }}</v-btn>
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

const emptyContact = () => ({
  companyName: '', type: 'customer', taxNumber: '', vatNumber: '', email: '', phone: '',
})
const newContact = ref(emptyContact())

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
    if (info.companyName) newContact.value.companyName = info.companyName
    if (info.taxNumber) newContact.value.taxNumber = info.taxNumber
    if (info.vatNumber) newContact.value.vatNumber = info.vatNumber
    showSuccess(t('invoicing.companyFound'))
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
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/contact`, newContact.value)
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
