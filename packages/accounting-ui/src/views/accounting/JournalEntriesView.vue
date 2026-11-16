<template>
  <ListScaffold
    :title="$t('accounting.journalEntries')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-book-open-variant', title: $t('accounting.journalEntry.empty') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <export-menu module="accounting" />
      <responsive-btn
        v-cap="'journal.create'"
        color="primary"
        icon="mdi-plus"
        @click="openDialog()"
      >
        {{ $t('common.add') }}
      </responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="statusFilter" :label="$t('common.status')" :items="statusOptions" clearable />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-text-field v-model="dateFrom" :label="$t('common.dateFrom')" type="date" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-text-field v-model="dateTo" :label="$t('common.dateTo')" type="date" />
        </v-col>
        <!-- FR-25a §3.6: what the document header says. -->
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="paymentFilter" :label="$t('accounting.journalEntry.filters.payment')" :items="paymentOptions" clearable />
        </v-col>
        <v-col cols="12" md="auto" class="d-flex flex-wrap align-center ga-2">
          <v-checkbox v-model="unpaidFilter" :label="$t('accounting.journalEntry.filters.unpaid')" density="compact" hide-details />
          <v-checkbox v-model="noticesFilter" :label="$t('accounting.journalEntry.filters.notices')" density="compact" hide-details />
          <v-checkbox v-model="otherMonthFilter" :label="$t('accounting.journalEntry.filters.otherMonth')" density="compact" hide-details />
        </v-col>
      </FilterBar>
    </template>

    <template #item.entryNumber="{ item }">
      <v-icon v-if="isAsBooked(item)" size="x-small" class="mr-1" :title="$t('accounting.journalEntry.document.asBooked')">mdi-lock</v-icon>
      <entity-link :label="item.entryNumber" :to="{ name: 'accounting.journal-entry-edit', params: { id: item._id } }" />
    </template>
    <template #item.date="{ item }">
      {{ item.date?.split('T')[0] }}
    </template>
    <template #item.status="{ item }">
      <v-chip size="small" :color="statusColor(item.status)">
        {{ item.status }}
      </v-chip>
    </template>
    <template #item.totalDebit="{ item }">
      {{ formatCurrency(item.totalDebit ?? 0, currency, localeCode) }}
    </template>
    <template #item.totalCredit="{ item }">
      {{ formatCurrency(item.totalCredit ?? 0, currency, localeCode) }}
    </template>
    <template #item.paymentCode="{ item }">
      {{ paymentLabel(item.paymentCode) }}
    </template>
    <template #item.paidAmount="{ item }">
      {{ typeof item.paidAmount === 'number' ? formatCurrency(item.paidAmount, item.docCurrency || currency, localeCode) : '' }}
    </template>
    <template #item.openAmount="{ item }">
      <span :class="{ 'text-warning font-weight-medium': isUnpaid(item) }">{{ openLabel(item) }}</span>
    </template>
    <template #item.registerDocType="{ item }">
      {{ registerLabel(item.registerDocType) }}
    </template>
    <template #item.reportingMonth="{ item }">
      <span :class="{ 'text-info': isDeclaredInAnotherMonth(item) }">{{ monthInputOf(item.reportingMonth) }}</span>
    </template>
    <template #item.actions="{ item }">
      <template v-if="!isAsBooked(item)">
        <v-btn
          v-if="item.status === 'draft'"
          v-cap="['journal.create', 'journal.edit']"
          icon="mdi-pencil"
          size="small"
          variant="text"
          :title="$t('common.edit')"
          :aria-label="$t('common.edit')"
          :to="{ name: 'accounting.journal-entry-edit', params: { id: item._id } }"
        />
        <v-btn
          v-if="item.status === 'draft'"
          v-cap="'journal.post'"
          icon="mdi-check"
          size="small"
          variant="text"
          color="success"
          :title="$t('accounting.post')"
          @click.stop="postEntry(item)"
        />
        <v-btn
          v-if="item.status === 'posted'"
          v-cap="'journal.post'"
          icon="mdi-close-circle"
          size="small"
          variant="text"
          color="error"
          :title="$t('accounting.void')"
          @click.stop="voidEntry(item)"
        />
      </template>
    </template>

    <!-- Create Dialog -->
    <v-dialog v-model="dialog" max-width="900" scrollable>
      <v-card>
        <v-card-title>
          {{ $t('common.add') }}
        </v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="4">
                <v-text-field
                  v-model="form.date"
                  :label="$t('common.date')"
                  type="date"
                  :rules="[rules.required]"
                />
              </v-col>
              <v-col cols="12" md="8">
                <v-text-field
                  v-model="form.description"
                  :label="$t('common.description')"
                  :rules="[rules.required]"
                />
              </v-col>
            </v-row>

            <!-- Line Items -->
            <div class="d-flex align-center mt-2 mb-2">
              <span class="text-subtitle-1 font-weight-medium">
                {{ $t('accounting.lines') }}
              </span>
              <v-spacer />
              <v-btn
                color="primary"
                variant="outlined"
                size="small"
                prepend-icon="mdi-plus"
                @click="addLine"
              >
                {{ $t('accounting.addLine') }}
              </v-btn>
            </div>

            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('accounting.account') }}</th>
                  <th>{{ $t('common.description') }}</th>
                  <th class="text-end">{{ $t('accounting.debit') }}</th>
                  <th class="text-end">{{ $t('accounting.credit') }}</th>
                  <th class="text-end">{{ $t('common.currency') }}</th>
                  <th class="text-end">{{ $t('accounting.exchangeRate') }}</th>
                  <th style="width: 40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td style="min-width: 200px">
                    <v-select
                      v-model="line.accountId"
                      :items="accountOptions"
                      item-title="label"
                      item-value="_id"
                      density="compact"
                      hide-details
                      variant="underlined"
                    />
                  </td>
                  <td>
                    <v-text-field
                      v-model="line.description"
                      density="compact"
                      hide-details
                      variant="underlined"
                    />
                  </td>
                  <td style="width: 130px">
                    <v-text-field
                      v-model.number="line.debit"
                      type="number"
                      min="0"
                      density="compact"
                      hide-details
                      variant="underlined"
                      class="text-end"
                    />
                  </td>
                  <td style="width: 130px">
                    <v-text-field
                      v-model.number="line.credit"
                      type="number"
                      min="0"
                      density="compact"
                      hide-details
                      variant="underlined"
                      class="text-end"
                    />
                  </td>
                  <td style="width: 90px">
                    <v-text-field
                      v-model="line.currency"
                      density="compact"
                      hide-details
                      variant="underlined"
                    />
                  </td>
                  <td style="width: 100px">
                    <v-text-field
                      v-model.number="line.exchangeRate"
                      type="number"
                      step="0.0001"
                      density="compact"
                      hide-details
                      variant="underlined"
                      class="text-end"
                    />
                  </td>
                  <td>
                    <v-btn
                      icon="mdi-close"
                      size="x-small"
                      variant="text"
                      @click="removeLine(idx)"
                    />
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="font-weight-bold">
                  <td colspan="2">{{ $t('common.total') }}</td>
                  <td class="text-end">{{ formatCurrency(totalDebit, currency, localeCode) }}</td>
                  <td class="text-end">{{ formatCurrency(totalCredit, currency, localeCode) }}</td>
                  <td colspan="3"></td>
                </tr>
              </tfoot>
            </v-table>

            <v-alert
              v-if="!isBalanced && form.lines.length > 0"
              type="error"
              density="compact"
              class="mt-3"
            >
              {{ $t('accounting.unbalanced') }}:
              {{ formatCurrency(Math.abs(totalDebit - totalCredit), currency, localeCode) }}
            </v-alert>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn
            v-cap="['journal.create', 'journal.edit']"
            color="primary"
            :loading="store.loading"
            :disabled="!isBalanced"
            @click="save"
          >
            {{ $t('common.save') }}
          </v-btn>
          <v-btn
            v-cap="'journal.post'"
            color="success"
            :loading="store.loading"
            :disabled="!isBalanced"
            @click="saveAndPost"
          >
            {{ $t('accounting.saveAndPost') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PAYMENT_WAYS, isAsBooked, isDeclaredInAnotherMonth, isUnpaid, monthInputOf, openAmountOf, paymentWayOf, registerDocTypeCode,
  registerDocTypeKey,
} from 'config/journal-header'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore, type JournalEntry } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'

const appStore = useAppStore()
const store = useAccountingStore()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', bg: 'bg-BG', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const { search, debouncedSearch } = useSearchDebounce()
const dialog = ref(false)
const formRef = ref()
const statusFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')
const statusOptions = ['draft', 'posted', 'voided']
// FR-25a §3.6: the header's filters.
const paymentFilter = ref<string | null>(null)
const unpaidFilter = ref(false)
const noticesFilter = ref(false)
const otherMonthFilter = ref(false)
const paymentOptions = computed(() => PAYMENT_WAYS.map(way => ({ title: t(`accounting.paymentCodes.${way}`), value: way })))

const hasActiveFilters = computed(() => !!debouncedSearch.value || !!statusFilter.value || !!dateFrom.value || !!dateTo.value
  || !!paymentFilter.value || unpaidFilter.value || noticesFilter.value || otherMonthFilter.value)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (statusFilter.value) f.status = statusFilter.value
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  if (paymentFilter.value) f.payment = paymentFilter.value
  if (unpaidFilter.value) f.unpaid = 'true'
  if (noticesFilter.value) f.notices = 'true'
  if (otherMonthFilter.value) f.otherMonth = 'true'
  return f
})

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/journal`)
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'status', ref: statusFilter },
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
  { key: 'payment', ref: paymentFilter },
  { key: 'unpaid', ref: unpaidFilter, codec: 'bool' },
  { key: 'notices', ref: noticesFilter, codec: 'bool' },
  { key: 'otherMonth', ref: otherMonthFilter, codec: 'bool' },
])

// Newest first by date: `{orgId, date}` serves it, where `createdAt` made every page sort the org's whole journal.
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'journalEntries',
  defaultSortBy: 'date',
  filters,
  urlSync: true,
})

interface LineForm {
  accountId: string
  description: string
  debit: number
  credit: number
  currency: string
  exchangeRate: number
}

const emptyForm = () => ({
  date: new Date().toISOString().split('T')[0],
  description: '',
  lines: [
    { accountId: '', description: '', debit: 0, credit: 0, currency: '', exchangeRate: 1 },
    { accountId: '', description: '', debit: 0, credit: 0, currency: '', exchangeRate: 1 },
  ] as LineForm[],
})

const form = ref(emptyForm())

// FR-25a: the header's columns are on the cog, hidden until a person shows them, and not sortable: no index serves a
// sort on them over a books org's journal. The open amount is worked out, never stored.
const headers = computed(() => [
  { title: t('accounting.entryNumber'), key: 'entryNumber' },
  { title: t('common.date'), key: 'date' },
  { title: t('common.description'), key: 'description' },
  { title: t('common.status'), key: 'status' },
  { title: t('accounting.debit'), key: 'totalDebit', align: 'end' as const },
  { title: t('accounting.credit'), key: 'totalCredit', align: 'end' as const },
  { title: t('accounting.journalEntry.columns.paymentCode'), key: 'paymentCode', sortable: false, defaultHidden: true },
  { title: t('accounting.journalEntry.columns.paidAmount'), key: 'paidAmount', align: 'end' as const, sortable: false, defaultHidden: true },
  { title: t('accounting.journalEntry.columns.openAmount'), key: 'openAmount', align: 'end' as const, sortable: false, defaultHidden: true },
  { title: t('accounting.journalEntry.columns.registerDocType'), key: 'registerDocType', sortable: false, defaultHidden: true },
  { title: t('accounting.journalEntry.columns.reportingMonth'), key: 'reportingMonth', sortable: false, defaultHidden: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const accountOptions = computed(() =>
  store.activeAccounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const totalDebit = computed(() => form.value.lines.reduce((s, l) => s + (l.debit || 0), 0))
const totalCredit = computed(() => form.value.lines.reduce((s, l) => s + (l.credit || 0), 0))
const isBalanced = computed(() => form.value.lines.length > 0 && Math.abs(totalDebit.value - totalCredit.value) < 0.01)

const rules = {
  required: (v: string) => !!v || 'Required',
}

function statusColor(status: string) {
  const colors: Record<string, string> = { draft: 'grey', posted: 'success', voided: 'error' }
  return colors[status] || 'grey'
}

/** A code as booked that no list names is shown as booked. */
function paymentLabel(code?: string) {
  const way = paymentWayOf(code)
  return way ? t(`accounting.paymentCodes.${way}`) : code ?? ''
}

function registerLabel(value?: string) {
  const key = registerDocTypeKey(value)
  return key ? `${registerDocTypeCode(value)} · ${t(`accounting.journalEntry.document.registerDocTypes.${key}`)}` : value ?? ''
}

function openLabel(item: any) {
  const open = openAmountOf(item)
  return open === undefined ? '' : formatCurrency(open, item.docCurrency || currency.value, localeCode.value)
}

function addLine() {
  form.value.lines.push({ accountId: '', description: '', debit: 0, credit: 0, currency: '', exchangeRate: 1 })
}

function removeLine(idx: number) {
  form.value.lines.splice(idx, 1)
}

/** A new entry. An existing one opens on its own page, which reads it whole: the list carries no lines. */
function openDialog() {
  form.value = emptyForm()
  dialog.value = true
}

function payloadOf() {
  return {
    date: form.value.date,
    description: form.value.description,
    lines: form.value.lines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    await store.createJournalEntry(payloadOf())
    showSuccess(t('common.savedSuccessfully'))
    await fetchItems()
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function saveAndPost() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const entry = await store.createJournalEntry(payloadOf())
    if (entry?._id) {
      await store.postJournalEntry(entry._id)
    }
    showSuccess(t('common.postedSuccessfully'))
    await fetchItems()
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function postEntry(entry: JournalEntry) {
  try {
    await store.postJournalEntry(entry._id)
    showSuccess(t('common.postedSuccessfully'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function voidEntry(entry: JournalEntry) {
  try {
    await store.voidJournalEntry(entry._id)
    showSuccess(t('common.voidedSuccessfully'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
  store.fetchAccounts()
})
</script>
