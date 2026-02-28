<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.journalEntries') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
      <v-btn
        color="primary"
        prepend-icon="mdi-plus"
        @click="openDialog()"
      >
        {{ $t('common.add') }}
      </v-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="3">
            <v-select
              v-model="statusFilter"
              :label="$t('common.status')"
              :items="statusOptions"
              clearable
              hide-details
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="dateFrom"
              :label="$t('common.dateFrom')"
              type="date"
              hide-details
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="dateTo"
              :label="$t('common.dateTo')"
              type="date"
              hide-details
            />
          </v-col>
          <v-col cols="12" md="3" class="d-flex align-center">
            <v-btn color="primary" variant="outlined" @click="applyFilters">
              {{ $t('common.filter') }}
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      @update:options="onUpdateOptions"
      @click:row="(_e: any, row: any) => openDialog(row.item)"
    >
      <template #item.date="{ item }">
        {{ item.date?.split('T')[0] }}
      </template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="statusColor(item.status)">
          {{ item.status }}
        </v-chip>
      </template>
      <template #item.totalDebit="{ item }">
        {{ formatCurrency(calcTotalDebit(item), currency, localeCode) }}
      </template>
      <template #item.totalCredit="{ item }">
        {{ formatCurrency(calcTotalCredit(item), currency, localeCode) }}
      </template>
      <template #item.actions="{ item }">
        <v-btn
          v-if="item.status === 'draft'"
          icon="mdi-pencil"
          size="small"
          variant="text"
          @click.stop="openDialog(item)"
        />
        <v-btn
          v-if="item.status === 'draft'"
          icon="mdi-check"
          size="small"
          variant="text"
          color="success"
          :title="$t('accounting.post')"
          @click.stop="postEntry(item)"
        />
        <v-btn
          v-if="item.status === 'posted'"
          icon="mdi-close-circle"
          size="small"
          variant="text"
          color="error"
          :title="$t('accounting.void')"
          @click.stop="voidEntry(item)"
        />
      </template>
    </v-data-table-server>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="900" scrollable>
      <v-card>
        <v-card-title>
          {{ editing ? $t('common.edit') : $t('common.add') }}
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
            color="primary"
            :loading="store.loading"
            :disabled="!isBalanced"
            @click="save"
          >
            {{ $t('common.save') }}
          </v-btn>
          <v-btn
            v-if="!editing"
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
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore, type JournalEntry } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

const appStore = useAppStore()
const store = useAccountingStore()
const { t } = useI18n()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const dialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')
const statusOptions = ['draft', 'posted', 'voided']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (statusFilter.value) f.status = statusFilter.value
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  return f
})

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/journal`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'journalEntries',
  filters,
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

const headers = computed(() => [
  { title: t('accounting.entryNumber'), key: 'number' },
  { title: t('common.date'), key: 'date' },
  { title: t('common.description'), key: 'description' },
  { title: t('common.status'), key: 'status' },
  { title: t('accounting.debit'), key: 'totalDebit', align: 'end' as const },
  { title: t('accounting.credit'), key: 'totalCredit', align: 'end' as const },
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

function calcTotalDebit(entry: JournalEntry) {
  return entry.lines.reduce((s, l) => s + l.debit, 0)
}

function calcTotalCredit(entry: JournalEntry) {
  return entry.lines.reduce((s, l) => s + l.credit, 0)
}

function statusColor(status: string) {
  const colors: Record<string, string> = { draft: 'grey', posted: 'success', voided: 'error' }
  return colors[status] || 'grey'
}

function addLine() {
  form.value.lines.push({ accountId: '', description: '', debit: 0, credit: 0, currency: '', exchangeRate: 1 })
}

function removeLine(idx: number) {
  form.value.lines.splice(idx, 1)
}

function openDialog(item?: JournalEntry | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    const entry = item as JournalEntry
    editing.value = true
    selectedId.value = entry._id
    form.value = {
      date: entry.date?.split('T')[0] || '',
      description: entry.description,
      lines: entry.lines.map(l => ({
        accountId: l.accountId,
        description: l.description || '',
        debit: l.debit,
        credit: l.credit,
        currency: '',
        exchangeRate: 1,
      })),
    }
  } else {
    editing.value = false
    form.value = emptyForm()
  }
  dialog.value = true
}

function applyFilters() {
  fetchItems()
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  await store.createJournalEntry({
    date: form.value.date,
    description: form.value.description,
    lines: form.value.lines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  })
  await fetchItems()
  dialog.value = false
}

async function saveAndPost() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  const entry = await store.createJournalEntry({
    date: form.value.date,
    description: form.value.description,
    lines: form.value.lines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  })
  if (entry?._id) {
    await store.postJournalEntry(entry._id)
  }
  await fetchItems()
  dialog.value = false
}

async function postEntry(entry: JournalEntry) {
  await store.postJournalEntry(entry._id)
  await fetchItems()
}

async function voidEntry(entry: JournalEntry) {
  await store.voidJournalEntry(entry._id)
  await fetchItems()
}

onMounted(() => {
  fetchItems()
  store.fetchAccounts()
})
</script>
