<template>
  <DocumentForm ref="docFormRef" :config="DOCUMENT_CONFIGS.cash_sale" :on-before-create="onBeforeCreate">
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
  </DocumentForm>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import DocumentForm from '../components/document-form/DocumentForm.vue'
import { DOCUMENT_CONFIGS } from '../composables/document-form/configs'

const { t } = useI18n()
const appStore = useAppStore()
const { showError } = useSnackbar()

const docFormRef = ref<any>(null)
const transferDialog = ref(false)
const transferShortfalls = ref<any[]>([])
const transferProposals = ref<any[]>([])
const transferAllResolvable = ref(false)
const transferConfirming = ref(false)

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

// Pre-create stock check. Returns { proceed:false } (and opens the transfer dialog) when
// stock is insufficient; the composable then suspends until confirmTransferAndSubmit().
async function onBeforeCreate(payload: any): Promise<{ proceed: boolean }> {
  const linesWithStock = (payload.lines || []).filter((l: any) => l.productId && l.warehouseId)
  if (!linesWithStock.length) return { proceed: true }
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/stock-availability/check`, {
      // Reservation-backed lines consume their own hold — send the ref so the pre-flight
      // doesn't report the client's reserved stock as a shortfall.
      lines: linesWithStock.map((l: any) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservationId: l.orderRef?.reservationId || undefined })),
    })
    if (!data.sufficient) {
      transferShortfalls.value = data.shortfalls
      transferProposals.value = data.proposals
      transferAllResolvable.value = data.allResolvable
      transferDialog.value = true
      return { proceed: false }
    }
  } catch {
    // If the check fails, proceed anyway — the backend will validate on create.
  }
  return { proceed: true }
}

async function confirmTransferAndSubmit(proposals: any[]) {
  transferConfirming.value = true
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/stock-availability/create-transfers`, { proposals })
    // Confirm transfers immediately (cash sales are instant), then create with their ids.
    transferDialog.value = false
    await docFormRef.value?.submitCreate({ pendingTransferIds: data.transferIds })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    transferConfirming.value = false
  }
}
</script>
