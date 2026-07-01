<template>
  <v-row dense>
    <!-- Col 1: Client / buyer -->
    <v-col cols="12" md="4">
      <p class="text-caption text-medium-emphasis mb-1">{{ $t(config.partyLabelKey) }}</p>
      <div class="d-flex align-center ga-1 mb-1">
        <ContactAutocompleteWithCreate
          v-if="config.partyPicker === 'create'"
          v-model="form.contactId"
          :contacts="contacts"
          :label="$t(config.partyLabelKey)"
          :required="config.partyRequired"
          class="flex-grow-1"
          @update:model-value="onContactChange"
          @contact-created="onContactCreated"
        />
        <v-autocomplete
          v-else
          v-model="form.contactId"
          :label="$t(config.partyLabelKey)"
          :items="contacts"
          item-title="companyName"
          item-value="_id"
          :rules="config.partyRequired ? [rules.required] : []"
          class="flex-grow-1"
          @update:model-value="onContactChange"
        />
        <v-btn
          v-if="form.contactId"
          icon="mdi-book-open-variant"
          size="small"
          variant="text"
          color="info"
          :title="$t('invoicing.contactLedger')"
          @click="ledgerDialog = true"
        />
      </div>
      <ContactPartyBlock :contact="selectedContact" :address="config.captureBillingAddress ? form.billingAddress : null" />
    </v-col>

    <!-- Col 2: Supplier (the org) -->
    <v-col cols="12" md="4">
      <p class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.supplier') }}</p>
      <OrgPartyBlock :org="appStore.currentOrg" />
    </v-col>

    <!-- Col 3: Document meta (numbers, dates, payment, currency, rate) -->
    <v-col cols="12" md="4">
      <v-text-field
        v-if="config.showSupplierInvoiceNumber"
        v-model="form.supplierInvoiceNumber"
        :label="$t('invoicing.supplierInvoiceNumber')"
        :rules="[rules.required]"
        persistent-placeholder
      />
      <v-text-field
        :model-value="documentNumber"
        :label="$t('invoicing.invoiceNumber')"
        readonly
        persistent-placeholder
      />
      <v-autocomplete
        v-if="config.showRelatedInvoice"
        v-model="form.relatedInvoiceId"
        :label="$t('invoicing.relatedInvoice')"
        :items="invoices"
        item-title="invoiceNumber"
        item-value="_id"
        clearable
        persistent-placeholder
      />

      <!-- Dates: issue + due/valid-until in one row, two equal columns (stack on mobile) -->
      <v-row dense>
        <v-col cols="12" :sm="config.secondaryDate === 'none' ? 12 : 6">
          <DateField
            v-model="form.issueDate"
            :label="$t('invoicing.issueDate')"
            :rules="[rules.required]"
            persistent-placeholder
          />
        </v-col>
        <v-col v-if="config.secondaryDate === 'validUntil'" cols="12" sm="6">
          <DateField
            v-model="form.validUntil"
            :label="$t(config.secondaryDateLabelKey || 'invoicing.dueDate')"
            persistent-placeholder
          />
        </v-col>
        <v-col v-else-if="config.secondaryDate === 'dueDate'" cols="12" sm="6">
          <DateField
            v-model="form.dueDate"
            :label="$t(config.secondaryDateLabelKey || 'invoicing.dueDate')"
            persistent-placeholder
          />
        </v-col>
      </v-row>

      <!-- Payment method + currency + exchange rate in one row, three columns (stack on mobile) -->
      <v-row dense>
        <v-col cols="12" sm="6">
          <v-select
            v-model="form.paymentMethod"
            :label="$t('invoicing.paymentMethod')"
            :items="paymentMethods"
            item-title="text"
            item-value="value"
            :clearable="config.paymentMethodMode === 'clearable'"
            persistent-placeholder
          />
        </v-col>
        <v-col cols="12" sm="3">
          <v-select
            v-model="form.currency"
            :label="$t('common.currency')"
            :items="currencies"
            persistent-placeholder
          />
        </v-col>
        <v-col cols="12" sm="3">
          <v-text-field
            v-model.number="form.exchangeRate"
            :label="$t('invoicing.exchangeRate')"
            type="number"
            step="0.0001"
            min="0"
            persistent-placeholder
          />
        </v-col>
      </v-row>
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import ContactAutocompleteWithCreate from '../ContactAutocompleteWithCreate.vue'
import ContactPartyBlock from '../ContactPartyBlock.vue'
import OrgPartyBlock from '../OrgPartyBlock.vue'
import DateField from 'ui-shared/components/DateField.vue'

const props = defineProps<{ doc: any }>()
const {
  config,
  form,
  documentNumber,
  invoices,
  rules,
  contacts,
  selectedContact,
  appStore,
  ledgerDialog,
  paymentMethods,
  onContactChange,
  onContactCreated,
} = props.doc

const currencies = ['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']
</script>
