<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('settings.users') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <responsive-btn icon="mdi-email-plus" variant="outlined" @click="inviteDialog = true">
          {{ $t('settings.inviteUser') }}
        </responsive-btn>
        <responsive-btn icon="mdi-plus" color="primary" @click="openDialog()">
          {{ $t('common.create') }}
        </responsive-btn>
      </div>
    </div>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      @update:options="onUpdateOptions"
      item-value="_id"
      hover
    >
      <!-- Multi-org sign-in: a person who also works in another org. Their name, email and
           password are theirs, not this org's, so the edit dialog locks those fields. -->
      <template #item.email="{ item }">
        {{ item.email }}
        <v-tooltip v-if="item.multiOrg" :text="$t('settings.multiOrgBadge')" location="top">
          <template #activator="{ props: tip }">
            <v-icon v-bind="tip" size="x-small" class="ml-1" color="primary">mdi-domain</v-icon>
          </template>
        </v-tooltip>
      </template>
      <template #item.isActive="{ item }">
        <v-chip :color="item.isActive ? 'success' : 'grey'" size="small">
          {{ item.isActive ? $t('common.active') : $t('common.inactive') }}
        </v-chip>
      </template>
      <template #item.role="{ item }">
        <v-chip :color="roleColor(item.role)" size="small" variant="outlined">{{ roleLabel(item.role) }}</v-chip>
      </template>
      <template #item.permissionSets="{ item }">
        <template v-if="item.permissionSetIds?.length">
          <v-chip
            v-for="setId in item.permissionSetIds"
            :key="setId"
            size="small"
            class="mr-1"
            variant="tonal"
          >{{ permissionSetName(setId) }}</v-chip>
        </template>
        <span v-else class="text-grey text-caption">{{ $t('common.none') }}</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
      </template>
    </v-data-table-server>

    <!-- Create/Edit User Dialog -->
    <v-dialog v-model="dialog" max-width="700" persistent scrollable>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('settings.user') }}</v-card-title>
        <v-card-text>
          <v-alert v-if="identityLocked" type="info" variant="tonal" density="compact" class="mb-4">
            {{ $t('settings.multiOrgHint') }}
          </v-alert>
          <v-row>
            <v-col cols="4"><v-text-field v-model="form.firstName" :label="$t('common.firstName')" :disabled="identityLocked" /></v-col>
            <v-col cols="4"><v-text-field v-model="form.middleName" :label="$t('common.middleName')" :disabled="identityLocked" /></v-col>
            <v-col cols="4"><v-text-field v-model="form.lastName" :label="$t('common.lastName')" :disabled="identityLocked" /></v-col>
          </v-row>
          <v-text-field v-model="form.email" :label="$t('common.email')" type="email" class="mb-2" :disabled="identityLocked" />
          <v-text-field v-model="form.username" :label="$t('auth.username')" class="mb-2" />
          <v-text-field v-if="!editing" v-model="form.password" :label="$t('auth.password')" type="password" class="mb-2" />
          <!-- The address already belongs to a person: an org admin never takes over their account (rule 2). -->
          <v-alert v-if="existingPerson" type="info" variant="tonal" density="compact" class="mb-4">
            {{ $t('settings.identityExists', { email: existingPerson }) }}
            <div class="mt-2">
              <v-btn size="small" color="primary" variant="tonal" :loading="inviting" @click="inviteInstead">
                {{ $t('settings.inviteInstead') }}
              </v-btn>
            </div>
          </v-alert>

          <!--
            The role IS the primary authorization control — `user.role` is what every admin
            gate, the tenant guard and the report gates read — so an org admin has to be able
            to set it. It was rendered `disabled` and fed capitalised labels ("Viewer") that
            match no value the API accepts, which made the field doubly dead.
          -->
          <v-select
            v-model="form.role"
            :label="$t('settings.role')"
            :items="roleItems"
            item-title="title"
            item-value="value"
            :disabled="!canEditRole"
            :hint="roleHint"
            persistent-hint
            class="mb-2"
          />

          <v-autocomplete
            v-model="form.permissionSetIds"
            :items="permissionSets"
            item-title="name"
            item-value="_id"
            :label="$t('permissionSets.title')"
            multiple
            chips
            closable-chips
            class="mb-2"
          />

          <!-- Effective Permissions (read-only) -->
          <div v-if="editing && form.permissionSetIds?.length" class="mb-4">
            <div class="text-subtitle-2 mb-1">{{ $t('permissionSets.effectivePermissions') }}</div>
            <v-chip
              v-for="perm in effectivePermissions"
              :key="perm"
              size="x-small"
              class="mr-1 mb-1"
              variant="outlined"
            >{{ perm }}</v-chip>
            <div v-if="!effectivePermissions.length" class="text-grey text-caption">{{ $t('common.loading') }}...</div>
          </div>

          <div class="text-subtitle-2 mb-2">{{ $t('settings.permissions') }} (Legacy)</div>
          <v-row>
            <v-col v-for="perm in availablePermissions" :key="perm" cols="12" sm="6" md="4">
              <v-checkbox v-model="form.permissions" :value="perm" :label="perm" density="compact" hide-details />
            </v-col>
          </v-row>

          <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" class="mt-4" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Invite User Dialog -->
    <v-dialog v-model="inviteDialog" max-width="400" persistent>
      <v-card>
        <v-card-title>{{ $t('settings.inviteUser') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="inviteEmail" :label="$t('common.email')" type="email" class="mb-2" />
          <v-select
            v-model="inviteRole"
            :label="$t('settings.role')"
            :items="roleItems"
            item-title="title"
            item-value="value"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="inviteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="inviting" @click="sendInvite">{{ $t('settings.sendInvite') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../store/settings.store'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import { PERMISSIONS, ROLES, type Role } from 'config/constants'

const { t, te } = useI18n()
const store = useSettingsStore()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/user`),
  entityKey: 'users',
})

const dialog = ref(false)
const inviteDialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const inviting = ref(false)
const inviteEmail = ref('')
const inviteRole = ref<Role>('member')

/**
 * Multi-org sign-in, rule 2: the person being edited also works in another org, so their name,
 * email and password belong to them and the server refuses an admin's change (`identity_shared`).
 */
const editingMultiOrg = ref(false)
const identityLocked = computed(() => editing.value && editingMultiOrg.value)
/** Set when creating a user whose address already has an account: invite that person instead. */
const existingPerson = ref('')

const permissionSets = ref<any[]>([])
const effectivePermissions = ref<string[]>([])

/**
 * ⚠ The single source of roles is `config/constants` — the same list the API validates
 * against and the same one `DEFAULT_ROLE_PERMISSIONS` is keyed by. This view used to carry
 * its own hardcoded `['Admin', 'Manager', ..., 'Viewer']`, and not one of those strings is a
 * value the server accepts: submitting any of them is a 422. So even once the select was
 * enabled it could not have saved.
 */
const roleItems = computed(() => ROLES.map(r => ({ value: r, title: t(`settings.roles.${r}`) })))
const roleLabel = (r: string) => (te(`settings.roles.${r}`) ? t(`settings.roles.${r}`) : r)

/** Only an admin may change a role — the API answers 403 to everyone else (user.controller PUT). */
const isAdmin = computed(() => appStore.user?.role === 'admin')

/**
 * ⚠ An admin editing THEMSELVES cannot change their own role here. Demoting yourself takes
 * effect on your next token and, in an org with one admin, locks the org out of every admin
 * screen with no way back through the UI. The server refuses it too; this only explains why.
 */
const isSelf = computed(() => {
  const me = appStore.user
  // `/auth/me` has spelled this both ways over time; the server enforces the rule regardless.
  const myId = me?.id || me?._id
  return !!form._id && !!myId && String(form._id) === String(myId)
})
const canEditRole = computed(() => isAdmin.value && !isSelf.value)

const roleHint = computed(() => {
  if (!isAdmin.value) return t('settings.roleAdminOnly')
  if (isSelf.value) return t('settings.roleSelfBlocked')
  // Changing the role REPLACES `permissions` with that role's defaults (server-side), and the
  // JWT already issued keeps the old set until the user signs in again.
  return t('settings.roleChangeHint')
})
// The permissions the server knows. The list this replaced offered `trade.*` and names nothing
// checks any more (hr, crm, erp, settings, admin.read/write): granting one did nothing.
const availablePermissions = PERMISSIONS

const headers = [
  { title: t('common.name'), key: 'fullName' },
  { title: t('common.email'), key: 'email' },
  { title: t('auth.username'), key: 'username' },
  { title: t('settings.role'), key: 'role' },
  { title: t('permissionSets.title'), key: 'permissionSets', sortable: false },
  { title: t('common.active'), key: 'isActive' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

/**
 * ⚠ `isActive`, not `active`. The model field is `isActive` (user.model.ts) and so is the PUT
 * body schema — the form's `active` was never read by anything: the switch could not change
 * the flag and the Active column rendered every user as inactive.
 */
const emptyForm = () => ({
  _id: '', firstName: '', middleName: '', lastName: '', email: '', username: '',
  password: '', role: 'member' as Role, permissions: [] as string[], permissionSetIds: [] as string[], isActive: true,
})

const form = reactive(emptyForm())

function permissionSetName(id: string): string {
  const found = permissionSets.value.find(s => s._id === id)
  return found?.name || id
}

async function fetchPermissionSets() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/permission-sets`)
    permissionSets.value = data.permissionSets || []
  } catch {
    // non-critical
  }
}

async function fetchEffectivePermissions(userId: string) {
  if (!userId) { effectivePermissions.value = []; return }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/permission-sets/effective/${userId}`)
    effectivePermissions.value = data.permissions || []
  } catch {
    effectivePermissions.value = []
  }
}

// Watch for permissionSetIds changes in the form to refresh effective permissions
watch(() => form.permissionSetIds, () => {
  if (editing.value && form._id) {
    // We re-fetch from server on the saved state; for UI preview we compute locally
    const selected = permissionSets.value.filter(s => form.permissionSetIds.includes(s._id))
    const perms = new Set<string>()
    for (const s of selected) {
      for (const p of (s.permissions || [])) perms.add(p)
    }
    effectivePermissions.value = [...perms].sort()
  }
}, { deep: true })

function openDialog(item?: any) {
  existingPerson.value = ''
  editingMultiOrg.value = !!item?.multiOrg
  if (item) {
    editing.value = true
    // Only the fields the form owns. The row also carries `roleHistory`, `operatorCode` and
    // friends; copying those in meant `save()` posted them straight back.
    Object.assign(form, {
      ...emptyForm(),
      _id: item._id,
      firstName: item.firstName || '',
      middleName: item.middleName || '',
      lastName: item.lastName || '',
      email: item.email || '',
      username: item.username || '',
      role: item.role || 'member',
      isActive: item.isActive !== false,
      permissions: [...(item.permissions || [])],
      permissionSetIds: [...(item.permissionSetIds || [])],
    })
    if (item._id) fetchEffectivePermissions(item._id)
  } else {
    editing.value = false
    Object.assign(form, emptyForm())
    effectivePermissions.value = []
  }
  dialog.value = true
}

async function save() {
  saving.value = true
  existingPerson.value = ''
  try {
    const payload: Record<string, any> = {
      firstName: form.firstName,
      middleName: form.middleName || undefined,
      lastName: form.lastName,
      email: form.email,
      username: form.username,
      permissions: form.permissions,
      permissionSetIds: form.permissionSetIds,
    }
    // Sent only when this admin is actually allowed to set it, so a disabled select can
    // never round-trip a stale value back over the stored role.
    if (canEditRole.value) payload.role = form.role

    if (editing.value) {
      payload.isActive = form.isActive
      await store.updateUser(form._id, payload)
    } else {
      payload.password = form.password
      await store.createUser(payload)
    }
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
    await fetchItems()
  } catch (e: any) {
    if (!editing.value && e?.response?.data?.code === 'identity_exists') existingPerson.value = form.email
    else showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

/** Invite the person who already has this address, with the role chosen in the form. */
async function inviteInstead() {
  inviting.value = true
  try {
    await store.inviteUser(existingPerson.value, form.role)
    showSuccess(t('settings.inviteSent'))
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    inviting.value = false
  }
}

async function sendInvite() {
  inviting.value = true
  try {
    await store.inviteUser(inviteEmail.value, inviteRole.value)
    showSuccess(t('common.savedSuccessfully'))
    inviteDialog.value = false
    inviteEmail.value = ''
    inviteRole.value = 'member'
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    inviting.value = false
  }
}

function roleColor(role: string) {
  const colors: Record<string, string> = {
    admin: 'error',
    manager: 'warning',
    accountant: 'info',
    warehouse_manager: 'success',
    member: 'grey',
    nra_auditor: 'purple',
  }
  return colors[role] || 'grey'
}

onMounted(() => {
  fetchPermissionSets()
})
</script>
