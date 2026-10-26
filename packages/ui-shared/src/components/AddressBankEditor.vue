<template>
  <div>
    <!-- Addresses -->
    <div class="d-flex align-center mb-2">
      <h3 class="text-subtitle-2 font-weight-bold">{{ $t('invoicing.addresses') }}</h3>
      <v-spacer />
      <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addAddress">
        {{ $t('invoicing.addAddress') }}
      </v-btn>
    </div>
    <div v-for="(addr, i) in addresses" :key="`addr-${i}`" class="mb-3 pa-3 border rounded">
      <div class="d-flex align-center mb-2">
        <span class="text-caption">{{ $t('invoicing.address') }} {{ i + 1 }}</span>
        <v-chip v-if="addr.type" size="x-small" class="ml-2" label>{{ $t(`invoicing.addressType.${addr.type}`, addr.type) }}</v-chip>
        <v-spacer />
        <v-btn
          icon="mdi-delete"
          variant="text"
          size="x-small"
          color="error"
          :title="$t('common.delete')"
          :aria-label="$t('common.delete')"
          @click="removeAddress(i)"
        />
      </div>
      <v-row dense>
        <v-col cols="12" md="3">
          <v-select v-model="addr.type" :label="`${$t('common.type')} *`" :items="addressTypes" :rules="[required]" />
        </v-col>
        <v-col cols="12" md="9">
          <v-text-field v-model="addr.street" :label="`${$t('invoicing.street')} *`" :rules="[required]" />
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
      <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addBank">
        {{ $t('invoicing.addBankAccount') }}
      </v-btn>
    </div>
    <div v-for="(bank, i) in bankDetails" :key="`bank-${i}`" class="mb-3 pa-3 border rounded">
      <div class="d-flex align-center mb-2">
        <span class="text-caption">{{ $t('invoicing.bankAccount') }} {{ i + 1 }}</span>
        <v-spacer />
        <v-btn
          icon="mdi-delete"
          variant="text"
          size="x-small"
          color="error"
          :title="$t('common.delete')"
          :aria-label="$t('common.delete')"
          @click="removeBank(i)"
        />
      </div>
      <v-row dense>
        <v-col cols="12" md="4">
          <v-text-field v-model="bank.bankName" :label="`${$t('invoicing.bankName')} *`" :rules="[required]" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="bank.accountNumber" :label="`${$t('invoicing.accountNumber')} *`" :rules="[required]" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="bank.currency" :label="$t('common.currency')" />
        </v-col>
      </v-row>
      <v-row dense>
        <v-col cols="12" md="6">
          <v-text-field v-model="bank.iban" label="IBAN" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model="bank.swift" label="SWIFT/BIC" />
        </v-col>
      </v-row>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Shared address + bank-details sub-editor. Extracted verbatim from the duplicated
 * markup in invoicing-ui's ContactFormView and ContactAutocompleteWithCreate (now in
 * ui-shared) so the exact same fields/behavior render in both places (and any future
 * contact editor).
 *
 * Both arrays are bound via v-model and mutated in place:
 *   <AddressBankEditor v-model:addresses="form.addresses" v-model:bankDetails="form.bankDetails" />
 *
 * Field labels rely on the existing invoicing.* / common.* i18n keys. The editor is
 * typically mounted inside a <v-defaults-provider> (compact/outlined inputs); it does
 * not impose its own density so the host's defaults flow through.
 *
 * Fields marked `*` are the ones the Contact model refuses to store empty (address type and
 * street, bank name and account number). They are checked here, inside the host's <v-form>,
 * so a missing one is pointed at in the form rather than coming back from the server as a
 * validation error naming a schema path. Country is required by the model too, but it has a
 * default (BG) the server applies when the box is left empty.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export interface EditableAddress {
  type: string
  street: string
  city: string
  postalCode: string
  country: string
  isDefault: boolean
  [key: string]: any
}

export interface EditableBankDetail {
  bankName: string
  accountNumber: string
  iban: string
  swift: string
  currency: string
  isDefault: boolean
  [key: string]: any
}

const addresses = defineModel<EditableAddress[]>('addresses', { default: () => [] })
const bankDetails = defineModel<EditableBankDetail[]>('bankDetails', { default: () => [] })

const { t } = useI18n()
const required = (v: unknown) => (typeof v === 'string' ? !!v.trim() : !!v) || t('validation.required')
const addressTypes = computed(() => ['billing', 'shipping', 'office'].map(value => ({
  title: t(`invoicing.addressType.${value}`),
  value,
})))

function addAddress() {
  addresses.value.push({ type: 'billing', street: '', city: '', postalCode: '', country: '', isDefault: false })
}

function removeAddress(i: number) {
  addresses.value.splice(i, 1)
}

function addBank() {
  bankDetails.value.push({ bankName: '', accountNumber: '', iban: '', swift: '', currency: 'EUR', isDefault: false })
}

function removeBank(i: number) {
  bankDetails.value.splice(i, 1)
}
</script>
