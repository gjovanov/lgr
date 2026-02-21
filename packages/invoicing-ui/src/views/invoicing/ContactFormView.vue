<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isEdit ? $t('invoicing.editContact') : $t('invoicing.newContact') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-tabs v-model="tab">
            <v-tab value="general">{{ $t('invoicing.generalInfo') }}</v-tab>
            <v-tab value="addresses">{{ $t('invoicing.addresses') }}</v-tab>
            <v-tab value="bank">{{ $t('invoicing.bankDetails') }}</v-tab>
          </v-tabs>

          <v-tabs-window v-model="tab" class="mt-6 pt-4">
            <!-- General Info -->
            <v-tabs-window-item value="general">
              <v-row>
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
              <v-row>
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
              <v-row>
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
              <v-row>
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
            </v-tabs-window-item>

            <!-- Addresses -->
            <v-tabs-window-item value="addresses">
              <div v-for="(addr, i) in form.addresses" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ $t('invoicing.address') }} {{ i + 1 }}</span>
                  <v-chip v-if="addr.type" size="small" class="ml-2" label>{{ addr.type }}</v-chip>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="form.addresses.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-select
                      v-model="addr.type"
                      :label="$t('common.type')"
                      :items="['billing', 'shipping', 'office']"
                      density="compact"
                    />
                  </v-col>
                </v-row>
                <v-text-field v-model="addr.street" :label="$t('invoicing.street')" density="compact" class="mb-1" />
                <v-row>
                  <v-col cols="4">
                    <v-text-field v-model="addr.city" :label="$t('invoicing.city')" density="compact" />
                  </v-col>
                  <v-col cols="4">
                    <v-text-field v-model="addr.postalCode" :label="$t('invoicing.postalCode')" density="compact" />
                  </v-col>
                  <v-col cols="4">
                    <v-text-field v-model="addr.country" :label="$t('invoicing.country')" density="compact" />
                  </v-col>
                </v-row>
              </div>
              <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addAddress">
                {{ $t('invoicing.addAddress') }}
              </v-btn>
            </v-tabs-window-item>

            <!-- Bank Details -->
            <v-tabs-window-item value="bank">
              <div v-for="(bank, i) in form.bankDetails" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ $t('invoicing.bankAccount') }} {{ i + 1 }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="form.bankDetails.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="bank.bankName" :label="$t('invoicing.bankName')" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="bank.accountNumber" :label="$t('invoicing.accountNumber')" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="bank.currency" :label="$t('common.currency')" density="compact" />
                  </v-col>
                </v-row>
                <v-row>
                  <v-col cols="12" md="6">
                    <v-text-field v-model="bank.iban" label="IBAN" density="compact" />
                  </v-col>
                  <v-col cols="12" md="6">
                    <v-text-field v-model="bank.swift" label="SWIFT/BIC" density="compact" />
                  </v-col>
                </v-row>
              </div>
              <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addBankAccount">
                {{ $t('invoicing.addBankAccount') }}
              </v-btn>
            </v-tabs-window-item>
          </v-tabs-window>

          <div class="d-flex justify-end mt-6">
            <v-btn variant="text" class="mr-2" @click="router.back()">{{ $t('common.cancel') }}</v-btn>
            <v-btn type="submit" color="primary" :loading="loading">{{ $t('common.save') }}</v-btn>
          </div>
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const formRef = ref()
const loading = ref(false)
const tab = ref('general')
const isEdit = computed(() => !!route.params.id)

const form = reactive({
  companyName: '',
  firstName: '',
  lastName: '',
  type: 'customer' as string,
  email: '',
  phone: '',
  mobile: '',
  taxId: '',
  registrationNumber: '',
  paymentTermsDays: 30,
  website: '',
  isActive: true,
  notes: '',
  addresses: [] as Array<{ type: string; street: string; city: string; postalCode: string; country: string; isDefault: boolean }>,
  bankDetails: [] as Array<{ bankName: string; accountNumber: string; iban: string; swift: string; currency: string; isDefault: boolean }>,
})

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function addAddress() {
  form.addresses.push({ type: 'billing', street: '', city: '', postalCode: '', country: '', isDefault: false })
}

function addBankAccount() {
  form.bankDetails.push({ bankName: '', accountNumber: '', iban: '', swift: '', currency: 'EUR', isDefault: false })
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
    router.push({ name: 'invoicing.contacts' })
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact/${route.params.id}`)
      const contact = data
      Object.assign(form, {
        companyName: contact.companyName || '',
        firstName: contact.firstName || '',
        lastName: contact.lastName || '',
        type: contact.type || 'customer',
        email: contact.email || '',
        phone: contact.phone || '',
        mobile: contact.mobile || '',
        taxId: contact.taxId || '',
        registrationNumber: contact.registrationNumber || '',
        paymentTermsDays: contact.paymentTermsDays ?? 30,
        website: contact.website || '',
        isActive: contact.isActive ?? true,
        notes: contact.notes || '',
        addresses: contact.addresses || [],
        bankDetails: contact.bankDetails || [],
      })
    } catch (err) {
      console.error('Failed to load contact:', err)
    }
  }
})
</script>
