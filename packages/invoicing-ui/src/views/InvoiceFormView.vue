<template>
  <div v-if="ready">
    <!-- FR-01: one form for invoice / credit note / debit note. The type is chosen at
         creation only (the backend strips `type` from PUT), so edit mode shows a badge. -->
    <v-container fluid class="pb-0 pt-3">
      <div class="d-flex align-center ga-3 flex-wrap">
        <span class="text-overline text-medium-emphasis">{{ $t('invoicing.documentType') }}</span>
        <v-btn-toggle
          v-if="!isEdit"
          v-model="docTypeKey"
          mandatory
          density="comfortable"
          variant="outlined"
          divided
        >
          <v-btn v-for="t in TYPES" :key="t" :value="t" size="small">{{ $t(`invoicing.docType.${t}`) }}</v-btn>
        </v-btn-toggle>
        <v-chip v-else size="small" label :color="TYPE_COLORS[docTypeKey]">
          {{ $t(`invoicing.docType.${docTypeKey}`) }}
        </v-chip>
      </div>
    </v-container>
    <!-- Re-key on type switch: the form fully re-initialises with the new config
         (fields, number peek, payload rules). Only possible pre-save, so nothing is lost. -->
    <DocumentForm :key="docTypeKey" :config="DOCUMENT_CONFIGS[docTypeKey]" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DocumentForm from '../components/document-form/DocumentForm.vue'
import { DOCUMENT_CONFIGS } from '../composables/document-form/configs'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../store/app.store'

type SalesDocType = 'invoice' | 'credit_note' | 'debit_note'
const TYPES: SalesDocType[] = ['invoice', 'credit_note', 'debit_note']
const TYPE_COLORS: Record<SalesDocType, string> = { invoice: 'primary', credit_note: 'warning', debit_note: 'error' }

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const isEdit = computed(() => !!route.params.id)
const docTypeKey = ref<SalesDocType>('invoice')
const ready = ref(false)

onMounted(async () => {
  if (isEdit.value) {
    // Resolve which config to mount from the stored document's type. The form re-fetches
    // the document itself — this pre-read is only the config decision.
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices/${route.params.id}`)
      // Incoming documents belong to the purchase form — bounce over (links from the
      // contact ledger etc. route by type only, not by direction).
      if (data.invoice?.direction === 'incoming') {
        router.replace({ name: 'invoicing.purchases.edit', params: { id: route.params.id as string } })
        return
      }
      const t = data.invoice?.type as string
      docTypeKey.value = (TYPES as string[]).includes(t) ? (t as SalesDocType) : 'invoice'
    } catch {
      docTypeKey.value = 'invoice'
    }
  } else {
    const q = String(route.query.type || '')
    docTypeKey.value = (TYPES as string[]).includes(q) ? (q as SalesDocType) : 'invoice'
  }
  ready.value = true
})

// Keep the chosen type in the URL so redirects/deep links (?type=credit_note) round-trip.
watch(docTypeKey, (t) => {
  if (isEdit.value) return
  router.replace({ query: { ...route.query, type: t === 'invoice' ? undefined : t } })
})
</script>
