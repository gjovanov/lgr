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
      <div class="doc-banner d-flex align-center justify-space-between px-4 py-3 ga-4 flex-wrap">
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

        <!-- Party selector (contact DDL + ledger) — moved up into the banner -->
        <div class="doc-banner-party" style="flex: 1 1 260px; max-width: 460px;">
          <v-defaults-provider :defaults="{
            VAutocomplete: { density: 'compact', variant: 'filled', hideDetails: 'auto', persistentPlaceholder: true },
            VTextField: { density: 'compact', variant: 'filled', persistentPlaceholder: true },
          }">
            <div class="d-flex align-center ga-1">
              <ContactAutocompleteWithCreate
                v-if="config.partyPicker === 'create'"
                v-model="form.contactId"
                :contacts="contacts"
                :label="$t(config.partyLabelKey)"
                :required="config.partyRequired"
                :loading="loadingContacts"
                class="flex-grow-1"
                @update:model-value="onContactChange"
                @update:search="onContactSearch"
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
                hide-details="auto"
                no-filter
                :loading="loadingContacts"
                class="flex-grow-1"
                @update:model-value="onContactChange"
                @update:search="onContactSearch"
              />
              <v-btn
                icon="mdi-magnify-expand"
                size="small"
                variant="text"
                :title="$t('invoicing.searchContact')"
                :aria-label="$t('invoicing.searchContact')"
                @click="contactPickerOpen = true"
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
          </v-defaults-provider>
        </div>

        <div class="text-end doc-banner-meta">
          <div class="text-h6 font-weight-bold">{{ documentNumber || '—' }}</div>
          <v-chip v-if="statusDef" size="x-small" label color="primary" variant="tonal" class="mt-1">
            {{ $t(statusDef.current) }}
          </v-chip>
          <!-- Free text for the printout only: never saved, so it is empty again next time
               the document is opened, and an empty value prints nothing at all. -->
          <v-textarea
            v-model="printNote"
            :label="$t('invoicing.printNote')"
            :hint="$t('invoicing.printNoteHint')"
            :counter="HEADER_NOTE_MAX"
            :maxlength="HEADER_NOTE_MAX"
            persistent-hint
            rows="4"
            auto-grow
            variant="outlined"
            class="mt-2 doc-banner-note text-start"
          />
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
      :companion-docs="companionDocs"
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
              <v-textarea v-model="notesModel" :label="$t(config.notesFieldLabelKey)" rows="2" auto-grow />
              <v-textarea v-if="config.showTermsField" v-model="form.terms" :label="$t('invoicing.terms')" rows="2" auto-grow />
              <TagInput v-model="form.tags" type="invoice" :org-url="orgUrl()" class="mt-2" />
            </slot>
          </v-col>
          <v-col cols="12" md="6">
            <DocumentTotalsCard :doc="doc" />
          </v-col>
        </v-row>

        <v-divider class="my-4" />
        <BankInfoRow :org="appStore.currentOrg" />
        <SignatureFooter
          v-if="config.showSignatureFooter"
          :prepared-by="form.preparedBy || userFullName"
          :place="form.placeOfTransaction"
        />

        <!-- Bottom action bar: same Save (+ Print on edit) as the top, so users don't
             have to scroll back up after filling a long document. -->
        <v-divider class="my-4" />
        <div class="d-flex justify-end ga-2 flex-wrap pb-2">
          <v-btn v-if="canImport" variant="outlined" prepend-icon="mdi-file-upload-outline" @click="importDialogOpen = true">
            {{ $t('docImport.importFile') }}
          </v-btn>
          <v-btn v-if="isEdit" variant="outlined" prepend-icon="mdi-printer" :loading="exportLoading" @click="showExportDialog = true">
            {{ $t('common.print') }}
          </v-btn>
          <v-btn color="primary" variant="flat" prepend-icon="mdi-content-save" :loading="loading" @click="onSave">
            {{ $t('common.save') }}
          </v-btn>
        </div>
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" :entity-type="config.notesEntityType" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId || ''" :org-url="orgUrl()" :selectable="true" @add-lines="onAddLedgerLines" />
    <ProductPickerDialog v-model="productPickerOpen" :org-url="orgUrl()" :base-currency="baseCurrency" :locale="localeCode" @select="onProductPicked" />
    <ContactPickerDialog v-model="contactPickerOpen" :org-url="orgUrl()" :type="(config.contactFetchParams as any)?.type" @select="onContactPicked" />

    <!-- Single-document import: OCR one PDF and merge the reviewed fields into THIS form.
         No draft is created — the user still has to save. -->
    <DocImportDialog
      v-model="importDialogOpen"
      :org-url="orgUrl()"
      :target="importTarget"
      mode="single"
      :current-form="importCurrentForm"
      @apply="applyImportedDocument"
    />

    <!-- Escape hatch for per-type dialogs (CashSale's StockTransferDialog). `submitCreate`
         is also exposed via defineExpose so wrappers can drive the create after a suspended
         onBeforeCreate without depending on slot-prop name casing. -->
    <slot name="dialogs" :submitCreate="submitCreate" :form="form" :orgUrl="orgUrl" :loading="loading" :config="config" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ExportDialog from 'ui-shared/components/ExportDialog'
import TagInput from 'ui-shared/components/TagInput.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import BankInfoRow from '../BankInfoRow.vue'
import SignatureFooter from '../SignatureFooter.vue'
import ContactAutocompleteWithCreate from '../ContactAutocompleteWithCreate.vue'
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

/** Same cap the print layout enforces, so the counter matches what will actually print. */
const HEADER_NOTE_MAX = 300

/** Съставил fallback for the signature footer — the logged-in user's full name. */
const userFullName = computed(() => doc.appStore.fullName || '')

/**
 * Companion documents offered in the Print dialog. Outgoing documents only — on an incoming
 * supplier bill we are the recipient, so there is nothing for us to declare or hand over.
 */
const companionDocs = computed(() =>
  props.config.direction === 'outgoing'
    ? [
        { key: 'certificate', i18n: 'export.certificate', label: 'Declaration of Conformity' },
        { key: 'ppprotocol', i18n: 'export.ppProtocol', label: 'Acceptance & Handover Protocol' },
      ]
    : undefined,
)

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
  contacts,
  loadingContacts,
  rules,
  onContactChange,
  onContactCreated,
  onContactSearch,
  contactPickerOpen,
  onContactPicked,
  notesModel,
  appStore,
  baseCurrency,
  localeCode,
  ledgerDialog,
  productPickerOpen,
  showExportDialog,
  printNote,
  exportLoading,
  onExportSingle,
  onSave,
  submitCreate,
  onAddLedgerLines,
  onProductPicked,
  orgUrl,
  invoiceStatus,
  selectedContact,
  importDialogOpen,
  applyImportedDocument,
} = doc

/**
 * Which import surface this form is. The engine only distinguishes sales-vs-purchase
 * direction and cash sales; proforma/credit/debit notes ride the sales mapping, which is
 * correct — they carry the same party block, dates and line table.
 */
const importTarget = computed(() => {
  if (props.config.apiType === 'cash_sale') return 'cash_sale'
  return props.config.direction === 'incoming' ? 'bill' : 'sales_invoice'
})

/**
 * The form's current values, for the import dialog's field diff. `contactName` is resolved
 * here because the form only holds a contact id.
 */
const importCurrentForm = computed(() => ({
  ...form,
  contactName: (selectedContact.value as any)?.companyName
    || (selectedContact.value as any)?.name
    || '',
}))

/** Import is offered wherever Save is — mirrors the `formActions` gate exactly. */
const canImport = computed(() =>
  !isEdit.value || props.config.editSaveGate !== 'draft-only' || invoiceStatus.value === 'draft',
)

// Let wrappers (CashSale) drive the create after a suspended onBeforeCreate.
defineExpose({ submitCreate, doc })
</script>

<style scoped>
/* The banner's right-hand column: number, status and the print-only note stacked under it.
   The note is a full textarea, so the column is wide enough to type a few lines into. */
.doc-banner-meta {
  flex: 1 1 380px;
  max-width: 460px;
  min-width: 280px;
}
/* The number and status stay right-aligned; the note reads as a normal left-aligned field. */
.doc-banner-note :deep(.v-field__input),
.doc-banner-note :deep(.v-messages),
.doc-banner-note :deep(.v-label) {
  text-align: start;
}
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
