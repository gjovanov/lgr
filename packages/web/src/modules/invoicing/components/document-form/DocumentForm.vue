<template>
  <EntityFormShell
    :title="isEdit ? $t(config.titleEditKey) : $t(config.titleNewKey)"
    :subtitle="isEdit ? invoiceNumber : ''"
    :status="statusDef"
    :actions="barActions"
    bottom-actions
    :smart-buttons="isEdit ? smartButtons : undefined"
    :loading="loading"
    :back-to="config.backTo"
    :back-label="config.backLabelKey ? $t(config.backLabelKey) : undefined"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
    :load-error="loadError"
    :refusal="refusal"
    @retry="loadDocument"
    @dismiss-refusal="dismissRefusal"
  >
    <!-- FR-28.32 / .33: the banner is one row of three equal columns — who (the party), which document
         (its number and status), when (the issue date). The organization's name and the title it
         used to repeat are gone: the shell's <h1> is the title, the top bar names the organization. -->
    <template #document-header>
      <DocumentBanner :number="documentNumber" :status="statusDef ? $t(statusDef.current) : ''">
        <!-- Party selector (contact DDL + ledger). It stays the FIRST autocomplete in the DOM: the
             specs, and focusFirstField, take it that way. -->
        <template #party>
          <v-defaults-provider :defaults="{
            VAutocomplete: { density: 'compact', variant: 'filled', hideDetails: 'auto', persistentPlaceholder: true },
            VTextField: { density: 'compact', variant: 'filled', persistentPlaceholder: true },
          }">
            <div class="d-flex align-center ga-1">
              <!-- Every document type can create its party here, a bill its supplier: a contact made from
                   this picker starts as the form's party role. -->
              <ContactAutocompleteWithCreate
                ref="contactCreateRef"
                v-model="form.contactId"
                :contacts="contacts"
                :label="$t(config.partyLabelKey)"
                :org-url="orgUrl()"
                :required="config.partyRequired"
                :loading="loadingContacts"
                :new-contact-type="config.partyRole"
                class="flex-grow-1"
                @update:model-value="onContactChange"
                @update:search="onContactSearch"
                @contact-created="onContactCreated"
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
                   of the dropdown, but nobody finds it there under a page of contacts. Both need
                   contacts.create, the capability the Contacts page's own New button asks. -->
              <v-btn
                v-cap="'contacts.create'"
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
        </template>
        <template #date>
          <!-- The banner sits OUTSIDE the document's <v-form> (which is why the party select's
               `required` takes no part in a save), so a date moved up here would have dropped out of
               what a save validates: it was required, and an empty one must still stop the save. The
               date checks itself: `validate()` asks it as well as the form (FR-28.35). It is not wrapped
               in a <form> of its own, because that would be a second `.v-form` on the page. -->
          <v-defaults-provider :defaults="{
            VTextField: { density: 'compact', variant: 'filled', hideDetails: 'auto', persistentPlaceholder: true },
          }">
            <DateField
              ref="issueDateRef"
              v-model="form.issueDate"
              :label="$t('invoicing.issueDate')"
              :rules="[rules.required]"
              data-testid="issue-date"
            />
          </v-defaults-provider>
        </template>
      </DocumentBanner>
    </template>

    <!-- No row of buttons here: what a document offers (save, issue, print, e-mail, the stock receipt…) is
         ONE list, `barActions`, that the shell draws under the title and again at the foot of the form. -->

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

    <!-- FR-23: issued, and its receipt did not print. The money is taken again; on delivery it is the
         courier's, so the receipt prints on its own, and this stays until it has. -->
    <v-alert
      v-if="(receiptError || deliveryReceiptDue) && !isDraftDoc"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-3"
      :closable="!deliveryReceiptDue"
      data-testid="receipt-error"
      @click:close="receiptError = ''"
    >
      {{ receiptError || $t('cashRegister.receipt.deliveryMissing') }}
      <template #append>
        <v-btn v-if="deliveryReceiptDue" size="small" variant="outlined" :loading="printingReceipt" data-testid="receipt-print" @click="printDeliveryReceipt">{{ $t('cashRegister.receipt.printIt') }}</v-btn>
        <v-btn v-else-if="receiptTakesPayment" size="small" variant="outlined" data-testid="receipt-retry" @click="paymentDialog = true">{{ $t(payableDoc?.type === 'credit_note' ? 'cashRegister.receipt.takeRefund' : 'cashRegister.receipt.takePayment') }}</v-btn>
      </template>
    </v-alert>

    <!-- FR-23: nothing can prove whether a receipt of this document printed. Its money is neither
         booked nor free until someone settles it. -->
    <v-alert v-if="receiptInDoubt" type="warning" variant="tonal" density="compact" class="mb-3" data-testid="receipt-in-doubt">
      {{ $t('cashRegister.receipt.inDoubtDocument', { number: receiptInDoubt.number }) }}
      <template #append>
        <v-btn size="small" variant="outlined" data-testid="receipt-in-doubt-open" :to="{ name: 'invoicing.cash-sales.view', params: { id: receiptInDoubt.id } }">{{ $t('cashRegister.receipt.settleIt') }}</v-btn>
      </template>
    </v-alert>

    <!-- FR-23: the receipts that took this document's money, or the stornos that gave it back. -->
    <v-card v-if="paymentReceipts.length" variant="outlined" class="mb-3" data-testid="document-receipts">
      <v-card-text class="py-2">
        <div class="text-caption text-medium-emphasis mb-1">{{ $t(payableDoc?.type === 'credit_note' ? 'cashRegister.receipt.listStornos' : 'cashRegister.receipt.listReceipts') }}</div>
        <div v-for="r in paymentReceipts" :key="r.id" class="d-flex flex-wrap ga-4 text-body-2" data-testid="document-receipt">
          <router-link :to="{ name: 'invoicing.cash-sales.view', params: { id: r.id } }" class="text-decoration-none" data-testid="document-receipt-link">{{ r.number }}</router-link>
          <span>{{ doc.fmtCurrency(r.amount) }}</span>
          <span v-if="r.state">{{ $t(`cashRegister.fiscalState.${r.state}`) }}</span>
        </div>
      </v-card-text>
    </v-card>

    <RecordPaymentDialog v-model="paymentDialog" :document="payableDoc" @recorded="onPaymentRecorded" />

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
      collapsible-columns
      :confirm-label="printDialogFor === 'issue' ? $t('invoicing.issueFlow.issueAndPrint') : undefined"
      @confirm="doc.onPrintDialogConfirm"
    />

    <!-- FR-22.33a: a bill's „Складова разписка" asks which price to print before it prints anything. -->
    <StockReceiptPrintDialog v-model="stockReceiptDialog" :loading="stockReceiptLoading" @confirm="printStockReceipt" />

    <!-- FR-22.17: issuing from the form checks stock as the list does, and offers the same transfers. -->
    <StockTransferDialog
      v-model="transferOpen"
      :shortfalls="transferShortfalls"
      :proposals="transferProposals"
      :all-resolvable="transferAllResolvable"
      :confirming="transferConfirming"
      @confirm="confirmTransfers"
    />

    <IssuePaymentConfirmDialog :ask="paymentConfirm" @answer="answerPayment" />

    <!-- FR-22.61b: „Издай" on goods a stock note may already have delivered. Asked before the stock is checked:
         an invoice linked to the note takes none. -->
    <DispatchOverlapDialog v-model:overlap="dispatchOverlap" :org-url="orgUrl()" @linked="overlapLinked" @issue-anyway="issueDespiteOverlap" />

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
            {{ $t('invoicing.cashSaleInvoice.banner', { number: cashSaleRef.number, date: formatDate(cashSaleRef.issueDate || '') }) }}
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
          <!-- FR-22.61: an invoice made from stock notes. They delivered the goods, so it moves none. -->
          <v-alert
            v-if="invoiceDispatches.linkedDispatches.value.length"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
            icon="mdi-truck-delivery-outline"
            data-testid="invoice-dispatches"
          >
            {{ $t('invoicing.linkNote.banner') }}
            <template v-for="(d, i) in invoiceDispatches.linkedDispatches.value" :key="d.id">
              <span v-if="i">, </span>
              <a :href="invoiceDispatches.dispatchHref(d.id)" class="font-weight-medium" data-testid="invoice-dispatch-link">{{ d.number }}</a>
            </template>
            <div class="text-caption mt-1">{{ $t('invoicing.linkNote.noStock') }}</div>
          </v-alert>
          <!-- FR-22.62: goods already handed over? Invoice that stock note instead of dispatching them again. -->
          <div v-else-if="invoiceDispatches.canLink.value" class="d-flex align-center ga-2 mb-1 text-body-2 text-medium-emphasis">
            <v-icon size="small">mdi-truck-delivery-outline</v-icon>
            {{ $t('invoicing.linkNote.hint') }}
            <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-link-variant" data-testid="link-note-btn" @click="invoiceDispatches.openLink">
              {{ $t('invoicing.linkNote.action') }}
            </v-btn>
          </div>
          <DocumentLineTable :doc="doc" :receipt-cost-of="billReceipts.enabled ? billReceipts.receiptCostOf : undefined" />
        </template>

        <!-- Notes / terms / tags (left) + Totals (right). FR-28.34: the PRINT note heads the left
             column, above Reason / Notes, and the COMPANION-documents note closes the right one,
             under the totals; both used to be stacked under the number in the banner, where the two
             textareas set the height of the whole header. Only their place moved. -->
        <v-row class="mt-4">
          <v-col cols="12" md="6">
            <!-- Free text printed under the number block. Saved with the document, so every
                 later reprint carries it; an empty value prints nothing at all.
                 The room under it (#775): its hint is the last line of its box, and the label of
                 the field below floats up over its own top edge once that field holds text. -->
            <v-textarea
              v-model="printNote"
              class="mb-3"
              data-testid="print-note"
              :label="$t('invoicing.printNote')"
              :hint="$t('invoicing.printNoteHint')"
              :counter="HEADER_NOTE_MAX"
              :maxlength="HEADER_NOTE_MAX"
              persistent-hint
              rows="2"
              auto-grow
            />
            <slot name="notes" :doc="doc">
              <v-textarea v-model="notesModel" data-testid="document-notes" :label="$t(config.notesFieldLabelKey)" rows="2" auto-grow />
              <v-textarea v-if="config.showTermsField" v-model="form.terms" :label="$t('invoicing.terms')" rows="2" auto-grow />
              <TagInput v-model="form.tags" type="invoice" :org-url="orgUrl()" class="mt-2" />
            </slot>
          </v-col>
          <v-col cols="12" md="6">
            <DocumentTotalsCard :doc="doc" />
            <!-- Fills the "Допълнителна информация" block of the companion documents. Outgoing
                 only, for the same reason the companions themselves are (see `companionDocs`). -->
            <v-textarea
              v-if="companionDocs"
              v-model="companionNote"
              data-testid="companion-note"
              :label="$t('invoicing.companionNote')"
              :hint="$t('invoicing.companionNoteHint')"
              :counter="COMPANION_NOTE_MAX"
              :maxlength="COMPANION_NOTE_MAX"
              persistent-hint
              rows="2"
              auto-grow
              class="mt-3"
            />
          </v-col>
        </v-row>

        <v-divider class="my-4" />
        <BankInfoRow :org="appStore.currentOrg" />
        <SignatureFooter
          v-if="config.showSignatureFooter"
          :prepared-by="form.preparedBy || userFullName"
          :place="form.placeOfTransaction"
          :org-place="config.direction === 'incoming' ? undefined : appStore.currentOrg?.placeOfIssue"
        />
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" :entity-type="config.notesEntityType" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog
      v-model="ledgerDialog"
      :contact-id="form.contactId || ''"
      :org-url="orgUrl()"
      :selectable="true"
      :link-notes="invoiceDispatches.canLink.value"
      @add-lines="onAddLedgerLines"
      @link-notes="invoiceDispatches.linkNotes"
    />
    <ProductPickerDialog
      v-model="productPickerOpen"
      :org-url="orgUrl()"
      :base-currency="baseCurrency"
      :locale="localeCode"
      multiple
      :stock-warehouse-id="docWarehouseId"
      :price-field="config.priceField"
      :existing-product-ids="existingProductIds"
      :initial-search="productPickerText"
      @select-many="onProductsPicked"
    />
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
                {{ r.number }} · {{ formatDate(r.date || '') }}
                <v-chip v-if="r.noSupplier" size="x-small" label class="ml-1" data-testid="receipt-no-supplier">{{ $t('invoicing.linkDelivery.noSupplier') }}</v-chip>
              </v-list-item-title>
              <v-list-item-subtitle>{{ $t('invoicing.linkDelivery.receiptLines', { n: r.lineCount }) }} · {{ doc.fmtCurrency(r.total) }}</v-list-item-subtitle>
              <div v-if="r.notes" class="text-caption text-medium-emphasis" data-testid="receipt-notes">{{ r.notes }}</div>
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

    <!-- FR-22.62: the customer's stock notes this invoice can take. An invoice whose lines already say what they
         delivered keeps them; one that differs is told how, and replaces them only on a second press. -->
    <v-dialog v-model="invoiceDispatches.dialogOpen.value" max-width="640" scrollable>
      <v-card data-testid="link-note-dialog">
        <v-card-title>{{ $t('invoicing.linkNote.action') }}</v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-2">{{ $t('invoicing.linkNote.dialogHint') }}</div>
          <v-progress-linear v-if="invoiceDispatches.loading.value" indeterminate />
          <div v-else-if="!invoiceDispatches.invoiceable.value.length" class="text-body-2" data-testid="link-note-none">{{ $t('invoicing.linkNote.none') }}</div>
          <v-list v-else density="compact">
            <v-list-item v-for="n in invoiceDispatches.invoiceable.value" :key="n.id" data-testid="link-note-row">
              <template #prepend>
                <v-checkbox-btn :model-value="invoiceDispatches.selected.value" :value="n.id" @update:model-value="invoiceDispatches.onSelect" />
              </template>
              <v-list-item-title>
                {{ n.number }} · {{ formatDate(n.date || '') }}
                <v-chip v-if="n.noCustomer" size="x-small" label class="ml-1" data-testid="dispatch-no-customer">{{ $t('invoicing.linkNote.noCustomer') }}</v-chip>
              </v-list-item-title>
              <v-list-item-subtitle>{{ $t('invoicing.linkNote.noteLines', { n: n.lineCount, quantity: n.quantity }, n.lineCount) }}</v-list-item-subtitle>
              <div v-if="n.notes" class="text-caption text-medium-emphasis" data-testid="dispatch-notes">{{ n.notes }}</div>
            </v-list-item>
          </v-list>
        </v-card-text>
        <v-alert v-if="invoiceDispatches.differs.value.length" type="warning" variant="tonal" density="compact" class="mx-4 mt-2 flex-grow-0" data-testid="dispatch-differs">
          <div>{{ $t('invoicing.linkNote.differs') }}</div>
          <ul class="pl-4">
            <li v-for="d in invoiceDispatches.differs.value" :key="d.productId" data-testid="dispatch-differs-line">{{ $t('invoicing.linkNote.differsLine', d) }}</li>
          </ul>
          <div class="mt-1">{{ $t('invoicing.linkNote.replaceWarning') }}</div>
        </v-alert>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="invoiceDispatches.dialogOpen.value = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!invoiceDispatches.selected.value.length"
            :loading="invoiceDispatches.linking.value"
            data-testid="link-note-confirm"
            @click="invoiceDispatches.link"
          >
            {{ $t(invoiceDispatches.differs.value.length ? 'invoicing.linkNote.replaceConfirm' : 'invoicing.linkNote.confirm') }}
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
import { formatDate } from 'ui-shared/format'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { emailDocument } from '../../api/document-email'
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
import DispatchOverlapDialog from '../DispatchOverlapDialog.vue'
import RecordPaymentDialog from '../RecordPaymentDialog.vue'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import IssuePaymentConfirmDialog from '../IssuePaymentConfirmDialog.vue'
import StockReceiptPrintDialog from '../StockReceiptPrintDialog.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import BankInfoRow from '../BankInfoRow.vue'
import SignatureFooter from '../SignatureFooter.vue'
import ContactAutocompleteWithCreate from 'ui-shared/components/ContactAutocompleteWithCreate.vue'
import DateField from 'ui-shared/components/DateField.vue'
import DocumentBanner from './DocumentBanner.vue'
import DocumentUpperSection from './DocumentUpperSection.vue'
import DocumentLineTable from './DocumentLineTable.vue'
import DocumentTotalsCard from './DocumentTotalsCard.vue'
import { useDocumentForm, type UseDocumentFormOptions } from '../../composables/document-form/useDocumentForm'
import { useBillReceipts } from '../../composables/document-form/useBillReceipts'
import { useInvoiceDispatches } from '../../composables/document-form/useInvoiceDispatches'
import type { DocumentTypeConfig } from '../../composables/document-form/types'
import { COLLAPSE, withOutputActions } from '../../composables/document-form/form-actions'

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
// FR-22.61/.62: a sales invoice and the stock notes that delivered its goods.
const invoiceDispatches = useInvoiceDispatches(doc)

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
  issueDateRef,
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
  productPickerText,
  existingProductIds,
  docWarehouseId,
  onProductsPicked,
  showExportDialog,
  printNote,
  companionNote,
  exportLoading,
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
  loadError,
  refusal,
  dismissRefusal,
  loadDocument,
  receiptError,
  receiptTakesPayment,
  deliveryReceiptDue,
  receiptInDoubt,
  paymentReceipts,
  printingReceipt,
  printDeliveryReceipt,
  paymentDialog,
  payableDoc,
  onPaymentRecorded,
  isDraftDoc,
  confirmTransfers,
  paymentConfirm,
  answerPayment,
  dispatchOverlap,
  issueDespiteOverlap,
  overlapLinked,
  printDialogFor,
  printAction,
  stockReceiptAction,
  stockReceiptDialog,
  stockReceiptLoading,
  printStockReceipt,
} = doc

// FR-22.17: the stock check's transfer dialog, as top-level refs so the template unwraps them.
const {
  open: transferOpen,
  shortfalls: transferShortfalls,
  proposals: transferProposals,
  allResolvable: transferAllResolvable,
  confirming: transferConfirming,
} = doc.transfer

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
  lastEmailedAt.value ? formatDate(lastEmailedAt.value) : '',
)

function openEmailDialog() {
  if (isDraft.value) return
  showEmailDialog.value = true
}

async function onSendEmail(payload: { to: string; subject?: string; message?: string }) {
  emailLoading.value = true
  try {
    const id = route.params.id as string
    const answer = await emailDocument(id, {
      ...payload,
      locale: appStore.locale,
    })
    showEmailDialog.value = false
    // FR-20.86: on a server, the mail waits for lgrai.app. Its history is updated when it has gone.
    if (!answer.sent) {
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
 * „Изпрати по имейл" in the action bars (FR-10.8): a saved outgoing document. A draft is blocked, and the
 * button says why: a DRF- number in a customer's inbox is worse than no e-mail at all. FR-10.9: once it has
 * gone out, a quiet marker in front of the button says when, so nobody re-sends blindly.
 */
const emailAction = computed<FormAction | null>(() => (isEdit.value && props.config.direction === 'outgoing'
  ? {
      key: 'email',
      label: t('invoicing.sendEmail.action'),
      color: '',
      variant: 'outlined',
      icon: 'mdi-email-arrow-right-outline',
      handler: openEmailDialog,
      disabled: isDraft.value,
      disabledHint: t('invoicing.sendEmail.draftBlocked'),
      loading: emailLoading.value,
      collapse: COLLAPSE.email,
      note: lastEmailedAt.value
        ? {
            text: formatEmailedAt.value,
            icon: 'mdi-email-check-outline',
            title: t('invoicing.sendEmail.lastSent', { date: formatEmailedAt.value, to: lastEmailedTo.value }),
          }
        : undefined,
    }
  : null))

/**
 * What the form offers, in BOTH bars — under the title and at its foot (`EntityFormShell`, `bottom-actions`):
 * the document's own steps (`formActions`), then what puts it out (e-mail, print, the stock receipt), Import
 * last. One list, drawn twice: an action is in both bars or in neither, in the same order and under the same
 * rule. The two bars used to be built apart — a sales invoice, once issued, kept Save at its foot only, and
 * e-mail and print sat in a third row inside the document.
 */
const barActions = computed<FormAction[]>(() =>
  withOutputActions(formActions.value, [emailAction.value, printAction.value, stockReceiptAction.value]),
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

// Let wrappers (CashSale) drive the create after a suspended onBeforeCreate.
defineExpose({ submitCreate, doc })
</script>
