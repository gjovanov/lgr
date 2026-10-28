<template>
  <v-menu v-model="open" :close-on-content-click="false" location="bottom start">
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        :icon="mobile"
        variant="text"
        class="org-switcher text-none mr-2"
        data-testid="org-switcher"
        :aria-label="$t('orgSwitcher.label', { org: org?.name ?? '' })"
      >
        <v-icon :start="!mobile">mdi-domain</v-icon>
        <template v-if="!mobile">
          <span class="org-switcher__name">{{ org?.name }}</span>
          <v-icon end size="small">mdi-chevron-down</v-icon>
        </template>
      </v-btn>
    </template>

    <v-card min-width="300" max-width="400">
      <v-list density="compact" nav>
        <v-list-subheader>{{ $t('orgSwitcher.title') }}</v-list-subheader>
        <div v-if="loading" class="d-flex justify-center py-3">
          <v-progress-circular indeterminate size="24" />
        </div>
        <v-list-item
          v-for="o in orgs"
          :key="o.orgId"
          :active="o.current"
          color="primary"
          :disabled="!!busy"
          data-testid="org-switcher-org"
          @click="choose(o)"
        >
          <template #prepend>
            <span class="org-initials mr-3">{{ initials(o.name) }}</span>
          </template>
          <v-list-item-title>{{ o.name }}</v-list-item-title>
          <v-list-item-subtitle>{{ o.slug }} · {{ roleLabel(o.role) }}</v-list-item-subtitle>
          <template #append>
            <v-progress-circular v-if="busy === o.orgId" indeterminate size="16" width="2" />
            <v-icon v-else-if="o.current" size="small">mdi-check</v-icon>
          </template>
        </v-list-item>

        <template v-if="invitations.length">
          <v-divider class="my-1" />
          <v-list-subheader>{{ $t('orgSwitcher.invitations') }}</v-list-subheader>
          <v-list-item v-for="i in invitations" :key="i.code" :disabled="!!busy && busy !== i.code">
            <template #prepend>
              <span class="org-initials org-initials--invite mr-3">{{ initials(i.name) }}</span>
            </template>
            <v-list-item-title>{{ i.name }}</v-list-item-title>
            <v-list-item-subtitle>{{ roleLabel(i.role) }}</v-list-item-subtitle>
            <template #append>
              <v-btn size="small" variant="tonal" color="primary" :loading="busy === i.code" @click.stop="join(i)">
                {{ $t('orgSwitcher.join') }}
              </v-btn>
            </template>
          </v-list-item>
        </template>

        <v-divider class="my-1" />
        <v-list-item :title="$t('orgSwitcher.newOrg')" :disabled="!!busy" @click="openNewOrg">
          <template #prepend>
            <span class="org-initials org-initials--action mr-3"><v-icon size="20">mdi-plus</v-icon></span>
          </template>
        </v-list-item>
        <v-list-item :title="$t('orgSwitcher.allOrgs')" :href="allOrgsHref">
          <template #prepend>
            <span class="org-initials org-initials--action mr-3"><v-icon size="20">mdi-view-grid-outline</v-icon></span>
          </template>
        </v-list-item>
      </v-list>
      <v-alert v-if="error" type="error" density="compact" variant="tonal" class="ma-2">
        {{ error }}
        <div v-if="errorCode === 'own_password_required'" class="mt-1">
          <a :href="accountHref">{{ $t('identity.toAccount') }}</a>
        </div>
      </v-alert>
    </v-card>
  </v-menu>

  <NewOrgDialog v-model="newOrgOpen" @entered="go" />

  <v-dialog v-model="confirmOpen" max-width="440">
    <v-card>
      <v-card-title class="pt-5 px-6">{{ $t('orgSwitcher.unsavedTitle') }}</v-card-title>
      <v-card-text class="px-6">{{ $t('orgSwitcher.unsavedBody', { org: org?.name ?? '' }) }}</v-card-text>
      <v-card-actions class="px-6 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="cancelPending">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" @click="runPending">{{ $t('orgSwitcher.switchAnyway') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  acceptInvite,
  fetchMyOrgs,
  landingAfterSwitch,
  refusalCode,
  switchOrg,
  type Invitation,
  type OrgChoice,
} from 'ui-shared/session/useOrgSession'
import { hasUnsavedWork, switchBlockedBy } from 'ui-shared/session/switch-guards'
import { portalHref } from 'ui-shared/nav/navigate'
import NewOrgDialog from './NewOrgDialog.vue'
import type { ShellOrg } from './types'

/**
 * The org menu in every app's top bar (multi-org sign-in, Phase 3): the person's orgs, the
 * invitations waiting for them, a new org, and the full picker.
 *
 * A switch changes THIS tab only. The server mints a session for the chosen membership, it
 * becomes this tab's, and the tab reloads into it; every other tab stays in its own org. So a
 * switch is refused while this tab holds something a reload would orphan (a sale, a fiscal
 * printer: `switch-guards`), and asks first when a form has unsaved edits.
 */

defineProps<{ org: ShellOrg | null; mobile?: boolean }>()
const { t, te } = useI18n()
const route = useRoute()

const open = ref(false)
const loading = ref(false)
const orgs = ref<OrgChoice[]>([])
const invitations = ref<Invitation[]>([])
const error = ref('')
const errorCode = ref('')
/** The org id or invitation code being entered: one at a time. */
const busy = ref('')
const newOrgOpen = ref(false)
const confirmOpen = ref(false)
let pending: (() => void) | null = null

const allOrgsHref = computed(() => portalHref('/orgs'))
const accountHref = computed(() => portalHref('/account'))

// Fetched when the menu opens, not on every page load: most pages never open it.
watch(open, async isOpen => {
  if (!isOpen) return
  error.value = ''
  errorCode.value = ''
  loading.value = true
  try {
    const mine = await fetchMyOrgs()
    orgs.value = mine.orgs
    invitations.value = mine.invitations
  } catch {
    error.value = t('orgSwitcher.loadFailed')
  } finally {
    loading.value = false
  }
})

function initials(name: string): string {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase())
  return letters.join('') || '?'
}

function roleLabel(role: string): string {
  return te(`settings.roles.${role}`) ? t(`settings.roles.${role}`) : role
}

function fail(err: unknown) {
  const code = refusalCode(err)
  errorCode.value = code
  error.value = code && te(`identity.errors.${code}`)
    ? t(`identity.errors.${code}`)
    : (err as any)?.response?.data?.message || t('orgSwitcher.failed')
  busy.value = ''
}

/** Run `action` unless something in this tab must not be interrupted; ask first over unsaved edits. */
function guarded(action: () => void) {
  error.value = ''
  errorCode.value = ''
  const blocked = switchBlockedBy()
  if (blocked) {
    error.value = t(blocked)
    return
  }
  if (hasUnsavedWork()) {
    pending = action
    confirmOpen.value = true
    return
  }
  action()
}

function runPending() {
  confirmOpen.value = false
  const action = pending
  pending = null
  action?.()
}

function cancelPending() {
  confirmOpen.value = false
  pending = null
}

function choose(o: OrgChoice) {
  if (o.current) {
    open.value = false
    return
  }
  guarded(async () => {
    busy.value = o.orgId
    try {
      await switchOrg(o.orgId)
      await go()
    } catch (err) {
      fail(err)
    }
  })
}

function join(i: Invitation) {
  guarded(async () => {
    busy.value = i.code
    try {
      await acceptInvite(i.code)
      await go()
    } catch (err) {
      fail(err)
    }
  })
}

function openNewOrg() {
  guarded(() => {
    open.value = false
    newOrgOpen.value = true
  })
}

/** This tab's session is now in another org: reload into it. */
async function go() {
  window.location.href = await landingAfterSwitch({ hasRouteParams: Object.keys(route.params ?? {}).length > 0 })
}
</script>

<style scoped>
.org-switcher__name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-initials {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 600;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.org-initials--invite {
  background: rgba(var(--v-theme-secondary), 0.12);
  color: rgb(var(--v-theme-secondary));
}
/* Same box as the org badges, so every row's text starts in one column. */
.org-initials--action {
  background: transparent;
  color: inherit;
}
</style>
