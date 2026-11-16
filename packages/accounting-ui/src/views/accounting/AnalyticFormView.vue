<template>
  <EntityFormShell
    :title="$t('accounting.analytics.one')"
    :subtitle="analytic?.path || ''"
    :actions="formActions"
    :loading="loading"
    back-to="/analytics"
    :back-label="$t('accounting.analytics.title')"
  >
    <v-alert
      v-if="asBooked"
      type="info"
      variant="tonal"
      density="compact"
      icon="mdi-lock-outline"
      class="mb-4"
      data-testid="analytic-as-booked"
    >
      {{ $t('accounting.analytics.asBooked') }}
    </v-alert>

    <template v-if="analytic">
      <!-- What it is: never edited here, in any org. -->
      <v-row dense>
        <v-col cols="12" md="6">
          <v-text-field :model-value="analytic.path" :label="$t('accounting.analytics.path')" readonly density="compact" prepend-inner-icon="mdi-lock-outline" data-testid="analytic-path" />
        </v-col>
        <v-col cols="12" sm="4" md="2">
          <v-text-field :model-value="rootTitle" :label="$t('accounting.analytics.root')" readonly density="compact" />
        </v-col>
        <v-col cols="12" sm="4" md="2">
          <v-text-field :model-value="$t(kindLabelKey(analytic.kind))" :label="$t('accounting.analytics.kind')" readonly density="compact" />
        </v-col>
        <v-col cols="12" sm="4" md="2">
          <v-text-field :model-value="analytic.unit || ''" :label="$t('accounting.analytics.unit')" readonly density="compact" />
        </v-col>
      </v-row>
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <template v-if="analytic.ancestors.length">
          <span class="text-body-2 text-medium-emphasis">{{ $t('accounting.analytics.above') }}:</span>
          <template v-for="(a, i) in analytic.ancestors" :key="a._id">
            <v-icon v-if="i" size="x-small">mdi-chevron-right</v-icon>
            <entity-link :label="a.name" :to="{ name: 'accounting.analytic', params: { id: a._id } }" />
          </template>
        </template>
        <v-chip v-if="!analytic.isActive" size="small" color="grey" data-testid="analytic-inactive">{{ $t('common.inactive') }}</v-chip>
      </div>

      <!-- Links -->
      <h2 class="text-subtitle-1 font-weight-bold mt-4 mb-2">{{ $t('accounting.analytics.links') }}</h2>
      <v-row v-if="editable" dense>
        <v-col cols="12" md="4">
          <div class="d-flex align-center">
            <v-autocomplete
              v-model="form.contactId"
              :items="contacts.contacts.value"
              :item-title="contactTitle"
              item-value="_id"
              :label="$t('accounting.analytics.contact')"
              :loading="contacts.loading.value"
              no-filter
              clearable
              density="compact"
              data-testid="analytic-contact"
              @update:search="onContactSearch"
            />
            <v-btn v-if="form.contactId" icon="mdi-open-in-new" size="small" variant="text" :to="contactPath(form.contactId)" :title="$t('accounting.analytics.open')" :aria-label="$t('accounting.analytics.open')" />
          </div>
        </v-col>
        <v-col cols="12" md="4">
          <div class="d-flex align-center">
            <v-autocomplete
              v-model="form.bankAccountId"
              :items="bankOptions"
              item-title="title"
              item-value="value"
              :label="$t('accounting.analytics.bankAccount')"
              clearable
              density="compact"
            />
            <v-btn v-if="form.bankAccountId" icon="mdi-open-in-new" size="small" variant="text" :to="{ name: 'accounting.bank-account-edit', params: { id: form.bankAccountId } }" :title="$t('accounting.analytics.open')" :aria-label="$t('accounting.analytics.open')" />
          </div>
        </v-col>
        <v-col cols="12" md="4">
          <div class="d-flex align-center">
            <v-autocomplete
              v-model="form.fixedAssetId"
              :items="assetOptions"
              item-title="title"
              item-value="value"
              :label="$t('accounting.analytics.fixedAsset')"
              clearable
              density="compact"
            />
            <v-btn v-if="form.fixedAssetId" icon="mdi-open-in-new" size="small" variant="text" :to="{ name: 'accounting.fixed-asset-edit', params: { id: form.fixedAssetId } }" :title="$t('accounting.analytics.open')" :aria-label="$t('accounting.analytics.open')" />
          </div>
        </v-col>
      </v-row>
      <template v-else>
        <div v-if="!hasLinks" class="text-body-2 text-medium-emphasis">{{ $t('accounting.analytics.noLinks') }}</div>
        <v-list v-else density="compact" class="py-0" data-testid="analytic-links">
          <v-list-item v-if="analytic.contactId" prepend-icon="mdi-account-outline" :subtitle="$t('accounting.analytics.contact')">
            <entity-link :label="analytic.contactName || analytic.contactId" :to="contactPath(analytic.contactId)" />
          </v-list-item>
          <v-list-item v-if="analytic.bankAccountId" prepend-icon="mdi-bank-outline" :subtitle="$t('accounting.analytics.bankAccount')">
            <entity-link :label="analytic.bankAccountName || analytic.bankAccountId" :to="{ name: 'accounting.bank-account-edit', params: { id: analytic.bankAccountId } }" />
          </v-list-item>
          <v-list-item v-if="analytic.fixedAssetId" prepend-icon="mdi-office-building-outline" :subtitle="$t('accounting.analytics.fixedAsset')">
            <entity-link :label="analytic.fixedAssetName || analytic.fixedAssetId" :to="{ name: 'accounting.fixed-asset-edit', params: { id: analytic.fixedAssetId } }" />
          </v-list-item>
        </v-list>
      </template>

      <!-- Properties: the file's, read-only, for the books' analytic; a person's own for LGR's. -->
      <h2 class="text-subtitle-1 font-weight-bold mt-6 mb-1">{{ $t('accounting.analytics.properties') }}</h2>
      <template v-if="!editable">
        <div class="text-caption text-medium-emphasis mb-2">{{ $t('accounting.analytics.propertiesHint') }}</div>
        <div v-if="!analytic.params.length" class="text-body-2 text-medium-emphasis">{{ $t('accounting.analytics.noProperties') }}</div>
        <v-table v-else density="compact" data-testid="analytic-properties">
          <thead>
            <tr>
              <th>{{ $t('accounting.analytics.key') }}</th>
              <th>{{ $t('accounting.analytics.value') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in analytic.params" :key="i">
              <td class="text-no-wrap">{{ p.key }}</td>
              <td>{{ p.value }}</td>
            </tr>
          </tbody>
        </v-table>
      </template>
      <template v-else>
        <div v-if="!form.params.length" class="text-body-2 text-medium-emphasis mb-2">{{ $t('accounting.analytics.noProperties') }}</div>
        <v-row v-for="(p, i) in form.params" :key="i" dense align="start" data-testid="analytic-property-row">
          <v-col cols="12" sm="5">
            <v-text-field
              v-model="p.key"
              :label="$t('accounting.analytics.key')"
              :error-messages="paramErrorText(i)"
              density="compact"
              maxlength="200"
            />
          </v-col>
          <v-col cols="10" sm="6">
            <v-text-field v-model="p.value" :label="$t('accounting.analytics.value')" density="compact" maxlength="2000" />
          </v-col>
          <v-col cols="2" sm="1">
            <v-btn icon="mdi-delete-outline" size="small" variant="text" color="error" :title="$t('accounting.analytics.removeProperty')" :aria-label="$t('accounting.analytics.removeProperty')" @click="form.params.splice(i, 1)" />
          </v-col>
        </v-row>
        <v-btn variant="text" prepend-icon="mdi-plus" size="small" data-testid="analytic-add-property" @click="form.params.push({ key: '', value: '' })">
          {{ $t('accounting.analytics.addProperty') }}
        </v-btn>
      </template>
    </template>

    <v-dialog v-model="deactivateDialog" max-width="440">
      <v-card>
        <v-card-title>{{ $t('accounting.analytics.deactivate') }}</v-card-title>
        <v-card-text>{{ $t('accounting.analytics.deactivateConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deactivateDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="saving" data-testid="analytic-deactivate-confirm" @click="deactivate">{{ $t('accounting.analytics.deactivate') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { contactTitle, useContactSearch } from 'ui-shared/composables/useContactSearch'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityLink from 'ui-shared/components/EntityLink.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import {
  analyticErrorKey,
  kindLabelKey,
  linkPayload,
  paramErrors,
  paramsPayload,
  rootLabelKey,
  type AnalyticRootInfo,
  type ParamRow,
} from './books-chart'

/**
 * FR-25a §3.2: one analytic. What it is (path, root, kind) is never edited here. An analytic of the books is shown as
 * booked, its properties in the file's order; one of LGR's own takes its links and a person's properties, and may be
 * deactivated (never deleted: lines name it).
 */

interface AnalyticDetail {
  _id: string
  path: string
  root: string
  name: string
  kind: string
  unit?: string
  contactId?: string
  contactName?: string
  bankAccountId?: string
  bankAccountName?: string
  fixedAssetId?: string
  fixedAssetName?: string
  isActive: boolean
  params: ParamRow[]
  ancestors: { _id: string; path: string; name: string }[]
}

const { t, te } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const loading = ref(false)
const saving = ref(false)
const analytic = ref<AnalyticDetail | null>(null)
const asBooked = ref(false)
const roots = ref<AnalyticRootInfo[]>([])
const deactivateDialog = ref(false)
const form = ref<{ contactId: string | null; bankAccountId: string | null; fixedAssetId: string | null; params: ParamRow[] }>({
  contactId: null,
  bankAccountId: null,
  fixedAssetId: null,
  params: [],
})
const bankOptions = ref<{ title: string; value: string }[]>([])
const assetOptions = ref<{ title: string; value: string }[]>([])

/** Only an analytic of LGR's own is changed here; the server refuses the books' (422). */
const editable = computed(() => !!analytic.value && !asBooked.value)
const url = computed(() => `${appStore.orgUrl()}/accounting/analytics/${route.params.id}`)

const contacts = useContactSearch({
  orgUrl: () => appStore.orgUrl(),
  selected: () => [form.value.contactId],
  sortBy: 'companyName',
})

const rootTitle = computed(() => {
  if (!analytic.value) return ''
  const key = rootLabelKey(analytic.value.root, roots.value)
  return key ? t(key) : analytic.value.root
})

const hasLinks = computed(() => !!(analytic.value?.contactId || analytic.value?.bankAccountId || analytic.value?.fixedAssetId))
const paramErrs = computed(() => paramErrors(form.value.params))

function paramErrorText(i: number): string[] {
  const err = paramErrs.value[i]
  return err ? [t(`accounting.analytics.${err}`)] : []
}

const contactPath = (id: string) => `/invoicing/contacts/${id}/edit`

const formActions = computed<FormAction[]>(() => [
  {
    label: t('common.save'),
    color: 'primary',
    handler: save,
    cap: 'accounts.edit',
    show: editable.value,
    loading: saving.value,
    disabled: paramErrs.value.some(Boolean),
  },
  {
    label: t('accounting.analytics.deactivate'),
    color: 'error',
    variant: 'outlined',
    icon: 'mdi-cancel',
    handler: () => { deactivateDialog.value = true },
    cap: 'accounts.edit',
    show: editable.value && !!analytic.value?.isActive,
  },
  {
    label: t('accounting.analytics.activate'),
    color: 'primary',
    variant: 'outlined',
    icon: 'mdi-check',
    handler: activate,
    cap: 'accounts.edit',
    show: editable.value && analytic.value?.isActive === false,
    loading: saving.value,
  },
])

function refusal(e: any): string {
  const key = analyticErrorKey(e?.response?.data?.code)
  if (key && te(key)) return t(key)
  return e?.response?.data?.message || t('common.operationFailed')
}

function apply(data: { analytic: AnalyticDetail; asBooked?: boolean }) {
  analytic.value = data.analytic
  if (data.asBooked !== undefined) asBooked.value = !!data.asBooked
  form.value = {
    contactId: data.analytic.contactId ?? null,
    bankAccountId: data.analytic.bankAccountId ?? null,
    fixedAssetId: data.analytic.fixedAssetId ?? null,
    params: data.analytic.params.map(p => ({ key: p.key, value: p.value })),
  }
}

async function loadChoices() {
  // What a person may link: the bank accounts and fixed assets of the org, and the contacts as searched.
  const [banks, assets] = await Promise.all([
    httpClient.get(`${appStore.orgUrl()}/accounting/bank-account`, { params: { size: 0, sortBy: 'name', sortOrder: 'asc' } }).catch(() => null),
    httpClient.get(`${appStore.orgUrl()}/accounting/fixed-asset`, { params: { size: 0, sortBy: 'name', sortOrder: 'asc' } }).catch(() => null),
  ])
  bankOptions.value = ((banks?.data?.bankAccounts ?? []) as any[]).map(b => ({ title: b.iban && b.iban !== b.name ? `${b.name} (${b.iban})` : b.name, value: String(b._id ?? b.id) }))
  assetOptions.value = ((assets?.data?.fixedAssets ?? []) as any[]).map(a => ({ title: [a.code, a.name].filter(Boolean).join(' - '), value: String(a._id ?? a.id) }))
  await Promise.all([contacts.ensureSelected(), contacts.search('')])
}

async function load() {
  loading.value = true
  try {
    const [{ data }, rootsAnswer] = await Promise.all([
      httpClient.get(url.value),
      httpClient.get(`${appStore.orgUrl()}/accounting/analytics/roots`).catch(() => null),
    ])
    roots.value = rootsAnswer?.data?.roots ?? []
    apply(data)
    if (editable.value) await loadChoices()
  } catch (e: any) {
    showError(refusal(e))
  } finally {
    loading.value = false
  }
}

function onContactSearch(text: string | null) {
  const chosen = contacts.contacts.value.find(c => c._id === form.value.contactId)
  if (chosen && text === contactTitle(chosen)) return
  contacts.onSearch(text)
}

async function save() {
  if (paramErrs.value.some(Boolean)) return
  saving.value = true
  try {
    const { data } = await httpClient.put(url.value, {
      contactId: linkPayload(form.value.contactId),
      bankAccountId: linkPayload(form.value.bankAccountId),
      fixedAssetId: linkPayload(form.value.fixedAssetId),
      params: paramsPayload(form.value.params),
    })
    apply(data)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(refusal(e))
  } finally {
    saving.value = false
  }
}

async function deactivate() {
  saving.value = true
  try {
    const { data } = await httpClient.delete(url.value)
    apply(data)
    deactivateDialog.value = false
    showSuccess(t('accounting.analytics.deactivated'))
  } catch (e: any) {
    showError(refusal(e))
  } finally {
    saving.value = false
  }
}

async function activate() {
  saving.value = true
  try {
    const { data } = await httpClient.put(url.value, { isActive: true })
    apply(data)
    showSuccess(t('accounting.analytics.activated'))
  } catch (e: any) {
    showError(refusal(e))
  } finally {
    saving.value = false
  }
}

// Opening an analytic above this one (its breadcrumb) reuses this view.
watch(() => route.params.id, (id, previous) => {
  if (id && id !== previous) void load()
})

onMounted(load)
</script>
