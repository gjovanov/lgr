<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('warehouse.category') : $t('common.create') + ' ' + $t('warehouse.category')"
    :subtitle="isEdit ? form.name : ''"
    :actions="formActions"
    :loading="loading"
    back-to="/categories"
    :back-label="$t('warehouse.categories')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" density="compact" />
      <v-textarea v-model="form.description" :label="$t('common.description')" rows="3" density="compact" />
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.icon" :label="$t('warehouse.categoryIcon')" placeholder="mdi-laptop" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.color" :label="$t('warehouse.categoryColor')" placeholder="#FF5733" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model.number="form.sortOrder" :label="$t('warehouse.sortOrder')" type="number" density="compact" />
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
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()

const emptyForm = () => ({ name: '', description: '', icon: '', color: '', sortOrder: 0 })
const form = ref(emptyForm())

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'category',
  icon: 'mdi-shape',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [{ label: 'Name', value: form.value.name }],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value },
])

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category/${route.params.id}`)
    const item = data.productCategory || data
    form.value = {
      name: item.name,
      description: item.description || '',
      icon: item.icon || '',
      color: item.color || '',
      sortOrder: item.sortOrder ?? 0,
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
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
      await httpClient.put(`${appStore.orgUrl()}/warehouse/product-category/${route.params.id}`, form.value)
    } else {
      const { data } = await httpClient.post(`${appStore.orgUrl()}/warehouse/product-category`, form.value)
      const newId = data.productCategory?._id || data._id
      if (newId) {
        markSaved()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'inventory.categories.edit', params: { id: newId } })
        return
      }
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  if (tryRestore()) return
  fetchItem()
})
</script>
