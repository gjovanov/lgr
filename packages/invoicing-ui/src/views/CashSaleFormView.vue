<template>
  <!-- FR-03: the cash-sale detail page is a POS-terminal layout (cards left, cart right).
       CashSaleTerminal keeps useDocumentForm as the engine, so the payload/save/stock-check
       contract is byte-identical to the old DocumentForm rendering.
       Keyed as the other document views are: a sale's page and a restored draft's are one view
       at two addresses, and left mounted it shows the sale's lines under a New title, ready to be
       issued a second time. -->
  <CashSaleTerminal ref="docFormRef" :key="formKey" :config="DOCUMENT_CONFIGS.cash_sale" :on-before-create="onBeforeCreate">
    <!-- Cash sales dispatch on create: if stock is short, offer cross-warehouse transfers
         before the document is created. The generic composable stays stock-agnostic — this
         flow lives entirely in the wrapper via the onBeforeCreate hook + #dialogs slot. -->
    <template #dialogs>
      <StockTransferDialog
        v-model="transferDialog"
        :shortfalls="transferShortfalls"
        :proposals="transferProposals"
        :all-resolvable="transferAllResolvable"
        :confirming="transferConfirming"
        @confirm="confirmTransferAndSubmit"
      />
    </template>
  </CashSaleTerminal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import CashSaleTerminal from '../components/document-form/CashSaleTerminal.vue'
import { DOCUMENT_CONFIGS } from '../composables/document-form/configs'
import { useDocumentRouteKey } from '../composables/document-form/useDocumentRouteKey'
import { stockCheckLines, useStockTransfer } from '../composables/useDocumentIssue'

const { t } = useI18n()
const { showError } = useSnackbar()

const docFormRef = ref<any>(null)
const { formKey } = useDocumentRouteKey()
// FR-22.17: the same availability check and transfer dialog the invoices issue through.
const {
  open: transferDialog,
  shortfalls: transferShortfalls,
  proposals: transferProposals,
  allResolvable: transferAllResolvable,
  confirming: transferConfirming,
  check: checkStock,
  createTransfers,
} = useStockTransfer()

// Pre-create stock check. Returns { proceed:false } (and opens the transfer dialog) when
// stock is insufficient; the composable then suspends until confirmTransferAndSubmit().
async function onBeforeCreate(payload: any): Promise<{ proceed: boolean }> {
  const linesWithStock = stockCheckLines(payload.lines)
  if (!linesWithStock.length) return { proceed: true }
  try {
    if (!(await checkStock(linesWithStock))) return { proceed: false }
  } catch {
    // If the check fails, proceed anyway — the backend will validate on create.
  }
  return { proceed: true }
}

async function confirmTransferAndSubmit(proposals: any[]) {
  transferConfirming.value = true
  try {
    const transferIds = await createTransfers(proposals)
    // Confirm transfers immediately (cash sales are instant), then create with their ids.
    transferDialog.value = false
    await docFormRef.value?.submitCreate({ pendingTransferIds: transferIds })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    transferConfirming.value = false
  }
}
</script>
