<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('settings.users') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <responsive-btn v-cap="'invites.manage'" icon="mdi-email-plus" variant="outlined" @click="inviteDialog = true">
          {{ $t('settings.inviteUser') }}
        </responsive-btn>
        <responsive-btn v-cap="'users.edit'" icon="mdi-plus" color="primary" @click="openDialog()">
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
      <!-- FR-27 P3-3 (#529): the person's role. Its legacy key is shown only where the role's name cannot be read (no `roles.view`). -->
      <template #item.role="{ item }">
        <v-chip v-if="item.roleId && roleName(item.roleId)" size="small" variant="outlined" data-testid="user-role">{{ roleName(item.roleId) }}</v-chip>
        <v-chip v-else size="small" variant="outlined">{{ roleLabel(item.role) }}</v-chip>
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
          <v-text-field v-if="!editing" v-model="form.password" :label="$t('auth.password')" type="password" :rules="[passwordRule]" class="mb-2" />
          <!-- The address already belongs to a person: an org admin never takes over their account (rule 2). -->
          <v-alert v-if="existingPerson" type="info" variant="tonal" density="compact" class="mb-4">
            {{ $t('settings.identityExists', { email: existingPerson }) }}
            <div class="mt-2">
              <v-btn size="small" color="primary" variant="tonal" :loading="inviting" @click="inviteInstead">
                {{ $t('settings.inviteInstead') }}
              </v-btn>
            </div>
          </v-alert>

          <!-- FR-27.4, P3-3 (#529): one Role select, what it is in a sentence, and what it lets the person do. -->
          <v-select
            v-model="form.roleId"
            :label="$t('access.ui.role')"
            :items="orgRoles.map(r => ({ title: r.name, value: r.id }))"
            item-title="title"
            item-value="value"
            :disabled="!canEditRole"
            :hint="roleHint"
            persistent-hint
            class="mb-2"
            data-testid="user-role-select"
          />
          <div v-if="selectedRole" class="text-body-2 mb-4" data-testid="user-role-summary">
            <div class="text-medium-emphasis mb-1">{{ describeRole(selectedRole) }}</div>
            <div><strong>{{ $t('access.ui.canCreate') }}:</strong> {{ roleSummary.canCreate }}</div>
            <div><strong>{{ $t('access.ui.readOnly') }}:</strong> {{ roleSummary.readOnly }}</div>
            <div><strong>{{ $t('access.ui.notVisible') }}:</strong> {{ roleSummary.notVisible }}</div>
            <div v-if="roleSummary.hiddenPrices"><strong>{{ $t('access.ui.pricesHidden') }}:</strong> {{ roleSummary.hiddenPrices }}</div>
          </div>

          <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" class="mt-4" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn v-cap="'users.edit'" color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
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
            v-model="inviteRoleId"
            :label="$t('access.ui.role')"
            :items="orgRoles.map(r => ({ title: r.name, value: r.id }))"
            item-title="title"
            item-value="value"
            data-testid="invite-role-select"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="inviteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="inviting" :disabled="!inviteEmail.trim()" @click="sendInvite">{{ $t('settings.sendInvite') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <InviteResultDialog :result="inviteResult" @close="inviteResult = null" />
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../store/settings.store'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import { jwtUserId, sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { grantOfViewer } from 'ui-shared/nav/page-registry'
import { can, grantOfRole, summarize } from 'config/access'
import InviteResultDialog, { type InviteResult } from './InviteResultDialog.vue'
import { inviteErrorText } from './invite-errors'

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
const inviteRoleId = ref<string>('')

/**
 * FR-27.4, P3-3 (#529): the org's roles, the one thing this screen gives a person. Read with `roles.view`; without it
 * the list is empty, the select offers nothing, and a new person or invite gets the org's default role.
 */
const orgRoles = ref<any[]>([])
/** The org's default role (FR-27.3), else its built-in Member: what a new person or an invite starts on. */
const defaultRoleId = ref('')
const roleName = (id: string) => orgRoles.value.find(r => r.id === String(id))?.name ?? ''
async function fetchRoles() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/roles`)
    orgRoles.value = data.roles || []
    defaultRoleId.value = data.defaultRoleId || orgRoles.value.find(r => r.templateKey === 'member')?.id || ''
    inviteRoleId.value = defaultRoleId.value
  } catch {
    orgRoles.value = []
  }
}
/** #510: what became of the last invitation: the link, and whether the email went out. */
const inviteResult = ref<InviteResult | null>(null)

/**
 * Multi-org sign-in, rule 2: the person being edited also works in another org, so their name,
 * email and password belong to them and the server refuses an admin's change (`identity_shared`).
 */
const editingMultiOrg = ref(false)
const identityLocked = computed(() => editing.value && editingMultiOrg.value)
/** Set when creating a user whose address already has an account: invite that person instead. */
const existingPerson = ref('')

/** Where a role's name cannot be read: the legacy key the person's role writes (display only, until P3-5). */
const roleLabel = (r: string) => (r && te(`settings.roles.${r}`) ? t(`settings.roles.${r}`) : r || '—')

// FR-27: what the server asks before it changes a person (`users.edit`), on the session's grant.
const isAdmin = computed(() => can(grantOfViewer(sessionViewer()), 'users.edit'))

/**
 * ⚠ An admin editing THEMSELVES cannot change their own role here. Demoting yourself, in an org with one admin,
 * locks the org out of every admin screen with no way back through the UI. The server refuses it too (`own_role`);
 * this only explains why.
 */
const isSelf = computed(() => {
  // The session's own id: `appStore.user` is filled by a sign-in in this tab only.
  const myId = jwtUserId()
  return !!form._id && !!myId && String(form._id) === String(myId)
})
const canEditRole = computed(() => isAdmin.value && !isSelf.value)

const roleHint = computed(() => {
  if (!isAdmin.value) return t('settings.roleAdminOnly')
  if (isSelf.value) return t('settings.roleSelfBlocked')
  return t('settings.roleChangeHint')
})

const headers = computed(() => [
  { title: t('common.name'), key: 'fullName' },
  { title: t('common.email'), key: 'email' },
  { title: t('auth.username'), key: 'username' },
  { title: t('settings.role'), key: 'role' },
  { title: t('common.active'), key: 'isActive' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

/**
 * ⚠ `isActive`, not `active`. The model field is `isActive` (user.model.ts) and so is the PUT
 * body schema — the form's `active` was never read by anything: the switch could not change
 * the flag and the Active column rendered every user as inactive.
 */
const emptyForm = () => ({
  _id: '', firstName: '', middleName: '', lastName: '', email: '', username: '',
  password: '', isActive: true, roleId: '' as string,
})

const form = reactive(emptyForm())

const selectedRole = computed(() => orgRoles.value.find(r => r.id === form.roleId))
/** A built-in role's one sentence in the person's language (FR-27.4: what ends „Sales" against „Seller"). */
const describeRole = (r: any) => (r.isBuiltin && r.templateKey && !r.edited ? t(`access.roles.${r.templateKey}.description`) : r.description ?? '')
const roleSummary = computed(() => {
  const r = selectedRole.value
  const s = summarize(r ? grantOfRole({ all: r.all, caps: r.caps }) : { caps: new Set() } as any)
  const names = (ids: string[]) => ids.map(id => t(`access.feature.${id}`)).join(', ') || '—'
  // FR-27.11.B: the prices it does not see, by the editor's names for them.
  const hiddenPrices = s.hiddenPrices.map(c => t(`access.action.${c.slice(c.indexOf('.') + 1).replace(/[:-]/g, '_')}`)).join(', ')
  return { canCreate: names(s.canCreate), readOnly: names(s.readOnly), notVisible: names(s.notVisible), hiddenPrices }
})

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
      isActive: item.isActive !== false,
      roleId: item.roleId ? String(item.roleId) : '',
    })
  } else {
    editing.value = false
    Object.assign(form, { ...emptyForm(), roleId: defaultRoleId.value })
  }
  dialog.value = true
}

/** S-09: the server's rule for every password a person sets (12), said before the request. */
const passwordRule = (v: string) => (v ?? '').length >= 12 || t('account.passwordRule')

async function save() {
  if (!editing.value && passwordRule(form.password) !== true) {
    showError(t('account.passwordRule'))
    return
  }
  saving.value = true
  existingPerson.value = ''
  try {
    const payload: Record<string, any> = {
      firstName: form.firstName,
      middleName: form.middleName || undefined,
      lastName: form.lastName,
      email: form.email,
      username: form.username,
    }
    // FR-27.3: the role alone; the server writes the legacy fields from it. Sent only when this admin may set it, so a
    // disabled select never round-trips a stale value.
    if (canEditRole.value && form.roleId) payload.roleId = form.roleId

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
    const data = await store.inviteUser(existingPerson.value, form.roleId || undefined)
    dialog.value = false
    inviteResult.value = { link: data.link, targetEmail: data.invite?.targetEmail, email: data.email }
  } catch (e: any) {
    showError(inviteErrorText(e, t))
  } finally {
    inviting.value = false
  }
}

async function sendInvite() {
  inviting.value = true
  try {
    const data = await store.inviteUser(inviteEmail.value.trim(), inviteRoleId.value || undefined)
    inviteDialog.value = false
    inviteEmail.value = ''
    inviteRoleId.value = defaultRoleId.value
    // #510: it used to say "Saved successfully" and nothing was sent. Now it says what happened.
    inviteResult.value = { link: data.link, targetEmail: data.invite?.targetEmail, email: data.email }
  } catch (e: any) {
    showError(inviteErrorText(e, t))
  } finally {
    inviting.value = false
  }
}

onMounted(() => {
  // FR-27 acceptance 4: the org's roles are `roles.view`'s (their route refuses anyone else). Without it the page
  // lists the people and does not ask: no 403 on load.
  if (!can(grantOfViewer(sessionViewer()), 'roles.view')) return
  fetchRoles()
})
</script>

