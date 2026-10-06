<template>
  <v-card elevation="8">
    <v-card-title class="text-h5 text-center pt-6">{{ $t('orgPicker.title') }}</v-card-title>
    <v-card-subtitle class="text-center pb-2">{{ $t('orgPicker.subtitle') }}</v-card-subtitle>
    <v-card-text class="px-6">
      <div v-if="loading" class="d-flex justify-center py-6">
        <v-progress-circular indeterminate color="primary" />
      </div>

      <template v-else>
        <v-list v-if="orgs.length" lines="two" class="py-0" data-testid="org-picker-list">
          <v-list-item
            v-for="o in orgs"
            :key="o.orgId"
            :active="o.current"
            color="primary"
            rounded="lg"
            class="mb-1"
            :disabled="!!busy"
            data-testid="org-picker-org"
            @click="choose(o)"
          >
            <template #prepend>
              <span class="org-initials mr-4">{{ initials(o.name) }}</span>
            </template>
            <v-list-item-title class="font-weight-medium">{{ o.name }}</v-list-item-title>
            <v-list-item-subtitle>{{ o.slug }} · {{ roleLabel(o.role) }}</v-list-item-subtitle>
            <template #append>
              <v-progress-circular v-if="busy === o.orgId" indeterminate size="20" width="2" />
              <v-chip v-else-if="o.current" size="small" color="primary" variant="tonal">{{ $t('orgPicker.current') }}</v-chip>
              <v-icon v-else>mdi-chevron-right</v-icon>
            </template>
          </v-list-item>
        </v-list>
        <v-alert v-else type="info" variant="tonal" density="compact" class="mb-2">{{ $t('orgPicker.none') }}</v-alert>

        <template v-if="invitations.length">
          <div class="text-overline mt-4">{{ $t('orgSwitcher.invitations') }}</div>
          <v-list lines="two" class="py-0">
            <v-list-item v-for="i in invitations" :key="i.code" rounded="lg" :disabled="!!busy && busy !== i.code">
              <template #prepend>
                <span class="org-initials org-initials--invite mr-4">{{ initials(i.name) }}</span>
              </template>
              <v-list-item-title class="font-weight-medium">{{ i.name }}</v-list-item-title>
              <v-list-item-subtitle>{{ roleLabel(i.role) }}</v-list-item-subtitle>
              <template #append>
                <v-btn color="primary" variant="tonal" size="small" :loading="busy === i.code" @click="join(i)">
                  {{ $t('orgSwitcher.join') }}
                </v-btn>
              </template>
            </v-list-item>
          </v-list>
        </template>

        <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mt-4">
          {{ error }}
          <div v-if="errorCode === 'own_password_required' && canOpenAccount" class="mt-1">
            <router-link :to="{ name: 'account' }">{{ $t('identity.toAccount') }}</router-link>
          </div>
          <div v-else-if="errorCode === 'own_password_required'" class="mt-1">
            <router-link :to="{ name: 'auth.forgot-password' }">{{ $t('auth.forgotPassword') }}</router-link>
          </div>
        </v-alert>
      </template>
    </v-card-text>

    <v-divider class="mx-6" />
    <v-card-actions class="px-6 py-4">
      <v-btn variant="text" prepend-icon="mdi-plus" :disabled="!!busy || loading" @click="newOrgOpen = true">
        {{ $t('orgSwitcher.newOrg') }}
      </v-btn>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-logout" :disabled="!!busy" @click="signOut">{{ $t('auth.logout') }}</v-btn>
    </v-card-actions>

    <NewOrgDialog v-model="newOrgOpen" @entered="enterApps" />
  </v-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import NewOrgDialog from 'ui-shell/components/NewOrgDialog'
import {
  acceptInvite,
  fetchMyOrgs,
  refusalCode,
  switchOrg,
  type Invitation,
  type OrgChoice,
} from 'ui-shared/session/useOrgSession'
import { hasOrgSession } from 'ui-shared/session/session'
import { useAppStore } from '../store/app.store'

/**
 * The person's orgs (multi-org sign-in, Phase 3): where a sign-in lands when there is no org to
 * enter yet, and the org menu's "All organizations". Choosing one enters it in THIS tab.
 */

const router = useRouter()
const appStore = useAppStore()
const { t, te } = useI18n()

const loading = ref(true)
const orgs = ref<OrgChoice[]>([])
const invitations = ref<Invitation[]>([])
const busy = ref('')
const error = ref('')
const errorCode = ref('')
const newOrgOpen = ref(false)
/** The account page needs an org session; a person in no org yet resets the password instead. */
const canOpenAccount = computed(() => hasOrgSession())

onMounted(async () => {
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

/** A full load, so every store in the portal starts from the new session. */
function enterApps() {
  sessionStorage.removeItem('lgr_invite_code')
  window.location.href = '/apps'
}

async function choose(o: OrgChoice) {
  if (o.current) return enterApps()
  busy.value = o.orgId
  error.value = ''
  try {
    await switchOrg(o.orgId)
    enterApps()
  } catch (err) {
    fail(err)
  }
}

async function join(i: Invitation) {
  busy.value = i.code
  error.value = ''
  try {
    await acceptInvite(i.code)
    enterApps()
  } catch (err) {
    fail(err)
  }
}

async function signOut() {
  await appStore.logout()
  router.push({ name: 'auth.login' })
}
</script>

<style scoped>
.org-initials {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.org-initials--invite {
  background: rgba(var(--v-theme-secondary), 0.12);
  color: rgb(var(--v-theme-secondary));
}
</style>
