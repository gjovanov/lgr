<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('access.ui.title') }}</h1>
      <v-spacer />
      <responsive-btn v-if="roles.length" icon="mdi-plus" color="primary" data-testid="role-new" @click="openNew">
        {{ $t('access.ui.newRole') }}
      </responsive-btn>
    </div>

    <v-alert v-if="!loading && !roles.length" type="info" variant="tonal">
      {{ $t('access.ui.noRoles') }}
      <template #append>
        <v-btn variant="text" :to="{ name: 'settings.permissionSets' }" data-testid="roles-open-sets">{{ $t('permissionSets.title') }}</v-btn>
      </template>
    </v-alert>

    <v-data-table v-else :headers="headers" :items="roles" :loading="loading" item-value="id" hover data-testid="roles-table" @click:row="(_: any, { item }: any) => open(item)">
      <template #item.name="{ item }">
        <span class="font-weight-medium">{{ item.name }}</span>
        <v-chip v-if="item.all" color="error" size="small" class="ml-2">{{ $t('access.feature.roles') }}: *</v-chip>
        <v-chip v-else-if="item.isBuiltin" size="small" variant="outlined" class="ml-2">{{ $t('access.ui.builtin') }}</v-chip>
        <v-chip v-if="item.edited" size="small" color="info" variant="tonal" class="ml-1">{{ $t('access.ui.edited') }}</v-chip>
        <v-tooltip v-if="item.needsRelease" :text="$t('access.ui.needsReleaseHint')">
          <template #activator="{ props: tip }">
            <v-chip v-bind="tip" size="small" color="warning" variant="tonal" class="ml-1">{{ $t('access.ui.needsRelease') }}</v-chip>
          </template>
        </v-tooltip>
      </template>
      <template #item.description="{ item }">
        <span class="text-body-2 text-medium-emphasis">{{ describe(item) }}</span>
      </template>
    </v-data-table>

    <v-card v-if="roles.length" class="mt-6" variant="outlined">
      <v-card-text>
        <v-select
          v-model="defaultRoleId"
          :items="defaultOptions"
          item-title="title"
          item-value="value"
          :label="$t('access.ui.defaultRole')"
          density="comfortable"
          hide-details
          data-testid="role-default"
          @update:model-value="saveDefault"
        />
      </v-card-text>
    </v-card>

    <v-dialog v-model="newOpen" max-width="520">
      <v-card :title="$t('access.ui.newRole')">
        <v-card-text>
          <v-text-field v-model="draft.name" :label="$t('access.ui.name')" autofocus data-testid="role-new-name" />
          <v-text-field v-model="draft.description" :label="$t('access.ui.description')" />
          <v-radio-group v-model="draft.from" inline hide-details>
            <v-radio value="blank" :label="$t('access.ui.blank')" />
            <v-radio value="template" :label="$t('access.ui.fromTemplate')" />
            <v-radio value="role" :label="$t('access.ui.copyOf')" />
          </v-radio-group>
          <v-select v-if="draft.from === 'template'" v-model="draft.templateKey" :items="templateOptions" item-title="title" item-value="value" :label="$t('access.ui.fromTemplate')" class="mt-3" />
          <v-select v-if="draft.from === 'role'" v-model="draft.roleId" :items="roles.map(r => ({ title: r.name, value: r.id }))" item-title="title" item-value="value" :label="$t('access.ui.copyOf')" class="mt-3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="newOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" :disabled="!draft.name.trim()" data-testid="role-new-save" @click="create">{{ $t('common.create') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
/**
 * FR-27.4 (#529) — Settings → Roles & access: the org's roles, how many people each, and the role an invitation that
 * names none starts a person with. A role opens in the editor (`RoleEditorView`).
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ROLE_TEMPLATES } from 'config/access'
import { useAppStore } from '../../store/app.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const roles = ref<any[]>([])
const loading = ref(false)
const saving = ref(false)
const defaultRoleId = ref<string | null>(null)
const newOpen = ref(false)
const draft = reactive({ name: '', description: '', from: 'blank' as 'blank' | 'template' | 'role', templateKey: 'member', roleId: '' })

const headers = computed(() => [
  { title: t('access.ui.name'), key: 'name' },
  { title: t('access.ui.people'), key: 'people', width: 110 },
  { title: t('access.ui.description'), key: 'description', sortable: false },
])
const templateOptions = computed(() => ROLE_TEMPLATES.map(r => ({ title: r.name, value: r.key })))
const defaultOptions = computed(() => [
  { title: t('access.ui.defaultRoleNone'), value: null },
  ...roles.value.map(r => ({ title: r.name, value: r.id })),
])

/** A built-in role's one sentence in the person's language; a custom role's own description. */
function describe(role: any): string {
  return role.isBuiltin && role.templateKey && !role.edited ? t(`access.roles.${role.templateKey}.description`) : role.description ?? ''
}

async function load() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/roles`)
    roles.value = data.roles ?? []
    defaultRoleId.value = data.defaultRoleId ?? null
  } catch (e: any) {
    showError(e?.response?.data?.message ?? t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function open(role: any) {
  router.push({ name: 'settings.roles.edit', params: { id: role.id } })
}

function openNew() {
  Object.assign(draft, { name: '', description: '', from: 'blank', templateKey: 'member', roleId: '' })
  newOpen.value = true
}

async function create() {
  saving.value = true
  try {
    const from = draft.from === 'template' ? { templateKey: draft.templateKey } : draft.from === 'role' && draft.roleId ? { roleId: draft.roleId } : undefined
    const { data } = await httpClient.post(`${appStore.orgUrl()}/roles`, { name: draft.name.trim(), description: draft.description || undefined, ...(from ? { from } : { caps: [] }) })
    newOpen.value = false
    showSuccess(t('access.ui.saved'))
    open(data.role)
  } catch (e: any) {
    showError(e?.response?.data?.message ?? t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function saveDefault(roleId: string | null) {
  try {
    await httpClient.put(`${appStore.orgUrl()}/roles/default`, { roleId })
    showSuccess(t('access.ui.saved'))
  } catch (e: any) {
    showError(e?.response?.data?.message ?? t('common.operationFailed'))
    await load()
  }
}

onMounted(load)
</script>
