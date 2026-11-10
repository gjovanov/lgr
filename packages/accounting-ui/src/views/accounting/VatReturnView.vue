<template>
  <v-container fluid>
    <div class="d-flex align-center flex-wrap ga-2 mb-2">
      <v-btn icon="mdi-arrow-left" variant="text" size="small" :title="$t('accounting.vat.title')" @click="router.push({ name: 'accounting.tax-returns' })" />
      <h1 class="text-h5">{{ $t('accounting.vat.titleOne') }} {{ periodLabel(period) }}</h1>
      <v-chip v-if="taxReturn" size="small" :color="statusColor(taxReturn.status)">{{ $t(`accounting.vat.status.${taxReturn.status}`) }}</v-chip>
      <v-spacer />
      <v-btn v-if="canFile && open" color="primary" prepend-icon="mdi-file-cog-outline" :loading="busy" @click="generate()">
        {{ taxReturn ? $t('accounting.vat.regenerate') : $t('accounting.vat.generate') }}
      </v-btn>
      <v-btn v-if="canFile && taxReturn?.status === 'generated'" color="success" variant="outlined" prepend-icon="mdi-check-decagram-outline" @click="filing.open = true">
        {{ $t('accounting.vat.markFiled') }}
      </v-btn>
    </div>
    <!-- D7: LGR produces the files and a person files them. The screen says so, because the button does not. -->
    <p class="text-body-2 text-medium-emphasis mb-4">{{ open ? $t('accounting.vat.note') : $t('accounting.vat.frozen') }}</p>

    <v-alert v-if="loaded && !taxReturn" type="info" variant="tonal" density="compact" class="mb-4">
      {{ $t('accounting.vat.noReturn') }}
      {{ $t('accounting.vat.waiting', { sales: counts.sales, purchases: counts.purchase }) }}
    </v-alert>

    <v-row v-if="taxReturn" class="mb-2">
      <v-col cols="12" md="7">
        <v-card variant="outlined">
          <v-card-title class="text-subtitle-1">{{ $t('accounting.vat.cells') }}</v-card-title>
          <v-table density="compact">
            <tbody>
              <tr v-for="cell in filledCells" :key="cell.code">
                <td class="text-medium-emphasis text-no-wrap" style="width: 64px">{{ cell.code }}</td>
                <td>{{ cell.label }}</td>
                <td class="text-right text-no-wrap">{{ cell.value }}</td>
              </tr>
              <tr v-if="!filledCells.length">
                <td colspan="3" class="text-medium-emphasis">{{ $t('accounting.vat.noCells') }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card>
      </v-col>
      <v-col cols="12" md="5">
        <v-card variant="outlined">
          <v-card-title class="text-subtitle-1">{{ $t('accounting.vat.files') }}</v-card-title>
          <v-list density="compact">
            <v-list-item v-for="file in taxReturn.files" :key="file.name" :title="file.name" :subtitle="`${file.bytes} B`" :disabled="!canDownload" @click="download(file.name)">
              <template v-if="canDownload" #append><v-icon size="small">mdi-download</v-icon></template>
            </v-list-item>
          </v-list>
          <v-divider />
          <v-card-text class="text-body-2">
            <div v-if="taxReturn.source">{{ $t(`accounting.vat.source.${taxReturn.source}`) }}</div>
            <div v-if="taxReturn.filedAt">{{ $t('accounting.vat.filedAt') }}: {{ taxReturn.filedAt.split('T')[0] }}</div>
            <div v-if="filedByName">{{ $t('accounting.vat.filedBy') }}: {{ filedByName }}</div>
            <div v-if="taxReturn.ack?.number">{{ $t('accounting.vat.ackNumber') }}: {{ taxReturn.ack.number }}</div>
            <v-btn v-if="taxReturn.ack?.fileId" class="mt-2" size="small" variant="text" prepend-icon="mdi-download" @click="downloadAck">
              {{ $t('accounting.vat.ack') }}
            </v-btn>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-tabs v-model="side" density="compact" class="mb-2">
      <v-tab value="sales">{{ $t('accounting.vat.sales') }} ({{ counts.sales }})</v-tab>
      <v-tab value="purchase">{{ $t('accounting.vat.purchases') }} ({{ counts.purchase }})</v-tab>
    </v-tabs>
    <v-data-table-server
      :headers="rowHeaders"
      :items="rows"
      :items-length="pagination.total"
      :loading="rowsLoading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      density="compact"
      @update:options="onUpdateOptions"
    >
      <template #item.rowNo="{ item }">{{ item.rowNo || '' }}</template>
      <template #item.docDate="{ item }">{{ item.docDate?.split('T')[0] }}</template>
      <template #item.base="{ item }">{{ rowBase(item) }}</template>
      <template #item.vat="{ item }">{{ rowVat(item) }}</template>
    </v-data-table-server>

    <!-- What the registers cannot say. Asked once: the next return takes it from this one. -->
    <v-dialog v-model="asking.open" max-width="560">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ $t('accounting.vat.askDeclarant') }}</v-card-title>
        <v-card-text class="pt-2">
          <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('accounting.vat.askDeclarantNote') }}</p>
          <v-text-field v-if="asking.needsFiler" v-model="asking.filer" :label="$t('accounting.vat.filer')" density="compact" variant="outlined" maxlength="50" />
          <template v-if="asking.needsVies">
            <v-text-field v-model="asking.vies.id" :label="$t('accounting.vat.viesId')" density="compact" variant="outlined" maxlength="15" />
            <v-text-field v-model="asking.vies.name" :label="$t('accounting.vat.viesName')" density="compact" variant="outlined" maxlength="150" />
            <v-text-field v-model="asking.vies.city" :label="$t('accounting.vat.viesCity')" density="compact" variant="outlined" maxlength="50" />
            <v-text-field v-model="asking.vies.postcode" :label="$t('accounting.vat.viesPostcode')" density="compact" variant="outlined" maxlength="4" />
            <v-text-field v-model="asking.vies.address" :label="$t('accounting.vat.viesAddress')" density="compact" variant="outlined" maxlength="150" />
            <v-select v-model="asking.vies.kind" :label="$t('accounting.vat.viesKind')" :items="viesKinds" density="compact" variant="outlined" />
            <v-text-field v-model="asking.vies.companyAddress" :label="$t('accounting.vat.companyAddress')" density="compact" variant="outlined" maxlength="200" />
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="asking.open = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" @click="answerAndGenerate">{{ $t('accounting.vat.generate') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="filing.open" max-width="480">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ $t('accounting.vat.markFiled') }}</v-card-title>
        <v-card-text class="pt-2">
          <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('accounting.vat.markFiledNote') }}</p>
          <v-text-field v-model="filing.number" :label="$t('accounting.vat.ackNumber')" density="compact" variant="outlined" maxlength="64" />
          <v-file-input v-model="filing.file" :label="$t('accounting.vat.ackFile')" density="compact" variant="outlined" prepend-icon="" prepend-inner-icon="mdi-paperclip" clearable />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="filing.open = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="success" :disabled="!filing.number.trim()" :loading="busy" @click="markFiled">{{ $t('accounting.vat.markFiled') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { downloadAsSession } from 'ui-shared/composables/useSessionDownload'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAccess } from 'ui-shared/access/useAccess'
import { VAT_CELLS, periodLabel, statusColor } from './vat-cells'

interface VatReturn {
  status: string
  source?: string
  cells?: Record<string, number>
  files?: { name: string; sha256: string; bytes: number }[]
  filedAt?: string
  ack?: { number: string; fileId?: string }
}

const appStore = useAppStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const period = computed(() => String(route.params.period))
const base = computed(() => `/org/${appStore.currentOrg?.id}/accounting/vat/${period.value}`)

const taxReturn = ref<VatReturn | null>(null)
const filedByName = ref('')
const currency = ref('EUR')
const counts = ref({ sales: 0, purchase: 0 })
const loaded = ref(false)
const busy = ref(false)

/** A return that has not been filed. The server holds the same line (`vat-return.service.ts`). */
const open = computed(() => !taxReturn.value || ['draft', 'generated'].includes(taxReturn.value.status))
// FR-27.7: the route rule's own capability (`vat.file`), from the session's grant, followed live.
const { can } = useAccess()
const canFile = computed(() => can('vat.file'))
/** The files name a person, so they go to who files them or audits them, as the server's read rule says. */
const canDownload = computed(() => canFile.value || !!appStore.user?.permissions?.includes('admin.audit'))

const localeCode = computed(() => ({ en: 'en-US', bg: 'bg-BG', mk: 'mk-MK', de: 'de-DE' } as Record<string, string>)[appStore.locale] || 'en-US')
const money = (cents = 0) => formatCurrency(cents / 100, currency.value, localeCode.value)

const filledCells = computed(() => VAT_CELLS
  .filter(c => taxReturn.value?.cells?.[c.code])
  .map(c => ({ ...c, value: c.coefficient ? (taxReturn.value!.cells![c.code] / 100).toFixed(2) : money(taxReturn.value!.cells![c.code]) })))

// The register, a page at a time.
const side = ref<'sales' | 'purchase'>('sales')
const filters = computed(() => ({ side: side.value }))
const rowsUrl = computed(() => `${base.value}/rows`)
const { items: rows, loading: rowsLoading, pagination, fetchItems: fetchRows, onUpdateOptions } = usePaginatedTable({
  url: rowsUrl,
  entityKey: 'rows',
  defaultSize: 25,
  defaultSortBy: 'rowNo',
  defaultSortOrder: 'asc',
  filters,
})

const rowHeaders = computed(() => [
  { title: t('accounting.vat.rowNo'), key: 'rowNo', sortable: false },
  { title: t('accounting.vat.docType'), key: 'docTypeCode', sortable: false },
  { title: t('accounting.vat.docNumber'), key: 'docNumber', sortable: false },
  { title: t('accounting.vat.docDate'), key: 'docDate', sortable: false },
  { title: t('accounting.vat.partnerVat'), key: 'partnerVat', sortable: false },
  { title: t('accounting.vat.partnerName'), key: 'partnerName', sortable: false },
  { title: t('accounting.vat.base'), key: 'base', align: 'end' as const, sortable: false },
  { title: t('accounting.vat.vat'), key: 'vat', align: 'end' as const, sortable: false },
])

// A blank cell stays blank, as in the file. 02-10 leaves out the bases that are not taxed here (02-17,
// 02-18, 02-19, 02-25), and a row of those is still a row with a base.
const cell = (row: any, ...codes: string[]) => {
  const cents = codes.reduce((sum, code) => sum + (row.cells?.[code] ?? 0), 0)
  return cents ? money(cents) : ''
}
const rowBase = (row: any) => (side.value === 'sales' ? cell(row, '02-10', '02-17', '02-18', '02-19', '02-25') : cell(row, '03-30', '03-31', '03-32'))
const rowVat = (row: any) => (side.value === 'sales' ? cell(row, '02-20') : cell(row, '03-41', '03-42'))

async function load() {
  try {
    const { data } = await httpClient.get(base.value)
    taxReturn.value = data.taxReturn
    filedByName.value = data.filedByName ?? ''
    currency.value = data.currency
    counts.value = data.counts
    loaded.value = true
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

const emptyVies = () => ({ id: '', name: '', city: '', postcode: '', address: '', kind: 'A', companyAddress: '' })
const asking = reactive({ open: false, filer: '', needsFiler: false, needsVies: false, vies: emptyVies() })
const viesKinds = computed(() => [
  { title: t('accounting.vat.viesKindAgent'), value: 'A' },
  { title: t('accounting.vat.viesKindRepresentative'), value: 'R' },
])

async function generate(answers: Record<string, unknown> = {}) {
  busy.value = true
  try {
    await httpClient.post(`${base.value}/generate`, answers)
    asking.open = false
    showSuccess(t('accounting.vat.generated'))
    await Promise.all([load(), fetchRows()])
  } catch (e: any) {
    const data = e?.response?.data
    if (data?.code === 'vat_declarant_missing') {
      asking.needsFiler = (data.fields as string[]).includes('filer')
      asking.needsVies = (data.fields as string[]).some(f => f.startsWith('vies.'))
      asking.open = true
    } else {
      showError(data?.message || t('common.operationFailed'))
    }
  } finally {
    busy.value = false
  }
}

function answerAndGenerate() {
  generate({ ...(asking.filer.trim() ? { filer: asking.filer.trim() } : {}), ...(asking.needsVies ? { vies: { ...asking.vies } } : {}) })
}

const filing = reactive<{ open: boolean; number: string; file: File | null }>({ open: false, number: '', file: null })

async function markFiled() {
  busy.value = true
  try {
    const form = new FormData()
    form.set('number', filing.number.trim())
    if (filing.file) form.set('file', filing.file)
    // ⚠ Unset, so the browser writes the multipart boundary. Under the client's JSON default axios
    // serialises the form to JSON: the number arrives and the file does not, and nothing says so.
    await httpClient.post(`${base.value}/mark-filed`, form, { headers: { 'Content-Type': undefined } })
    filing.open = false
    showSuccess(t('accounting.vat.filedDone'))
    await load()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    busy.value = false
  }
}

async function download(name: string) {
  try {
    await downloadAsSession(`${base.value}/file/${encodeURIComponent(name)}`, name)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function downloadAck() {
  try {
    await downloadAsSession(`${base.value}/ack`, 'acknowledgement')
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

watch(period, load)
onMounted(load)
</script>
