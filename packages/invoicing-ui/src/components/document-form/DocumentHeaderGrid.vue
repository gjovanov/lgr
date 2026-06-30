<template>
  <div>
    <!-- Row 1: [supplier# | spacer] · number (+ related) · spacer · issue date -->
    <v-row dense>
      <v-col cols="12" md="3">
        <v-text-field
          v-if="config.showSupplierInvoiceNumber"
          v-model="form.supplierInvoiceNumber"
          :label="$t('invoicing.supplierInvoiceNumber')"
          :rules="[rules.required]"
        />
      </v-col>
      <v-col cols="12" md="3">
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
          class="mt-1"
        />
      </v-col>
      <v-col cols="12" md="3" />
      <v-col cols="12" md="3">
        <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
      </v-col>
    </v-row>

    <!-- Row 2: secondary date (due date / valid until), right-aligned -->
    <v-row v-if="config.secondaryDate !== 'none'" dense>
      <v-col cols="12" md="9" />
      <v-col cols="12" md="3">
        <v-text-field
          v-if="config.secondaryDate === 'validUntil'"
          v-model="form.validUntil"
          :label="$t(config.secondaryDateLabelKey || 'invoicing.dueDate')"
          type="date"
        />
        <v-text-field
          v-else
          v-model="form.dueDate"
          :label="$t(config.secondaryDateLabelKey || 'invoicing.dueDate')"
          type="date"
        />
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ doc: any }>()
const { config, form, documentNumber, invoices, rules } = props.doc
</script>
