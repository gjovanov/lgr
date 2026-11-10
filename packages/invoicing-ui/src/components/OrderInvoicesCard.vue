<template>
  <!-- FR-22.36: the order's invoices, each number a link to its document. -->
  <!-- FR-28.43: a panel, so the order's other cards can have the room when nobody is reading this one. -->
  <CollapsiblePanel
    v-if="rows.length"
    :screen="screen"
    panel-id="invoices"
    :summary="$t('invoicing.panels.invoices', rows.length)"
    class="mt-4"
    data-testid="order-invoices"
  >
    <template #title>
      <v-icon size="20" color="primary">mdi-file-document-multiple-outline</v-icon>
      {{ $t('invoicing.invoices') }}
      <v-chip size="x-small" variant="tonal">{{ rows.length }}</v-chip>
    </template>
    <v-card-text class="pa-2">
      <div style="overflow-x: auto">
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('invoicing.invoiceNumber') }}</th>
              <th>{{ $t('invoicing.documentType') }}</th>
              <th>{{ $t('invoicing.issueDate') }}</th>
              <th>{{ $t('invoicing.contact') }}</th>
              <th>{{ $t('common.status') }}</th>
              <th class="text-end">{{ $t('common.total') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="text-no-wrap"><EntityLink :label="row.number" :to="row.route" /></td>
              <td class="text-no-wrap">{{ $t(row.typeKey) }}</td>
              <td class="text-no-wrap">{{ fmtDate(row.issueDate) }}</td>
              <td>{{ (row.contactId && contacts?.[row.contactId]) || '—' }}</td>
              <td>
                <v-chip size="x-small" label variant="tonal">{{ te(`invoicing.status.${row.status}`) ? $t(`invoicing.status.${row.status}`) : row.status }}</v-chip>
              </td>
              <td class="text-end text-no-wrap">{{ formatCurrency(row.total, row.currency || currency, localeCode) }}</td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </v-card-text>
  </CollapsiblePanel>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EntityLink from 'ui-shared/components/EntityLink'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { orderInvoiceRows, type OrderInvoiceInfo } from '../composables/order-invoices'

const props = defineProps<{
  /** The screen the card is on (`orders.edit`, `internal-orders.edit`): its state is kept per screen. */
  screen: string
  /** `lookup.invoices` of the order's GET. */
  invoices: Record<string, OrderInvoiceInfo> | null | undefined
  /** `lookup.contacts`: id → name. */
  contacts?: Record<string, string>
  /** For a document that carries none. */
  currency: string
  localeCode: string
}>()

const { te } = useI18n()
const { formatCurrency } = useCurrency()
const rows = computed(() => orderInvoiceRows(props.invoices))

function fmtDate(d: string | undefined) {
  if (!d) return ''
  const date = new Date(d)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(props.localeCode)
}
</script>
