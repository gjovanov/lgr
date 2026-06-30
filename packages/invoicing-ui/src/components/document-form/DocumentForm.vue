<template>
  <EntityFormShell
    :title="isEdit ? $t(config.titleEditKey) : $t(config.titleNewKey)"
    :subtitle="isEdit ? invoiceNumber : ''"
    :status="statusDef"
    :actions="formActions"
    :smart-buttons="isEdit ? smartButtons : undefined"
    :loading="loading"
    :back-to="config.backTo"
    :back-label="config.backLabelKey ? $t(config.backLabelKey) : undefined"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
  >
    <!-- Evolved document-preview banner -->
    <template #document-header>
      <div class="doc-banner d-flex align-center justify-space-between px-4 py-3">
        <div class="d-flex align-center ga-3">
          <v-avatar size="36" color="primary" variant="tonal">
            <v-icon size="20">{{ config.pendingIcon }}</v-icon>
          </v-avatar>
          <div>
            <div class="text-overline text-medium-emphasis doc-banner-org">{{ appStore.currentOrg?.name || '—' }}</div>
            <div class="text-subtitle-1 font-weight-bold doc-banner-title">
              {{ isEdit ? $t(config.titleEditKey) : $t(config.titleNewKey) }}
            </div>
          </div>
        </div>
        <div class="text-end">
          <div class="text-h6 font-weight-bold">{{ documentNumber || '—' }}</div>
          <v-chip v-if="statusDef" size="x-small" label color="primary" variant="tonal" class="mt-1">
            {{ statusDef.current }}
          </v-chip>
        </div>
      </div>
    </template>

    <div v-if="isEdit" class="d-flex justify-end mb-2">
      <v-btn variant="outlined" prepend-icon="mdi-printer" :loading="exportLoading" @click="showExportDialog = true">
        {{ $t('common.print') }}
      </v-btn>
    </div>
    <ExportDialog
      v-model="showExportDialog"
      :loading="exportLoading"
      default-mode="detailed"
      :title="$t('common.print')"
      icon="mdi-printer"
      @confirm="onExportSingle"
    />

    <v-form ref="formRef" @submit.prevent="onSave">
      <v-defaults-provider :defaults="{
        VTextField: { density: 'compact', variant: 'outlined' },
        VSelect: { density: 'compact', variant: 'outlined' },
        VAutocomplete: { density: 'compact', variant: 'outlined' },
        VTextarea: { density: 'compact', variant: 'outlined' },
      }">
        <slot name="upper" :doc="doc">
          <DocumentUpperSection :doc="doc" />
        </slot>

        <DocumentLineTable :doc="doc" />

        <!-- Notes / terms / tags (left) + Totals (right) -->
        <v-row class="mt-4">
          <v-col cols="12" md="6">
            <slot name="notes" :doc="doc">
              <v-textarea v-model="notesModel" :label="$t(config.notesFieldLabelKey)" rows="2" />
              <v-textarea v-if="config.showTermsField" v-model="form.terms" :label="$t('invoicing.terms')" rows="2" />
              <TagInput v-model="form.tags" type="invoice" :org-url="orgUrl()" class="mt-2" />
            </slot>
          </v-col>
          <v-col cols="12" md="6">
            <DocumentTotalsCard :doc="doc" />
          </v-col>
        </v-row>

        <v-divider class="my-4" />
        <BankInfoRow :org="appStore.currentOrg" />
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" :entity-type="config.notesEntityType" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId || ''" :org-url="orgUrl()" :selectable="true" @add-lines="onAddLedgerLines" />
    <ProductPickerDialog v-model="productPickerOpen" :org-url="orgUrl()" :base-currency="baseCurrency" :locale="localeCode" @select="onProductPicked" />

    <!-- Escape hatch for per-type dialogs (CashSale's StockTransferDialog). `submitCreate`
         is also exposed via defineExpose so wrappers can drive the create after a suspended
         onBeforeCreate without depending on slot-prop name casing. -->
    <slot name="dialogs" :submitCreate="submitCreate" :form="form" :orgUrl="orgUrl" :loading="loading" :config="config" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ExportDialog from 'ui-shared/components/ExportDialog'
import TagInput from 'ui-shared/components/TagInput.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import BankInfoRow from '../BankInfoRow.vue'
import DocumentUpperSection from './DocumentUpperSection.vue'
import DocumentLineTable from './DocumentLineTable.vue'
import DocumentTotalsCard from './DocumentTotalsCard.vue'
import { useDocumentForm, type UseDocumentFormOptions } from '../../composables/document-form/useDocumentForm'
import type { DocumentTypeConfig } from '../../composables/document-form/types'

const props = defineProps<{
  config: DocumentTypeConfig
  /** Create-mode interceptor (cash sale stock check). */
  onBeforeCreate?: UseDocumentFormOptions['onBeforeCreate']
}>()

const doc = useDocumentForm(props.config, { onBeforeCreate: props.onBeforeCreate })

const {
  config,
  isEdit,
  route,
  invoiceNumber,
  documentNumber,
  statusDef,
  formActions,
  smartButtons,
  formRef,
  loading,
  form,
  notesModel,
  appStore,
  baseCurrency,
  localeCode,
  ledgerDialog,
  productPickerOpen,
  showExportDialog,
  exportLoading,
  onExportSingle,
  onSave,
  submitCreate,
  onAddLedgerLines,
  onProductPicked,
  orgUrl,
} = doc

// Let wrappers (CashSale) drive the create after a suspended onBeforeCreate.
defineExpose({ submitCreate, doc })
</script>

<style scoped>
.doc-banner {
  background: linear-gradient(
    90deg,
    rgba(var(--v-theme-primary), 0.06),
    rgba(var(--v-theme-primary), 0.01)
  );
}
.doc-banner-org {
  line-height: 1;
  letter-spacing: 0.08em;
}
.doc-banner-title {
  line-height: 1.2;
}
</style>
