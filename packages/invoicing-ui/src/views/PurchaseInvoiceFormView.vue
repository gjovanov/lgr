<template>
  <div v-if="ready">
    <!-- FR-01: one form for purchase invoice / incoming credit note / incoming debit note.
         Type is chosen at creation only; edit mode shows a badge. -->
    <v-container fluid class="pb-0 pt-3">
      <div class="d-flex align-center ga-3 flex-wrap">
        <span class="text-overline text-medium-emphasis">{{ $t('invoicing.documentType') }}</span>
        <v-btn-toggle
          v-if="!isEdit"
          v-model="apiType"
          mandatory
          density="comfortable"
          variant="outlined"
          divided
        >
          <v-btn v-for="t in TYPES" :key="t" :value="t" size="small">{{ $t(`invoicing.docType.${t}`) }}</v-btn>
        </v-btn-toggle>
        <v-chip v-else size="small" label :color="TYPE_COLORS[apiType]">
          {{ $t(`invoicing.docType.${apiType}`) }}
        </v-chip>
      </div>
    </v-container>
    <DocumentForm :key="apiType" :config="DOCUMENT_CONFIGS[CONFIG_BY_TYPE[apiType]]" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DocumentForm from '../components/document-form/DocumentForm.vue'
import { DOCUMENT_CONFIGS } from '../composables/document-form/configs'
import type { DocType } from '../composables/document-form/types'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../store/app.store'

type PurchaseApiType = 'invoice' | 'credit_note' | 'debit_note'
const TYPES: PurchaseApiType[] = ['invoice', 'credit_note', 'debit_note']
const TYPE_COLORS: Record<PurchaseApiType, string> = { invoice: 'primary', credit_note: 'warning', debit_note: 'error' }
const CONFIG_BY_TYPE: Record<PurchaseApiType, DocType> = {
  invoice: 'purchase_invoice',
  credit_note: 'purchase_credit_note',
  debit_note: 'purchase_debit_note',
}

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const isEdit = computed(() => !!route.params.id)
const apiType = ref<PurchaseApiType>('invoice')
const ready = ref(false)

onMounted(async () => {
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices/${route.params.id}`)
      // Outgoing documents belong to the sales form — bounce over.
      if (data.invoice?.direction === 'outgoing') {
        router.replace({ name: 'invoicing.sales.edit', params: { id: route.params.id as string } })
        return
      }
      const t = data.invoice?.type as string
      apiType.value = (TYPES as string[]).includes(t) ? (t as PurchaseApiType) : 'invoice'
    } catch {
      apiType.value = 'invoice'
    }
  } else {
    const q = String(route.query.type || '')
    apiType.value = (TYPES as string[]).includes(q) ? (q as PurchaseApiType) : 'invoice'
  }
  ready.value = true
})

watch(apiType, (t) => {
  if (isEdit.value) return
  router.replace({ query: { ...route.query, type: t === 'invoice' ? undefined : t } })
})
</script>
