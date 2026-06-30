<template>
  <v-row dense class="mt-1">
    <!-- Buyer / supplier party -->
    <v-col cols="12" md="6">
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

    <!-- Seller (the org) -->
    <v-col cols="12" md="6">
      <p class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.supplier') }}</p>
      <OrgPartyBlock :org="appStore.currentOrg" />
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import ContactAutocompleteWithCreate from '../ContactAutocompleteWithCreate.vue'
import ContactPartyBlock from '../ContactPartyBlock.vue'
import OrgPartyBlock from '../OrgPartyBlock.vue'

const props = defineProps<{ doc: any }>()
const {
  config,
  form,
  contacts,
  selectedContact,
  rules,
  appStore,
  ledgerDialog,
  onContactChange,
  onContactCreated,
} = props.doc
</script>
