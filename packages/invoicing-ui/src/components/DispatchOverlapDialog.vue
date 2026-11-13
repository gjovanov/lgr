<template>
  <v-dialog :model-value="!!overlap" max-width="640" scrollable @update:model-value="onToggle">
    <v-card v-if="overlap" data-testid="dispatch-overlap-dialog">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="warning">mdi-alert-outline</v-icon>
        {{ $t('invoicing.dispatchOverlap.title') }}
      </v-card-title>
      <v-card-text>
        <div class="text-body-2 mb-2">{{ $t('invoicing.dispatchOverlap.text') }}</div>
        <v-list density="compact">
          <v-list-item v-for="n in overlap.notes" :key="n.id" data-testid="dispatch-overlap-row">
            <template #prepend>
              <v-checkbox-btn v-model="selected" :value="n.id" :disabled="busy" />
            </template>
            <v-list-item-title>
              <a :href="noteHref(n.id)" target="_blank" rel="noopener" class="font-weight-medium">{{ n.number }}</a>
              · {{ String(n.date || '').slice(0, 10) }}
              <v-chip v-if="n.noCustomer" size="x-small" label class="ml-1" data-testid="dispatch-no-customer">{{ $t('invoicing.linkNote.noCustomer') }}</v-chip>
            </v-list-item-title>
            <v-list-item-subtitle>{{ $t('invoicing.linkNote.noteLines', { n: n.lineCount, quantity: n.quantity }, n.lineCount) }}</v-list-item-subtitle>
            <div v-if="n.notes" class="text-caption text-medium-emphasis" data-testid="dispatch-notes">{{ n.notes }}</div>
          </v-list-item>
        </v-list>
        <!-- An invoice with no customer: a link would be refused for want of one, and the only other way out dispatches the goods twice. -->
        <template v-if="overlap.needsCustomer">
          <div class="text-body-2 mt-2 mb-2">{{ $t('invoicing.dispatchOverlap.chooseCustomer') }}</div>
          <v-defaults-provider :defaults="{ VAutocomplete: { density: 'compact' } }">
            <ContactAutocompleteWithCreate
              v-model="customerId"
              :contacts="customers.contacts.value"
              :loading="customers.loading.value"
              :label="$t('invoicing.customer')"
              :org-url="orgUrl"
              new-contact-type="customer"
              data-testid="dispatch-overlap-customer"
              @update:search="customers.onSearch"
              @contact-created="customers.add"
            />
          </v-defaults-provider>
        </template>
      </v-card-text>
      <!-- FR-22.62: the invoice says something other than the note delivered. Said before anything is replaced. -->
      <v-alert v-if="differs.length" type="warning" variant="tonal" density="compact" class="mx-4 mt-2 flex-grow-0" data-testid="dispatch-differs">
        <div>{{ $t('invoicing.linkNote.differs') }}</div>
        <ul class="pl-4">
          <li v-for="d in differs" :key="d.productId" data-testid="dispatch-differs-line">{{ $t('invoicing.linkNote.differsLine', d) }}</li>
        </ul>
        <div class="mt-1">{{ $t('invoicing.linkNote.replaceWarning') }}</div>
      </v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mx-4 mt-2 flex-grow-0" data-testid="dispatch-overlap-error">{{ error }}</v-alert>
      <v-card-actions class="flex-wrap">
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="close">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="warning" variant="outlined" :disabled="busy" data-testid="dispatch-overlap-issue" @click="issueAnyway">
          {{ $t('invoicing.dispatchOverlap.issueAnyway') }}
        </v-btn>
        <v-btn color="primary" variant="flat" :loading="linking" :disabled="!canLink" data-testid="dispatch-overlap-link" @click="link">
          {{ $t(differs.length ? 'invoicing.linkNote.replaceConfirm' : 'invoicing.dispatchOverlap.link') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { useContactSearch } from 'ui-shared/composables/useContactSearch'
import ContactAutocompleteWithCreate from 'ui-shared/components/ContactAutocompleteWithCreate.vue'
import { appHref } from 'ui-shared/nav/navigate'
import { linkDispatches, preselectedDispatches, type DispatchOverlap, type QuantityDifference } from '../composables/document-issue'

/**
 * FR-22.61b: a sales invoice about to dispatch goods that may have already left on a stock note. The two ways out
 * are linking it to the note (the invoice then moves nothing) and issuing it anyway, which stays on the audit log.
 *
 * Linking is done here, and the issue is the caller's (`useDocumentIssue`): an invoice that kept its lines is issued
 * at once, one that took the note's lines stays a draft to be read. Issuing anyway is the caller's too, because the
 * stock is checked only now.
 */
const props = defineProps<{
  overlap: DispatchOverlap | null
  orgUrl: string
}>()

const emit = defineEmits<{
  /** Closed with no answer: the invoice stays a draft. */
  'update:overlap': [value: DispatchOverlap | null]
  /** The invoice is linked to the note. `linesWritten`: the note's lines took the place of what was typed. */
  linked: [linesWritten: boolean]
  /** „Other goods": issue it as it is. */
  'issue-anyway': []
}>()

const { t } = useI18n()

const selected = ref<string[]>([])
const linking = ref(false)
const error = ref('')
/** What the server found different, once a link was refused for it: the next press replaces the lines. */
const differs = ref<QuantityDifference[]>([])
const busy = computed(() => linking.value)

const customerId = ref<string | undefined>(undefined)
const customers = useContactSearch({
  orgUrl: () => props.orgUrl,
  type: () => 'customer',
  selected: () => [customerId.value],
})
const canLink = computed(() => !busy.value && selected.value.length > 0 && (!props.overlap?.needsCustomer || !!customerId.value))

watch(() => props.overlap, (o) => {
  error.value = ''
  differs.value = []
  selected.value = preselectedDispatches(o?.notes ?? [])
  customerId.value = undefined
  if (o?.needsCustomer) void customers.search()
})
// Another choice of notes is another comparison: what was found different no longer describes it.
watch(selected, () => { differs.value = [] })

const noteHref = (id: string) => appHref('inventory', `/inventory/movements/${id}`)

function close() {
  emit('update:overlap', null)
}

function onToggle(open: boolean) {
  if (!open && !busy.value) close()
}

async function link() {
  const overlap = props.overlap
  if (!overlap || !canLink.value) return
  linking.value = true
  error.value = ''
  try {
    const result = await linkDispatches(httpClient, props.orgUrl, overlap.invoiceId, {
      movementIds: selected.value,
      ...(differs.value.length ? { replaceLines: true } : {}),
      ...(overlap.needsCustomer ? { contactId: customerId.value } : {}),
    })
    if (!result.linked) {
      differs.value = result.differs
      return
    }
    emit('linked', result.linesWritten)
  } catch (e: any) {
    error.value = stockRefusalMessage(e, t)
  } finally {
    linking.value = false
  }
}

function issueAnyway() {
  if (!props.overlap || busy.value) return
  emit('issue-anyway')
}
</script>
