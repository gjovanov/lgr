<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('accounting.fixedAsset') : $t('common.create') + ' ' + $t('accounting.fixedAsset')"
    :subtitle="isEdit ? form.name : ''"
    :status="isEdit ? statusPipeline : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/fixed-assets"
    :back-label="$t('accounting.fixedAssets')"
  >
    <!-- FR-25a §3.4: an asset the books import made is as booked: the whole form is read-only, and the server refuses a save. -->
    <v-alert v-if="asBooked" type="info" variant="tonal" density="compact" icon="mdi-lock-outline" class="mb-4" data-testid="fixed-asset-as-booked">
      {{ $t('accounting.fixedAssetBooks.asBooked') }}
    </v-alert>

    <!-- The books' analytic the asset was made from, and any other that points at it. None: nothing shows. -->
    <div v-if="analytics.length" class="d-flex align-center flex-wrap ga-2 mb-4" data-testid="fixed-asset-analytic">
      <v-icon size="small">mdi-file-tree-outline</v-icon>
      <span class="text-body-2 text-medium-emphasis" :title="$t('accounting.fixedAssetBooks.analyticHint')">{{ $t('accounting.fixedAssetBooks.analytic') }}:</span>
      <entity-link v-for="a in analytics" :key="a._id" :label="a.path" :to="{ name: 'accounting.analytic', params: { id: a._id } }" />
    </div>

    <v-form ref="formRef" :disabled="asBooked" @submit.prevent="handleSubmit">
      <!-- Book -->
      <h2 class="text-subtitle-1 font-weight-bold mb-2 d-flex align-center ga-1">
        <v-icon v-if="asBooked" size="small">mdi-lock-outline</v-icon>
        {{ $t('accounting.fixedAssetBooks.book') }}
      </h2>
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.code"
            :label="$t('common.code')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.name"
            :label="$t('common.name')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.category"
            :label="$t('common.category')"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.purchaseDate"
            :label="$t('accounting.purchaseDate')"
            type="date"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.purchasePrice"
            :label="$t('accounting.purchasePrice')"
            type="number"
            :suffix="currency"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.salvageValue"
            :label="$t('accounting.salvageValue')"
            type="number"
            :suffix="currency"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.depreciationMethod"
            :label="$t('accounting.depreciationMethod')"
            :items="depreciationMethods"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.usefulLifeYears"
            :label="$t('accounting.usefulLife')"
            type="number"
            :suffix="$t('accounting.years')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <!-- The three accounts the model needs (#675): the asset, the depreciation expense, the accumulated depreciation. -->
        <v-col cols="12" md="4">
          <v-autocomplete
            v-model="form.accountId"
            :label="$t('accounting.assetAccount')"
            :items="accountOptions"
            item-title="label"
            item-value="_id"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-autocomplete
            v-model="form.depreciationAccountId"
            :label="$t('accounting.depreciationAccount')"
            :items="accountOptions"
            item-title="label"
            item-value="_id"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-autocomplete
            v-model="form.accumulatedDepAccountId"
            :label="$t('accounting.accumulatedDepAccount')"
            :items="accountOptions"
            item-title="label"
            item-value="_id"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.status"
            :label="$t('common.status')"
            :items="statusItems"
            density="compact"
            data-testid="fixed-asset-status"
          />
        </v-col>
        <!-- An asset of the books: the value its books start from, not today's (FR-25a §4.2), in the register's currency. -->
        <template v-if="asBooked">
          <v-col cols="12" md="4">
            <v-text-field
              :model-value="money(loaded?.currentValue)"
              :label="$t('accounting.fixedAssetBooks.openingValue')"
              :hint="$t('accounting.fixedAssetBooks.openingValueHint')"
              persistent-hint
              readonly
              density="compact"
              data-testid="fixed-asset-opening-value"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field :model-value="currency" :label="$t('accounting.fixedAssetBooks.currency')" readonly density="compact" data-testid="fixed-asset-currency" />
          </v-col>
        </template>
        <v-col v-if="disposalDay" cols="12" md="2">
          <v-text-field :model-value="disposalDay" :label="$t('accounting.fixedAssetBooks.disposalDate')" type="date" readonly density="compact" />
        </v-col>
      </v-row>

      <!-- Tax (ЗКПО): FR-25a §3.4, by the rules the route saves it by (`config/fixed-asset-tax.ts`). -->
      <h2 class="text-subtitle-1 font-weight-bold mt-4 mb-2 d-flex align-center ga-1">
        <v-icon v-if="asBooked" size="small">mdi-lock-outline</v-icon>
        {{ $t('accounting.fixedAssetBooks.tax.title') }}
      </h2>
      <v-row data-testid="fixed-asset-tax">
        <v-col cols="12" md="4">
          <v-select
            :model-value="form.taxCategory"
            :label="$t('accounting.fixedAssetBooks.tax.category')"
            :items="taxCategoryItems"
            :error-messages="taxError('taxCategory')"
            clearable
            density="compact"
            data-testid="fixed-asset-tax-category"
            @update:model-value="onCategoryChange"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.taxDepreciationRate"
            :label="$t('accounting.fixedAssetBooks.tax.rate')"
            type="number"
            suffix="%"
            :hint="rateHint"
            persistent-hint
            :error-messages="taxError('taxDepreciationRate')"
            density="compact"
            data-testid="fixed-asset-tax-rate"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.taxUsefulLifeMonths"
            :label="$t('accounting.fixedAssetBooks.tax.months')"
            type="number"
            :suffix="$t('accounting.fixedAssetBooks.tax.monthsUnit')"
            :hint="hints.years !== undefined ? $t('accounting.fixedAssetBooks.tax.inYears', { years: number(hints.years) }) : ''"
            persistent-hint
            :error-messages="taxError('taxUsefulLifeMonths')"
            density="compact"
            data-testid="fixed-asset-tax-months"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.taxValue"
            :label="$t('accounting.fixedAssetBooks.tax.value')"
            type="number"
            :suffix="currency"
            :hint="$t('accounting.fixedAssetBooks.tax.valueHint')"
            :error-messages="taxError('taxValue')"
            density="compact"
            data-testid="fixed-asset-tax-value"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.inServiceDate"
            :label="$t('accounting.fixedAssetBooks.tax.inServiceDate')"
            type="date"
            :error-messages="taxError('inServiceDate')"
            density="compact"
            data-testid="fixed-asset-in-service"
          />
        </v-col>
      </v-row>
      <!-- Hints, never refusals: the books always agree, and a person may have reasons. -->
      <v-alert v-if="hints.mismatch !== undefined" type="warning" variant="tonal" density="compact" class="mt-2" data-testid="fixed-asset-rate-term-mismatch">
        {{ $t('accounting.fixedAssetBooks.tax.mismatch', { product: number(hints.mismatch) }) }}
      </v-alert>
      <v-alert v-if="hints.aboveStatutory" type="warning" variant="tonal" density="compact" class="mt-2" data-testid="fixed-asset-above-statutory">
        {{ $t('accounting.fixedAssetBooks.tax.aboveStatutory', { rate: number(hints.statutoryRate) }) }}
      </v-alert>
    </v-form>

    <!-- Properties: the file's, read-only, in its order. Only an asset that has them (the books' do). -->
    <template v-if="isEdit && (asBooked || params.length)">
      <h2 class="text-subtitle-1 font-weight-bold mt-6 mb-1 d-flex align-center ga-1">
        <v-icon size="small">mdi-lock-outline</v-icon>
        {{ $t('accounting.fixedAssetBooks.properties') }}
      </h2>
      <div class="text-caption text-medium-emphasis mb-2">{{ $t('accounting.fixedAssetBooks.propertiesHint') }}</div>
      <div v-if="!params.length" class="text-body-2 text-medium-emphasis">{{ $t('accounting.fixedAssetBooks.noProperties') }}</div>
      <v-table v-else density="compact" data-testid="fixed-asset-properties">
        <thead>
          <tr>
            <th>{{ $t('accounting.fixedAssetBooks.property') }}</th>
            <th>{{ $t('accounting.fixedAssetBooks.value') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in params" :key="i">
            <td class="text-no-wrap">{{ p.key }}</td>
            <td>{{ p.value }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>

    <!-- Schedule -->
    <h2 class="text-subtitle-1 font-weight-bold mt-6 mb-2">{{ $t('accounting.fixedAssetBooks.schedule.title') }}</h2>

    <h3 class="text-subtitle-2 mb-1">{{ $t('accounting.fixedAssetBooks.schedule.book') }}</h3>
    <!-- What is stored: the rows a posting wrote, each with its entry. -->
    <v-table v-if="storedSchedule.length" density="compact" class="mb-4" data-testid="fixed-asset-book-schedule">
      <thead>
        <tr>
          <th>{{ $t('accounting.fixedAssetBooks.schedule.date') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.amount') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.accumulated') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.bookValue') }}</th>
          <th>{{ $t('accounting.fixedAssetBooks.schedule.entry') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in storedSchedule" :key="i">
          <td>{{ row.date }}</td>
          <td class="text-end">{{ money(row.amount) }}</td>
          <td class="text-end">{{ money(row.accumulatedAmount) }}</td>
          <td class="text-end">{{ money(row.bookValue) }}</td>
          <td>
            <entity-link v-if="row.journalEntryId" :label="$t('accounting.fixedAssetBooks.schedule.entry')" :to="{ name: 'accounting.journal-entry-edit', params: { id: row.journalEntryId } }" />
          </td>
        </tr>
      </tbody>
    </v-table>
    <!-- An asset of the books: its depreciation is posted by the books, and not linked here yet (FR-25a §4.2). -->
    <div v-else-if="asBooked" class="text-body-2 text-medium-emphasis mb-4" data-testid="fixed-asset-book-not-linked">
      {{ $t('accounting.fixedAssetBooks.schedule.notLinked') }}
    </div>
    <!-- An asset kept in LGR: the straight-line plan the form has always shown, a projection. -->
    <template v-else>
      <template v-if="plan.length">
        <div class="text-caption text-medium-emphasis mb-1">{{ $t('accounting.fixedAssetBooks.schedule.planned') }}</div>
        <v-table density="compact" class="mb-4" data-testid="fixed-asset-book-plan">
          <thead>
            <tr>
              <th>{{ $t('accounting.fixedAssetBooks.schedule.year') }}</th>
              <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.amount') }}</th>
              <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.accumulated') }}</th>
              <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.bookValue') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in plan" :key="row.year">
              <td>{{ row.year }}</td>
              <td class="text-end">{{ money(row.depreciation) }}</td>
              <td class="text-end">{{ money(row.accumulated) }}</td>
              <td class="text-end">{{ money(row.bookValue) }}</td>
            </tr>
          </tbody>
        </v-table>
      </template>
      <div v-else class="text-body-2 text-medium-emphasis mb-4">{{ $t('accounting.fixedAssetBooks.schedule.noBookPlan') }}</div>
    </template>

    <h3 class="text-subtitle-2 mb-1">{{ $t('accounting.fixedAssetBooks.schedule.tax') }}</h3>
    <div class="text-caption text-medium-emphasis mb-1">{{ $t('accounting.fixedAssetBooks.schedule.taxComputed') }}</div>
    <v-table v-if="taxRows.length" density="compact" data-testid="fixed-asset-tax-schedule">
      <thead>
        <tr>
          <th>{{ $t('accounting.fixedAssetBooks.schedule.year') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.months') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.amount') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.accumulated') }}</th>
          <th class="text-end">{{ $t('accounting.fixedAssetBooks.schedule.remaining') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in taxRows" :key="row.year">
          <td>{{ row.year }}</td>
          <td class="text-end">{{ row.months }}</td>
          <td class="text-end">{{ money(row.amount) }}</td>
          <td class="text-end">{{ money(row.accumulated) }}</td>
          <td class="text-end">{{ money(row.remaining) }}</td>
        </tr>
      </tbody>
    </v-table>
    <div v-else class="text-body-2 text-medium-emphasis">{{ $t('accounting.fixedAssetBooks.schedule.taxEmpty') }}</div>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="fixedAsset" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import EntityLink from 'ui-shared/components/EntityLink.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import { DEPRECIATION_METHODS, FIXED_ASSET_STATUSES, TAX_CATEGORIES, dayOf, taxSchedule, type TaxField } from 'config/fixed-asset-tax'
import { useAccountingStore } from '../../store/accounting.store'
import {
  analyticLinks, assetCurrency, bookPlan, emptyForm, formOf, isImportedAsset, payloadOf, rateAfterCategoryChange, refusalKey,
  statusLabelKey, taxErrorKey, taxFieldProblems, taxHints, taxValueAfterCategoryChange, type AnalyticLink, type FixedAssetForm,
} from './fixed-asset-form'

/**
 * FR-25a §3.4: one fixed asset. Book, Tax (ЗКПО), Properties and Schedule. An asset the books import made is as booked:
 * shown, never changed here (the server refuses it too). One kept in LGR saves its book and tax sides.
 */

interface StoredScheduleRow {
  date: string
  amount: number
  accumulatedAmount: number
  bookValue: number
  journalEntryId?: string
}

const { t, te } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)

/** The asset as the server answered it: what the form does not edit (its origin, properties, schedule, analytic). */
const loaded = ref<Record<string, any> | null>(null)
const asBooked = computed(() => isImportedAsset(loaded.value))
const pointing = ref<AnalyticLink[]>([])
const analytics = computed(() => (loaded.value ? analyticLinks(loaded.value, pointing.value) : []))
const params = computed<{ key: string; value: string }[]>(() => (loaded.value?.params ?? []) as { key: string; value: string }[])

const orgCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
/** The asset's own currency (an asset of the books written off before the euro is in lev); a new one's, the org's. */
const currency = computed(() => assetCurrency(loaded.value, orgCurrency.value))
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', bg: 'bg-BG', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})
const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? formatCurrency(n, currency.value, localeCode.value) : '')
const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(localeCode.value, { maximumFractionDigits: 2 }) : '')

// #675: the model's own values (`fixed-asset.model.ts`); the form sent `straight-line` and other names it rejects.
const depreciationMethods = computed(() => DEPRECIATION_METHODS.map(value => ({ value, title: t(`accounting.depreciationMethods.${value}`) })))
const statusItems = computed(() => FIXED_ASSET_STATUSES.map(value => ({ value, title: t(statusLabelKey(value)!) })))
const statusPipeline = computed(() => ({
  steps: FIXED_ASSET_STATUSES.map(s => statusLabelKey(s)!),
  current: statusLabelKey(form.value.status) ?? form.value.status,
}))
const taxCategoryItems = computed(() => TAX_CATEGORIES.map(c => ({
  value: c.code,
  title: `${c.roman} – ${t(`accounting.fixedAssetBooks.tax.categories.${c.code}`)}`,
})))

const store = useAccountingStore()
const accountOptions = computed(() => store.accounts.map((a: any) => ({ _id: a._id, label: `${a.code} - ${a.name}` })))

const form = ref<FixedAssetForm>(emptyForm())

const { markSaved, markClean, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'fixedAsset',
  icon: 'mdi-domain',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Code', value: form.value.code || '' },
    { label: 'Name', value: form.value.name || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

// ── The tax side ──
const problems = computed(() => (asBooked.value ? {} : taxFieldProblems(form.value)))
const hasTaxProblems = computed(() => Object.keys(problems.value).length > 0)
const hints = computed(() => taxHints(form.value))

function taxError(field: TaxField): string[] {
  const code = problems.value[field]
  return code ? [t(taxErrorKey(code))] : []
}

const rateHint = computed(() => {
  if (!form.value.taxCategory) return ''
  if (hints.value.statutoryRate !== undefined) return t('accounting.fixedAssetBooks.tax.statutoryRate', { rate: number(hints.value.statutoryRate) })
  return t('accounting.fixedAssetBooks.tax.limitedTermRate')
})

/** §3.4: a category's statutory rate is the default, and the purchase price the tax value's; a typed value stays. */
function onCategoryChange(next: string | null) {
  const f = form.value
  const category = next || null
  f.taxDepreciationRate = rateAfterCategoryChange(f.taxCategory, category, f.taxDepreciationRate, f.taxUsefulLifeMonths)
  if (category) f.taxValue = taxValueAfterCategoryChange(f.taxValue, f.purchasePrice)
  f.taxCategory = category
}

// ── The schedule ──
const disposalDay = computed(() => dayOf(loaded.value?.disposalDate) ?? '')
const storedSchedule = computed<StoredScheduleRow[]>(() => ((loaded.value?.depreciationSchedule ?? []) as any[]).map(r => ({
  date: dayOf(r.date) ?? '',
  amount: r.amount,
  accumulatedAmount: r.accumulatedAmount,
  bookValue: r.bookValue,
  ...(r.journalEntryId ? { journalEntryId: String(r.journalEntryId) } : {}),
})))
const plan = computed(() => bookPlan(form.value.purchasePrice, form.value.salvageValue, form.value.usefulLifeYears))
const taxRows = computed(() => taxSchedule({
  taxValue: form.value.taxValue,
  purchasePrice: form.value.purchasePrice,
  taxDepreciationRate: form.value.taxDepreciationRate,
  taxUsefulLifeMonths: form.value.taxUsefulLifeMonths,
  inServiceDate: form.value.inServiceDate,
  purchaseDate: form.value.purchaseDate,
  disposalDate: loaded.value?.disposalDate,
}))

const formActions = computed<FormAction[]>(() => [
  {
    label: t('common.save'),
    color: 'primary',
    handler: handleSubmit,
    cap: isEdit.value ? ['fixed-assets.create', 'fixed-assets.edit'] : 'fixed-assets.create',
    loading: loading.value,
    // FR-25a §3.4: an asset of the books is not saved here.
    show: !asBooked.value,
    disabled: hasTaxProblems.value,
  },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function refusal(e: any): string {
  const key = refusalKey(e?.response?.data)
  if (key && te(key)) return t(key)
  return e?.response?.data?.message || t('common.operationFailed')
}

async function handleSubmit() {
  if (asBooked.value) return
  const { valid } = await formRef.value.validate()
  if (!valid || hasTaxProblems.value) return

  loading.value = true
  try {
    const body = payloadOf(form.value, { isEdit: isEdit.value, currency: orgCurrency.value })
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/accounting/fixed-asset/${route.params.id}`, body)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/fixed-asset`, body)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.fixed-assets' })
  } catch (e: any) {
    showError(refusal(e))
  } finally {
    loading.value = false
  }
}

/** The analytics that point at this asset. A role that reads assets but not the chart's analytics sees the asset's own. */
async function loadAnalytics() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/analytics`, { params: { fixedAssetId: route.params.id, size: 5 } })
    pointing.value = ((data.analytics ?? []) as any[]).map(a => ({ _id: String(a._id), path: a.path }))
  } catch {
    pointing.value = []
  }
}

async function loadFixedAsset() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/fixed-asset/${route.params.id}`)
    const asset = data.fixedAsset || data
    loaded.value = asset
    form.value = formOf(asset)
    // What it shows now is the clean state: a slow answer is not an unsaved change.
    markClean()
    void loadAnalytics()
  } catch (e: any) {
    showError(refusal(e))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  void store.fetchAccounts()
  if (isEdit.value) await loadFixedAsset()
  // A person's unsaved edits, on top of what is stored: never on an asset of the books, which is not edited here.
  if (!asBooked.value) tryRestore()
})
</script>
