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
                ref="contactCreateRef"
                v-model="form.contactId"
                :contacts="contacts"
                :label="$t(config.partyLabelKey)"
                :org-url="orgUrl()"
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
              <!-- New contact without leaving the document. The same dialog is also the last entry
                   of the dropdown, but nobody finds it there under a page of contacts. -->
              <v-btn
                v-if="config.partyPicker === 'create'"
                icon="mdi-account-plus"
                size="small"
                variant="text"
                color="primary"
                :title="$t('invoicing.createContact')"
                :aria-label="$t('invoicing.createContact')"
                data-testid="create-contact-btn"
                @click="contactCreateRef?.openCreateDialog()"
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
          <!-- Free text printed under the number block. Saved with the document, so every
               later reprint carries it; an empty value prints nothing at all. -->
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
          <!-- Fills the "Допълнителна информация" block of the companion documents. Outgoing
               only, for the same reason the companions themselves are (see `companionDocs`). -->
          <v-textarea
            v-if="companionDocs"
            v-model="companionNote"
            :label="$t('invoicing.companionNote')"
            :hint="$t('invoicing.companionNoteHint')"
            :counter="COMPANION_NOTE_MAX"
            :maxlength="COMPANION_NOTE_MAX"
            persistent-hint
            rows="2"
            auto-grow
            variant="outlined"
            class="mt-2 doc-banner-note text-start"
          />
        </div>
      </div>
    </template>

    <!-- On a saved document only: a new one has „Издай и печатай" in the action bar and Печат
         (which saves first) at the bottom, and this row would push its lines down the screen. -->
    <div v-if="isEdit" class="d-flex justify-end align-center ga-2 mb-2">
      <!-- FR-10.9: a quiet "this went out already" marker, so nobody re-sends blindly. -->
      <v-chip
        v-if="lastEmailedAt"
        size="small"
        variant="tonal"
        color="success"
        prepend-icon="mdi-email-check-outline"
        :title="$t('invoicing.sendEmail.lastSent', { date: formatEmailedAt, to: lastEmailedTo })"
      >
        {{ formatEmailedAt }}
      </v-chip>
      <!-- FR-10.8: mirrors Print exactly, outgoing documents only. Draft is blocked because
           a DRF- number in a customer's inbox is worse than no email at all.
           The tooltip hangs off a WRAPPER span, not the button: Vuetify gives a disabled
           v-btn `pointer-events: none`, so a tooltip (or a native `title`) attached to the
           button itself never fires — the button just looks broken. -->
      <v-tooltip
        v-if="config.direction === 'outgoing'"
        location="top"
        :disabled="!isDraft"
        :text="$t('invoicing.sendEmail.draftBlocked')"
      >
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              variant="outlined"
              prepend-icon="mdi-email-arrow-right-outline"
              :disabled="isDraft"
              :loading="emailLoading"
              @click="openEmailDialog"
            >
              {{ $t('invoicing.sendEmail.action') }}
            </v-btn>
          </span>
        </template>
      </v-tooltip>
      <!-- FR-22.20: „Печат" prints in one click with the user's last settings; the options are the
           button beside it. An edited document is saved first (#4.13). -->
      <div class="d-inline-flex print-split">
        <v-btn variant="outlined" prepend-icon="mdi-printer" class="rounded-e-0" :loading="exportLoading" data-testid="print-now" @click="doc.onPrint">
          {{ $t('common.print') }}
        </v-btn>
        <v-btn
          variant="outlined"
          class="rounded-s-0 print-options"
          min-width="0"
          :title="$t('invoicing.issueFlow.printOptions')"
          :aria-label="$t('invoicing.issueFlow.printOptions')"
          data-testid="print-options"
          @click="doc.onPrintOptions"
        >
          <v-icon>mdi-tune-variant</v-icon>
        </v-btn>
      </div>
      <!-- A supplier bill's goods as they were booked: one receipt per warehouse they went into. -->
      <v-btn
        v-if="stockReceipts.length"
        variant="outlined"
        prepend-icon="mdi-clipboard-text-outline"
        :loading="stockReceiptLoading"
        :title="$t('invoicing.stockReceipt.hint')"
        data-testid="print-stock-receipt"
        @click="onPrintStockReceipt"
      >
        {{ $t('invoicing.stockReceipt.print') }}
      </v-btn>
    </div>

    <!-- FR-22 §5.2: asked to be issued, and not issued — the draft says why. -->
    <v-alert
      v-if="issueError && isDraftDoc"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-3"
      closable
      data-testid="issue-error"
      @click:close="issueError = ''"
    >
      {{ $t('invoicing.issueFlow.notIssued', { reason: issueError }) }}
    </v-alert>

    <SendEmailDialog
      v-model="showEmailDialog"
      :default-to="contactEmail"
      :default-subject="emailSubject"
      :document-number="form.invoiceNumber"
      :loading="emailLoading"
      @confirm="onSendEmail"
    />

    <ExportDialog
      v-model="showExportDialog"
      :loading="exportLoading"
      :default-format="lastPrint.format"
      :default-mode="lastPrint.mode"
      :initial-columns="lastPrint.columns"
      :title="$t('common.print')"
      icon="mdi-printer"
      :companion-docs="companionDocs"
      @confirm="onExportSingle"
    />

    <!-- FR-22.17: issuing from the form checks stock as the list does, and offers the same transfers. -->
    <StockTransferDialog
      v-model="transferOpen"
      :shortfalls="transferShortfalls"
      :proposals="transferProposals"
      :all-resolvable="transferAllResolvable"
      :confirming="transferConfirming"
      @confirm="confirmTransfers"
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

        <!-- #171: an invoice for a cash sale carries that sale's lines, at its prices. They are
             shown, not edited: the dialog on the cash sale is where the quantities are chosen. -->
        <template v-if="cashSaleRef">
          <v-alert type="info" variant="tonal" density="compact" class="mb-3" icon="mdi-cash-register">
            {{ $t('invoicing.cashSaleInvoice.banner', { number: cashSaleRef.number, date: String(cashSaleRef.issueDate || '').slice(0, 10) }) }}
            <router-link class="ml-1" :to="{ name: 'invoicing.cash-sales.edit', params: { id: cashSaleRef.cashSaleId } }">
              {{ $t('invoicing.cashSaleInvoice.openCashSale') }}
            </router-link>
            <div class="text-caption mt-1">{{ $t('invoicing.cashSaleInvoice.linesFromSale') }}</div>
          </v-alert>
          <v-table density="compact" class="mb-2">
            <thead>
              <tr>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end">{{ $t('invoicing.qty') }}</th>
                <th class="text-end">{{ $t('invoicing.unitPrice') }}</th>
                <th class="text-end">{{ $t('invoicing.taxRate') }}</th>
                <th class="text-end">{{ $t('common.total') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, i) in form.lines.filter((l: any) => l.productId || l.description)" :key="i">
                <td>{{ line.description }}</td>
                <td class="text-end text-no-wrap">{{ line.quantity }} {{ line.unit }}</td>
                <td class="text-end">{{ doc.fmtCurrency(line.unitPrice) }}</td>
                <td class="text-end">{{ line.taxRate }}%</td>
                <td class="text-end">{{ doc.fmtCurrency(line.lineTotal) }}</td>
              </tr>
            </tbody>
          </v-table>
        </template>
        <template v-else>
          <!-- FR-22.31: a bill made from goods receipts. They booked the goods, so it moves none. -->
          <v-alert
            v-if="billReceipts.linkedReceipts.value.length"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
            icon="mdi-truck-check-outline"
            data-testid="bill-receipts"
          >
            {{ $t('invoicing.linkDelivery.banner') }}
            <template v-for="(r, i) in billReceipts.linkedReceipts.value" :key="r.id">
              <span v-if="i">, </span>
              <a :href="billReceipts.receiptHref(r.id)" class="font-weight-medium" data-testid="bill-receipt-link">{{ r.number }}</a>
            </template>
            <div class="text-caption mt-1">{{ $t('invoicing.linkDelivery.noStock') }}</div>
          </v-alert>
          <!-- FR-22.32: goods already received? Bill that delivery instead of typing its lines. -->
          <div v-else-if="billReceipts.canLinkDelivery.value" class="d-flex align-center ga-2 mb-1 text-body-2 text-medium-emphasis">
            <v-icon size="small">mdi-truck-check-outline</v-icon>
            {{ $t('invoicing.linkDelivery.hint') }}
            <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-link-variant" data-testid="link-delivery-btn" @click="billReceipts.openLinkDelivery">
              {{ $t('invoicing.linkDelivery.action') }}
            </v-btn>
          </div>
          <DocumentLineTable :doc="doc" :receipt-cost-of="billReceipts.enabled ? billReceipts.receiptCostOf : undefined" />
        </template>

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
          <!-- Wrapper span carries the tooltip — see the top bar for why. -->
          <v-tooltip
            v-if="isEdit && config.direction === 'outgoing'"
            location="top"
            :disabled="!isDraft"
            :text="$t('invoicing.sendEmail.draftBlocked')"
          >
            <template #activator="{ props: tip }">
              <span v-bind="tip">
                <v-btn
                  variant="outlined"
                  prepend-icon="mdi-email-arrow-right-outline"
                  :disabled="isDraft"
                  :loading="emailLoading"
                  @click="openEmailDialog"
                >
                  {{ $t('invoicing.sendEmail.action') }}
                </v-btn>
              </span>
            </template>
          </v-tooltip>
          <div class="d-inline-flex print-split">
            <v-btn variant="outlined" prepend-icon="mdi-printer" class="rounded-e-0" :loading="exportLoading" @click="doc.onPrint">
              {{ $t('common.print') }}
            </v-btn>
            <v-btn
              variant="outlined"
              class="rounded-s-0 print-options"
              min-width="0"
              :title="$t('invoicing.issueFlow.printOptions')"
              :aria-label="$t('invoicing.issueFlow.printOptions')"
              @click="doc.onPrintOptions"
            >
              <v-icon>mdi-tune-variant</v-icon>
            </v-btn>
          </div>
          <v-btn
            v-if="stockReceipts.length"
            variant="outlined"
            prepend-icon="mdi-clipboard-text-outline"
            :loading="stockReceiptLoading"
            :title="$t('invoicing.stockReceipt.hint')"
            @click="onPrintStockReceipt"
          >
            {{ $t('invoicing.stockReceipt.print') }}
          </v-btn>
          <v-btn
            v-if="canSaveAndReceive"
            color="primary"
            variant="flat"
            prepend-icon="mdi-package-down"
            :loading="doc.receiving.value"
            @click="doc.onSaveAndReceive"
          >
            {{ $t('invoicing.saveAndReceive') }}
          </v-btn>
          <v-btn color="primary" :variant="canSaveAndReceive || bottomActions.length ? 'outlined' : 'flat'" prepend-icon="mdi-content-save" :loading="loading" @click="onSave">
            {{ $t('common.save') }}
          </v-btn>
          <!-- What follows from the document — issue, convert, a note — as the top bar offers it,
               the action that finishes the job rightmost. -->
          <v-btn
            v-for="a in bottomActions"
            :key="a.label"
            :color="a.color || 'primary'"
            :variant="a.primary ? 'flat' : 'outlined'"
            :prepend-icon="a.icon"
            :loading="a.loading"
            :disabled="a.disabled"
            @click="a.handler"
          >
            {{ a.label }}
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

    <!-- FR-22.32: the supplier's receipts this bill can pay for. The list scrolls: the receipts that
         name no supplier can run long, and what linking does must stay in view beside its button. -->
    <v-dialog v-model="billReceipts.dialogOpen.value" max-width="640" scrollable>
      <v-card data-testid="link-delivery-dialog">
        <v-card-title>{{ $t('invoicing.linkDelivery.action') }}</v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-2">{{ $t('invoicing.linkDelivery.dialogHint') }}</div>
          <v-progress-linear v-if="billReceipts.loading.value" indeterminate />
          <div v-else-if="!billReceipts.billable.value.length" class="text-body-2">{{ $t('invoicing.linkDelivery.none') }}</div>
          <v-list v-else density="compact">
            <v-list-item v-for="r in billReceipts.billable.value" :key="r.id">
              <template #prepend>
                <v-checkbox-btn v-model="billReceipts.selected.value" :value="r.id" />
              </template>
              <v-list-item-title>
                {{ r.number }} · {{ String(r.date || '').slice(0, 10) }}
                <v-chip v-if="r.noSupplier" size="x-small" label class="ml-1" data-testid="receipt-no-supplier">{{ $t('invoicing.linkDelivery.noSupplier') }}</v-chip>
              </v-list-item-title>
              <v-list-item-subtitle>{{ $t('invoicing.linkDelivery.receiptLines', { n: r.lineCount }) }} · {{ doc.fmtCurrency(r.total) }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-card-text>
        <!-- FR-22.32a: a bill with typed lines takes the delivery's: said before it happens. -->
        <v-alert v-if="billReceipts.filledLines.value && billReceipts.billable.value.length" type="warning" variant="tonal" density="compact" class="mx-4 mt-2 flex-grow-0" data-testid="replace-lines-warning">
          {{ $t('invoicing.linkDelivery.replaceWarning', billReceipts.filledLines.value) }}
        </v-alert>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="billReceipts.dialogOpen.value = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!billReceipts.selected.value.length"
            :loading="billReceipts.linking.value"
            data-testid="link-delivery-confirm"
            @click="billReceipts.linkDelivery"
          >
            {{ $t(billReceipts.filledLines.value ? 'invoicing.linkDelivery.replaceConfirm' : 'invoicing.linkDelivery.confirm') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- FR-22.31c: „Запази и получи" on goods a receipt may already have booked. -->
    <ReceiptOverlapDialog
      v-model:overlap="doc.receiptOverlap.value"
      :org-url="orgUrl()"
      :base-currency="baseCurrency"
      :locale="localeCode"
      @received="billReceipts.onOverlapReceived"
      @linked="billReceipts.onOverlapLinked"
    />

    <!-- Single-document import: OCR one PDF and merge the reviewed fields into THIS form.
         No draft is created — the user still has to save. -->
    <DocImportDialog
      v-model="importDialogOpen"
      :org-url="orgUrl()"
      :target="importTarget"
      mode="single"
      :current-form="importCurrentForm"
      :field-labels="importFieldLabels"
      @apply="applyImportedDocument"
    />

    <!-- FR-21 §11: an issued invoice attached to the cash sale of its day. -->
    <AttachToCashSaleDialog
      v-if="isEdit"
      v-model="attachDialogOpen"
      :invoice-id="String(route.params.id || '')"
      @attached="onAttached"
    />

    <!-- Escape hatch for per-type dialogs (CashSale's StockTransferDialog). `submitCreate`
         is also exposed via defineExpose so wrappers can drive the create after a suspended
         onBeforeCreate without depending on slot-prop name casing. -->
    <slot name="dialogs" :submitCreate="submitCreate" :form="form" :orgUrl="orgUrl" :loading="loading" :config="config" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ExportDialog from 'ui-shared/components/ExportDialog'
import SendEmailDialog from 'ui-shared/components/SendEmailDialog.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import AttachToCashSaleDialog from '../AttachToCashSaleDialog.vue'
import ReceiptOverlapDialog from '../ReceiptOverlapDialog.vue'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import BankInfoRow from '../BankInfoRow.vue'
import SignatureFooter from '../SignatureFooter.vue'
import ContactAutocompleteWithCreate from 'ui-shared/components/ContactAutocompleteWithCreate.vue'
import DocumentUpperSection from './DocumentUpperSection.vue'
import DocumentLineTable from './DocumentLineTable.vue'
import DocumentTotalsCard from './DocumentTotalsCard.vue'
import { useDocumentForm, type UseDocumentFormOptions } from '../../composables/document-form/useDocumentForm'
import { useBillReceipts } from '../../composables/document-form/useBillReceipts'
import type { DocumentTypeConfig } from '../../composables/document-form/types'

const props = defineProps<{
  config: DocumentTypeConfig
  /** Create-mode interceptor (cash sale stock check). */
  onBeforeCreate?: UseDocumentFormOptions['onBeforeCreate']
}>()

const emit = defineEmits<{
  /** A new document was saved as `id`; the form moves onto its edit route and stays mounted (FR-22.16). */
  created: [id: string]
}>()

const doc = useDocumentForm(props.config, { onBeforeCreate: props.onBeforeCreate, onCreated: (id) => emit('created', id) })
// FR-22.31/.32: a supplier bill and the goods receipts it pays for.
const billReceipts = useBillReceipts(doc)

const contactCreateRef = ref<InstanceType<typeof ContactAutocompleteWithCreate> | null>(null)

/** Same cap the print layout enforces, so the counter matches what will actually print. */
const HEADER_NOTE_MAX = 300
/** Matches `companionNote`'s maxlength on the Invoice model. */
const COMPANION_NOTE_MAX = 300

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
  companionNote,
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
  cashSaleRef,
  attachDialogOpen,
  onAttached,
  lastPrint,
  issueError,
  isDraftDoc,
  confirmTransfers,
  stockReceipts,
  stockReceiptLoading,
  onPrintStockReceipt,
} = doc

// FR-22.17: the stock check's transfer dialog, as top-level refs so the template unwraps them.
const {
  open: transferOpen,
  shortfalls: transferShortfalls,
  proposals: transferProposals,
  allResolvable: transferAllResolvable,
  confirming: transferConfirming,
} = doc.transfer

/**
 * The bottom bar repeats what the top bar offers beyond Save and Import (which it has its own
 * buttons for): issue, convert, a note — reversed, so the action that finishes the job sits at the
 * far right, where Save used to end the row.
 */
const bottomActions = computed<FormAction[]>(() =>
  formActions.value
    .filter((a) => !a.save && a.label !== t('docImport.importFile') && a.label !== t('invoicing.saveAndReceive'))
    .reverse(),
)

// ── FR-10 (#19): email this document ──────────────────────────────────────

const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const showEmailDialog = ref(false)
const emailLoading = ref(false)
const lastEmailedAt = ref<string | null>(null)
const lastEmailedTo = ref('')

/** A draft carries a DRF- number; sending one to a customer would be a real mistake. */
const isDraft = computed(() => invoiceStatus.value === 'draft')

const contactEmail = computed(() => (selectedContact.value as any)?.email || '')

/** A sensible prefill; leaving it blank lets the server build the localized default. */
const emailSubject = computed(() => {
  const org = (appStore.currentOrg as any)?.name || ''
  const number = (form as any).invoiceNumber || ''
  return [number, org].filter(Boolean).join(' — ')
})

const formatEmailedAt = computed(() =>
  lastEmailedAt.value ? new Date(lastEmailedAt.value).toLocaleDateString(localeCode.value) : '',
)

function openEmailDialog() {
  if (isDraft.value) return
  showEmailDialog.value = true
}

async function onSendEmail(payload: { to: string; subject?: string; message?: string }) {
  emailLoading.value = true
  try {
    const id = route.params.id as string
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/export/${id}/email`, {
      ...payload,
      locale: appStore.locale,
    })
    showEmailDialog.value = false
    // FR-20.86: on a server, the mail waits for lgrai.app. Its history is updated when it has gone.
    if (data?.queued) {
      showSuccess(t('invoicing.sendEmail.queuedTo', { to: payload.to }))
      return
    }
    lastEmailedAt.value = new Date().toISOString()
    lastEmailedTo.value = payload.to
    showSuccess(t('invoicing.sendEmail.sentTo', { to: payload.to }))
  } catch (e: any) {
    // The server's message is the useful one — "not configured" in particular must reach
    // the user verbatim rather than becoming a generic failure.
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    emailLoading.value = false
  }
}

// Seed the indicator from whatever the loaded document already recorded.
watch(
  () => (form as any).lastEmailedAt,
  (v) => {
    if (!v) return
    lastEmailedAt.value = v
    const list = (form as any).emailedTo
    if (Array.isArray(list) && list.length) lastEmailedTo.value = list[list.length - 1]
  },
  { immediate: true },
)

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

/**
 * Name fields in the diff the way THIS form names them: a bill labels its notes textarea
 * "Reason", so a diff row headed "Notes" would point at a field the user cannot find.
 */
const importFieldLabels = computed(() => ({ notes: props.config.notesFieldLabelKey }))

/** FR-22.33: the bottom bar offers what the top bar does — „Запази и получи" on a bill not yet received. */
const canSaveAndReceive = computed(() => !!props.config.saveAndReceive && (!isEdit.value || invoiceStatus.value === 'draft'))

/** Import is offered wherever Save is — mirrors the `formActions` gate exactly. */
const canImport = computed(() =>
  !cashSaleRef.value && (!isEdit.value || props.config.editSaveGate !== 'draft-only' || invoiceStatus.value === 'draft'),
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
/* FR-22.20: „Печат" and its options, one control in two parts. */
.print-split .print-options {
  padding-inline: 8px;
  border-inline-start-width: 0;
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
