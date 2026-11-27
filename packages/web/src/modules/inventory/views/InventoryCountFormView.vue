<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('nav.inventoryCount') : $t('common.create') + ' ' + $t('nav.inventoryCount')"
    :subtitle="isEdit ? (countNumber || '') : ''"
    :status="isEdit ? statusDef : undefined"
    :actions="formActions"
    :loading="loading"
    :load-error="loadError"
    :refusal="refusal"
    @retry="fetchItem"
    @dismiss-refusal="dismissRefusal"
    back-to="/inventory-counts"
    :back-label="$t('nav.inventoryCount')"
  >
    <!-- FR-04 (#11): the adjustment movement this count booked, once completed. -->
    <v-alert v-if="adjustmentMovementId" type="info" variant="tonal" density="compact" class="mb-3">
      {{ $t('warehouse.movementDoc') }}:
      <router-link :to="{ name: 'inventory.movements.view', params: { id: adjustmentMovementId } }">
        {{ $t('common.view') }}
      </router-link>
    </v-alert>

    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <!-- FR-33.14: System belongs to the warehouse it was read in, so the warehouse is locked while the count has
               lines. Removing every line unlocks it. -->
          <v-select
            v-model="form.warehouseId"
            :label="$t('warehouse.warehouse')"
            :items="warehouses"
            item-title="name"
            item-value="_id"
            :rules="[rules.required]"
            :disabled="readonly || warehouseLocked"
            :hint="warehouseLocked && !readonly ? warehouseLockHint : undefined"
            :persistent-hint="warehouseLocked && !readonly"
            density="compact"
            data-testid="count-warehouse"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" :disabled="readonly" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-select v-model="form.type" :label="$t('common.type')" :items="countTypes" :disabled="readonly" density="compact" />
        </v-col>
      </v-row>

      <!-- Count Lines. FR-30.17 / FR-33.1: a warehouse of 25 000 levels is a virtual table (only the rows in view are
           drawn), keyed by article, with a line filter and two toggles. A plain table of a field per level took 190 s
           to show its rows. FR-33.4 to .10: the entry line below the rows finds and adds articles as an invoice does. -->
      <div class="d-flex align-center mt-4 mb-2 ga-3 flex-wrap">
        <span class="text-subtitle-2">{{ $t('warehouse.countItems') }}</span>
        <v-text-field
          v-model="lineSearch"
          :placeholder="$t('warehouse.countSearch')"
          prepend-inner-icon="mdi-magnify"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="max-width: 320px"
          data-testid="count-search"
        />
        <v-btn-toggle v-model="lineFilter" mandatory density="compact" variant="outlined" divided data-testid="count-filter">
          <v-btn value="all" size="small">{{ $t('warehouse.countFilter.all') }}</v-btn>
          <v-btn value="notCounted" size="small">{{ $t('warehouse.countFilter.notCounted') }}</v-btn>
          <v-btn value="difference" size="small">{{ $t('warehouse.countFilter.difference') }}</v-btn>
        </v-btn-toggle>
        <span class="text-caption text-medium-emphasis" data-testid="count-shown">{{ shownLines.length }} / {{ form.lines.length }}</span>
        <v-spacer />
        <!-- D-1 / FR-33.10: offered on a new and on an in-progress count; on a count with lines it adds what is missing. -->
        <v-btn v-if="!readonly" variant="outlined" size="small" prepend-icon="mdi-refresh" :loading="loadingLevels" data-testid="count-load" @click="loadProducts">
          {{ $t('warehouse.loadProducts') }}
        </v-btn>
        <v-btn v-if="!readonly" variant="outlined" size="small" prepend-icon="mdi-plus" data-testid="count-add-line" @click="focusEntry">
          {{ $t('invoicing.addLine') }}
        </v-btn>
      </div>
      <div ref="linesRef" class="count-lines" @keydown.capture="onLinesKeydown">
        <component
          :is="virtualLines ? VDataTableVirtual : VDataTable"
          ref="tableRef"
          :headers="lineHeaders"
          :items="shownLines"
          item-value="productId"
          :row-props="rowProps"
          density="compact"
          fixed-header
          :hide-no-data="!readonly"
          v-bind="virtualLines ? { height: '60vh' } : { itemsPerPage: -1, hideDefaultFooter: true }"
          data-testid="count-lines"
        >
          <template #item.lineNo="{ item }">
            <span class="text-medium-emphasis" data-testid="count-line-no">{{ lineNo.get(String(item.productId)) }}</span>
          </template>
          <template #item.product="{ item }">
            <span>{{ item.productName || item.productId }}</span>
            <span v-if="item.productSku" class="text-caption text-medium-emphasis ms-2">{{ item.productSku }}</span>
          </template>
          <template #item.unit="{ item }">
            <span class="text-medium-emphasis">{{ units.get(String(item.productId)) || '' }}</span>
          </template>
          <template #item.systemQuantity="{ item }">
            <span>{{ item.systemQuantity }}</span>
            <div v-if="notStocked.has(String(item.productId))" class="text-caption text-medium-emphasis" data-testid="count-not-stocked">
              {{ $t('warehouse.countLine.notStocked') }}
            </div>
          </template>
          <template #item.qty="{ item }">
            <DecimalField
              :model-value="item.countedQuantity"
              :decimals="QTY_DECIMALS"
              :min-decimals="0"
              min="0"
              density="compact"
              hide-details
              variant="underlined"
              :disabled="readonly"
              :data-line-qty="item.productId"
              data-testid="count-qty"
              @update:model-value="setCounted(item, $event)"
            />
          </template>
          <template #item.variance="{ item }">
            <span :class="(item.countedQuantity - item.systemQuantity) !== 0 ? 'text-error font-weight-bold' : 'text-success'">
              {{ item.countedQuantity - item.systemQuantity }}
            </span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-close" size="x-small" variant="text" tabindex="-1" :title="$t('common.remove')" data-testid="count-remove" @click="removeLine(item)" />
          </template>
          <template v-if="!readonly" #body.append>
            <CountEntryLine
              ref="entryRef"
              :org-url="appStore.orgUrl()"
              :warehouse-id="form.warehouseId"
              :existing-product-ids="countProductIds"
              :colspan="lineHeaders.length - 1"
              :base-currency="baseCurrency"
              :locale="localeCode"
              :note="entryNote"
              @add="addArticles"
            />
          </template>
        </component>
      </div>

      <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" density="compact" :disabled="readonly" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import DecimalField from 'ui-shared/components/DecimalField.vue'
import { QTY_DECIMALS } from 'ui-shared/composables/price-precision'
import { ref, computed, onMounted, nextTick, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { completeInventoryCount, createInventoryCount, getInventoryCount, updateInventoryCount, type InventoryCount } from '../api/inventory-counts'
import { listStockLevels } from '../api/stock-levels'
import { listWarehouses } from '../api/warehouses'
import { reportError } from 'ui-shared/composables/report-error'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import { intlLocale } from 'ui-shared/format'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import { VDataTable, VDataTableVirtual } from 'vuetify/components'
import { searchTextMatcher } from 'config/search-text'
import CountEntryLine from '../components/CountEntryLine.vue'
import { countPayload, lineFromLevel, lineNumbers, missingLevels, type CountLine } from '../composables/count-lines'
import { useCountGridKeys } from '../composables/count-grid-keys'
import { cursorWherePickLeft } from '../composables/count-cursor'
import { describeCountLines, useCountArticles } from '../composables/useCountArticles'

interface Warehouse { _id: string; name: string }

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess } = useSnackbar()
// FR-31.6 / .8: a record that did not load says so; a refused action stays at the top of the form.
const { loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal } = useFormFeedback()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const warehouses = ref<Warehouse[]>([])
const countNumber = ref('')
const countStatus = ref('draft')
const adjustmentMovementId = ref('')
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => intlLocale(appStore.locale))

/** The shell translates a pipeline step as an i18n KEY, so a bare word would render as itself. */
const statusDef = computed<StatusDef>(() => ({
  steps: ['draft', 'in_progress', 'completed'].map(s => `warehouse.countStatus.${s}`),
  current: `warehouse.countStatus.${countStatus.value}`,
}))
const countTypes = computed(() => [
  { value: 'full', title: t('warehouse.countType.full') },
  { value: 'partial', title: t('warehouse.countType.partial') },
  { value: 'cycle', title: t('warehouse.countType.cycle') },
])

const form = ref({
  warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '',
  lines: [] as CountLine[],
})

// ── FR-30.17 / FR-33.2: finding a line among 25 000 ──
/** Above this many lines only the rows in view are drawn; a small count is a plain table of all its rows. */
const VIRTUAL_FROM = 200
const virtualLines = computed(() => form.value.lines.length > VIRTUAL_FROM)
const lineSearch = ref<string | null>('')
const lineFilter = ref<'all' | 'notCounted' | 'difference'>('all')
/**
 * The articles a quantity was typed for since the form opened. A row is keyed by its article (a count holds each
 * article once), so a filter or a scroll never moves a quantity to another row. A saved count's lines that differ from
 * the system count are taken as counted.
 */
const counted = ref(new Set<string>())
const lineHeaders = computed(() => [
  { title: t('warehouse.countLine.lineNo'), key: 'lineNo', width: 56, sortable: false },
  { title: t('warehouse.product'), key: 'product', sortable: false },
  { title: t('warehouse.unit'), key: 'unit', width: 80, sortable: false },
  { title: t('warehouse.systemQty'), key: 'systemQuantity', align: 'end' as const, width: 120, sortable: false },
  // Keyed `qty`, not `countedQuantity`: the table reads every row's value of each column's key, and a typed quantity
  // would then make it read all 25 000 rows again on each keystroke.
  { title: t('warehouse.countedQty'), key: 'qty', align: 'end' as const, width: 140, sortable: false },
  { title: t('warehouse.variance'), key: 'variance', align: 'end' as const, width: 120, sortable: false },
  ...(readonly.value ? [] : [{ title: '', key: 'actions', width: 40, sortable: false }]),
])
/**
 * The rows shown. The line filter reads name, SKU and barcode as the product search does (`config/search-text`): every
 * word, in any case, Latin and Cyrillic look-alikes as one letter. Then the toggle.
 */
const shownLines = computed(() => {
  const matches = searchTextMatcher(lineSearch.value)
  if (!matches && lineFilter.value === 'all') return form.value.lines
  const done = counted.value
  return form.value.lines.filter((l) => {
    if (lineFilter.value === 'notCounted' && done.has(String(l.productId))) return false
    if (lineFilter.value === 'difference' && l.countedQuantity === l.systemQuantity) return false
    return !matches || matches(`${l.productName || ''} ${l.productSku || ''} ${l.productBarcode || ''}`)
  })
})
function setCounted(line: CountLine, value: number) {
  line.countedQuantity = Number.isFinite(value) ? value : 0
  if (!counted.value.has(String(line.productId))) {
    const next = new Set(counted.value)
    next.add(String(line.productId))
    counted.value = next
  }
}
/** A saved count: what differs from the system was counted. */
function countedOf(lines: CountLine[]): Set<string> {
  return new Set(lines.filter((l) => l.countedQuantity !== l.systemQuantity).map((l) => String(l.productId)))
}

// ── FR-33.9: the line number, the unit, "not stocked here" ──
/** Each line's place in the count: it holds when the lines are filtered, so "line 2" can be found. */
const lineNo = computed(() => lineNumbers(form.value.lines))
const countProductIds = computed(() => form.value.lines.map((l) => String(l.productId)))
/**
 * The article's unit, and the articles the warehouse keeps no level of, by article. Context read with the lines, kept
 * out of the form: a unit arriving after the load is not an edit.
 */
const units = shallowRef(new Map<string, string>())
const notStocked = shallowRef(new Set<string>())
/**
 * FR-33.14: locked while the count has lines, on screen or as last saved. The server refuses a change of warehouse on
 * a stored count with lines (422 `count_warehouse_locked`), so an edit page whose lines were all removed saves the
 * empty count first, and then the warehouse is free.
 */
const storedLineCount = ref(0)
const warehouseLocked = computed(() => form.value.lines.length > 0 || storedLineCount.value > 0)
const warehouseLockHint = computed(() => form.value.lines.length > 0
  ? t('warehouse.countLine.warehouseLocked')
  : t('warehouse.countLine.warehouseLockedSaved'))

const { markSaved, markLoaded, tryRestore, isDirty } = usePendingChanges({
  appId: 'inventory',
  entityType: 'inventoryCount',
  icon: 'mdi-clipboard-check',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: t('common.type'), value: countTypes.value.find(c => c.value === form.value.type)?.title ?? form.value.type },
    { label: t('common.date'), value: form.value.date },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

// FR-04 (#11): completed counts are immutable (the backend 409s) — no Save, no Complete.
const readonly = computed(() => isEdit.value && countStatus.value === 'completed')

const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = []
  if (!readonly.value) {
    actions.push({ label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, cap: isEdit.value ? ['inventory-counts.create', 'inventory-counts.edit'] : 'inventory-counts.create', loading: saving.value })
  }
  if (isEdit.value && countStatus.value === 'in_progress') {
    actions.push({ label: t('warehouse.completeCount'), color: 'success', icon: 'mdi-check-all', handler: completeCount, loading: saving.value })
  }
  return actions
})

// ── FR-33.4 to .9: the entry line, the keyboard, adding and removing lines ──
const linesRef = ref<HTMLElement>()
const tableRef = ref<{ scrollToIndex?: (index: number) => void } | null>(null)
const entryRef = ref<{ focus: () => void } | null>(null)
function focusEntry() {
  entryRef.value?.focus()
}
const { onKeydown: onLinesKeydown, focusLine } = useCountGridKeys({
  root: () => linesRef.value,
  shown: () => shownLines.value,
  virtual: () => virtualLines.value,
  scrollToIndex: (index) => tableRef.value?.scrollToIndex?.(index),
  focusEntry,
})
const { entryNote, highlighted, addArticles } = useCountArticles({
  lines: () => form.value.lines,
  warehouseId: () => form.value.warehouseId,
  append: (lines, stocked, unitsOf) => {
    form.value.lines.push(...lines)
    const u = new Map(units.value)
    for (const [id, unit] of unitsOf) u.set(id, unit)
    units.value = u
    const missing = new Set(notStocked.value)
    for (const l of lines) if (!stocked.has(l.productId)) missing.add(l.productId)
    notStocked.value = missing
  },
  reveal: revealLine,
  lineNo: (id) => lineNo.value.get(id) ?? 0,
  t: (key, values) => t(key, values),
})

function rowProps({ item }: { item: CountLine }) {
  const id = String(item.productId)
  return { 'data-testid': 'count-line', 'data-product': id, class: highlighted.value === id ? 'count-line--found' : '' }
}

/**
 * FR-33.7: a line brought into view, through a filter that hid it and past rows the virtual table has not drawn, and
 * the cursor in its Counted. FR-28.27: only while the cursor is still where the pick left it (`count-cursor.ts`): a user
 * who has moved on to another field keeps it.
 */
async function revealLine(productId: string) {
  if (!shownLines.value.some((l) => String(l.productId) === productId)) {
    lineSearch.value = ''
    lineFilter.value = 'all'
  }
  await nextTick()
  // Deferred past the search's own close and a dialog handing focus back, which would take the cursor back.
  setTimeout(() => {
    // Where the pick left it: nowhere, the entry line's Details button, or Details' own "Add N articles" while the
    // dialog leaves (#933). A cursor in the fresh entry field was put there since, by a person finding the next one.
    if (cursorWherePickLeft(document.activeElement, document.body)) void focusLine(productId)
  }, 200)
}

function removeLine(line: CountLine) {
  const id = String(line.productId)
  form.value.lines = form.value.lines.filter((l) => String(l.productId) !== id)
  if (counted.value.has(id)) {
    const next = new Set(counted.value)
    next.delete(id)
    counted.value = next
  }
}

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  loadStarted()
  try {
    // A count that is not there answers `{ inventoryCount: null }`: the form then starts empty.
    const { inventoryCount } = await getInventoryCount(route.params.id as string)
    const detail: Partial<InventoryCount> = inventoryCount ?? {}
    // The GET /:id handler returns the raw doc — its field is countNumber (the `number`
    // alias exists only on the LIST handler), so the subtitle used to render blank.
    countNumber.value = detail.countNumber || ''
    countStatus.value = detail.status || 'draft'
    adjustmentMovementId.value = detail.adjustmentMovementId || ''
    await markLoaded(() => {
      form.value = {
        warehouseId: detail.warehouseId || '', date: detail.date?.split('T')[0] || '', type: detail.type || 'full',
        notes: detail.notes || '',
        lines: (detail.lines || []).map((l) => ({
          productId: l.productId,
          productName: l.productName || '',
          productSku: l.productSku || '',
          productBarcode: l.productBarcode || '',
          systemQuantity: l.systemQuantity ?? 0,
          countedQuantity: l.countedQuantity ?? 0,
          avgCost: 0,
        })),
      }
      counted.value = countedOf(form.value.lines)
    })
    storedLineCount.value = detail.lines?.length ?? 0
    // FR-33.11: each line carries its article's unit (a server without the key leaves it to `describeLines`).
    units.value = new Map((detail.lines || []).filter((l) => typeof l.productUnit === 'string').map((l): [string, string] => [String(l.productId), l.productUnit || '']))
    void describeLines()
  } catch (e: any) {
    loadFailed(e)
  } finally {
    loading.value = false
  }
}

/**
 * A saved count's lines say nothing of a level the warehouse lacks: that is read once, from the warehouse's lean levels
 * (the read "Load products" makes). Their units come with the count's read (FR-33.11); only a draft restored on this
 * device, whose lines kept none, has the catalogue read for the units of the articles with no level. Context only: a
 * refusal leaves them blank.
 */
async function describeLines() {
  const warehouseId = form.value.warehouseId
  const ids = form.value.lines.map((l) => String(l.productId))
  const unitsKnown = ids.every((id) => units.value.has(id))
  // A completed count shows no "not stocked here": with every unit known, there is nothing to read.
  if (!warehouseId || !ids.length || (readonly.value && unitsKnown)) return
  const found = await describeCountLines(warehouseId, ids, units.value)
  const u = new Map(units.value)
  for (const [id, unit] of found.units) u.set(id, unit)
  units.value = u
  if (!readonly.value) notStocked.value = new Set([...notStocked.value, ...found.notStocked])
}

const loadingLevels = ref(false)
/**
 * Every level of the warehouse as a line, Counted starting at System. D-1: on a count that has lines it adds the
 * levels not on it yet, and the lines already there keep what was typed.
 */
async function loadProducts() {
  if (!form.value.warehouseId) return
  loadingLevels.value = true
  try {
    // size: 0 = ALL stock levels. The default page (10) used to silently seed a "full"
    // count with ten products. `fields=count` is the endpoint's lean "all" (FR-30.8): past the list ceiling of a
    // thousand rows, each level narrow.
    const { stockLevels } = await listStockLevels({ warehouseId: form.value.warehouseId, size: 0, fields: 'count' })
    const u = new Map(units.value)
    for (const s of stockLevels) u.set(String(s.productId), s.productUnit || '')
    units.value = u
    if (!form.value.lines.length) {
      form.value.lines = stockLevels.map(lineFromLevel)
      counted.value = new Set()
      return
    }
    const added = missingLevels(form.value.lines, stockLevels)
    form.value.lines.push(...added)
    showSuccess(added.length ? t('warehouse.countLine.loadedMissing', { n: added.length }) : t('warehouse.countLine.loadedNone'))
  } catch (e) {
    reportError(e)
  } finally {
    loadingLevels.value = false
  }
}

/** Save. Quiet when Complete saves first: the completion then says what happened. */
async function save(quiet = false): Promise<boolean> {
  const { valid } = await formRef.value.validate()
  if (!valid) return false
  try {
    const payload = countPayload(form.value)
    if (isEdit.value) {
      await updateInventoryCount(route.params.id as string, payload)
      storedLineCount.value = payload.lines.length
    } else {
      const { inventoryCount } = await createInventoryCount(payload)
      const newId = inventoryCount._id
      if (newId) {
        markSaved()
        succeeded()
        if (!quiet) showSuccess(t('common.savedSuccessfully'))
        void router.replace({ name: 'inventory.inventory-counts.edit', params: { id: newId } })
        return true
      }
    }
    markSaved()
    succeeded()
    if (!quiet) showSuccess(t('common.savedSuccessfully'))
    return true
  } catch (e: any) {
    refused(stockRefusalMessage(e, t))
    return false
  }
}

async function handleSubmit() {
  saving.value = true
  try {
    await save()
  } finally {
    saving.value = false
  }
}

/**
 * FR-33.16: Complete books what the screen shows. With unsaved edits it saves them first, then completes, as one
 * action with one spinner; a refused save completes nothing, and the refusal stays at the top of the form.
 */
async function completeCount() {
  saving.value = true
  try {
    if (isDirty() && !(await save(true))) return
    const { inventoryCount } = await completeInventoryCount(route.params.id as string)
    countStatus.value = 'completed'
    adjustmentMovementId.value = inventoryCount?.adjustmentMovementId || adjustmentMovementId.value
    succeeded()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    refused(stockRefusalMessage(e, t))
  } finally {
    saving.value = false
  }
}

async function fetchWarehouses() {
  try { warehouses.value = (await listWarehouses({ size: 1000 })).warehouses } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
}

onMounted(async () => {
  await fetchWarehouses()
  if (tryRestore()) {
    void describeLines()
    return
  }
  void fetchItem()
})
</script>

<style scoped>
/* The entry line is sticky at the foot of a long count: a field the cursor walks to is never left under it. */
.count-lines :deep(.v-table__wrapper) {
  scroll-padding-bottom: 56px;
}
.count-lines :deep(tr.count-line--found > td) {
  background: rgba(var(--v-theme-warning), 0.18);
  transition: background 0.3s;
}
</style>
