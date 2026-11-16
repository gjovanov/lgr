<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('nav.warehouses') : $t('common.create') + ' ' + $t('nav.warehouses')"
    :subtitle="isEdit ? form.name : ''"
    :actions="formActions"
    :loading="loading"
    :load-error="loadError"
    :refusal="refusal"
    @retry="fetchItem"
    @dismiss-refusal="dismissRefusal"
    back-to="/warehouses"
    :back-label="$t('nav.warehouses')"
  >
    <v-form ref="formRef" :disabled="!writes" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.code" :label="$t('common.code')" :rules="[rules.required]" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" density="compact" />
        </v-col>
      </v-row>
      <v-row>
        <v-col cols="12" md="6">
          <v-select v-model="form.type" :label="$t('common.type')" :items="['warehouse', 'store', 'production', 'transit']" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.manager" :label="$t('warehouse.manager')" density="compact" />
        </v-col>
      </v-row>

      <p class="text-subtitle-2 mt-4 mb-2">{{ $t('invoicing.address') }}</p>
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.address.street" :label="$t('invoicing.street')" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.address.city" :label="$t('invoicing.city')" density="compact" />
        </v-col>
      </v-row>
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.address.state" :label="$t('invoicing.state')" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.address.postalCode" :label="$t('invoicing.postalCode')" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.address.country" :label="$t('invoicing.country')" density="compact" />
        </v-col>
      </v-row>
      <v-row>
        <!-- Default and external exclude each other: the default warehouse is where documents book stock,
             and an external one books none. Whichever is on switches the other off. -->
        <v-col cols="12" md="6">
          <v-switch v-model="form.isDefault" :label="$t('warehouse.default')" :disabled="!writes || form.isExternal" color="primary" density="compact" data-testid="warehouse-default" />
        </v-col>
        <v-col cols="12" md="6">
          <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" density="compact" />
        </v-col>
      </v-row>
      <v-row>
        <v-col cols="12">
          <v-switch
            v-model="form.isExternal"
            :label="$t('warehouse.externalWarehouse')"
            :disabled="!writes || form.isDefault"
            :hint="form.isDefault ? $t('warehouse.externalNotDefault') : $t('warehouse.externalWarehouseHint')"
            persistent-hint
            color="primary"
            density="compact"
            data-testid="warehouse-external"
          />
        </v-col>
      </v-row>
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { writesInventory } from 'ui-shared/nav/page-registry'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
// FR-26.8.7: without `inventory.write` (a Seller) the page reads, and offers no New, Save or Delete.
const writes = writesInventory(sessionViewer())
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
// FR-31.6 / .8: a record that did not load says so; a refused action stays at the top of the form.
const { loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal } = useFormFeedback()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()

interface IAddress { street: string; city: string; state: string; postalCode: string; country: string }
const emptyAddress = (): IAddress => ({ street: '', city: '', state: '', postalCode: '', country: '' })
// `isExternal`: another site's warehouse, named here for transfers. It keeps no stock in this organization.
const emptyForm = () => ({ code: '', name: '', type: 'warehouse', manager: '', address: emptyAddress(), isDefault: false, isExternal: false, isActive: true })
const form = ref(emptyForm())

const { markSaved, markLoaded, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'warehouse',
  icon: 'mdi-warehouse',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Name', value: form.value.name },
    { label: 'Code', value: form.value.code || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const formActions = computed<FormAction[]>(() => !writes ? [] : [
  { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value },
])

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  loadStarted()
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse/${route.params.id}`)
    const item = data.warehouse || data
    const addr = item.address || emptyAddress()
    await markLoaded(() => {
      form.value = {
        code: item.code,
        name: item.name,
        type: item.type || 'warehouse',
        manager: item.manager || '',
        address: { street: addr.street || '', city: addr.city || '', state: addr.state || '', postalCode: addr.postalCode || '', country: addr.country || '' },
        isDefault: item.isDefault,
        isExternal: !!item.isExternal,
        isActive: item.isActive,
      }
    })
  } catch (e: any) {
    loadFailed(e)
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${appStore.orgUrl()}/warehouse/warehouse/${route.params.id}`, form.value)
    } else {
      const { data } = await httpClient.post(`${appStore.orgUrl()}/warehouse/warehouse`, form.value)
      const newId = data.warehouse?._id || data._id
      if (newId) {
        markSaved()
        succeeded()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'inventory.warehouses.edit', params: { id: newId } })
        return
      }
    }
    markSaved()
    succeeded()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    refused(saveFailure(e))
  } finally {
    saving.value = false
  }
}

/**
 * Why the save was refused. The refusals of the external flag (`config/external-warehouse`) are said
 * in the user's language; anything else says what the server said.
 */
function saveFailure(e: any): string {
  const body = e?.response?.data
  if (body?.code === 'warehouse_holds_stock') return t('warehouse.externalHoldsStock', { articles: body.articles })
  if (body?.code === 'warehouse_in_use') {
    const uses = Object.entries(body.uses || {}) as [string, number][]
    return t('warehouse.externalInUse', { uses: uses.map(([kind, n]) => t(`warehouse.inUse.${kind}`, { n }, n)).join(', ') })
  }
  if (body?.code === 'external_default') return t('warehouse.externalNotDefault')
  return body?.message || t('common.operationFailed')
}

onMounted(async () => {
  if (tryRestore()) return
  fetchItem()
})
</script>
