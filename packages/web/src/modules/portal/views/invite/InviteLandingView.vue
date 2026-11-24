<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center">
      <v-col cols="12" sm="8" md="5">
        <!-- Loading -->
        <v-card v-if="loading" elevation="8" class="pa-8 text-center">
          <v-progress-circular indeterminate color="primary" size="48" />
          <div class="mt-4 text-body-1">{{ $t('invite.loading') }}</div>
        </v-card>

        <!-- Error -->
        <v-card v-else-if="error" elevation="8" class="pa-6">
          <v-card-title class="text-center">
            <v-icon color="error" size="48">mdi-alert-circle-outline</v-icon>
          </v-card-title>
          <v-card-text class="text-center text-h6">{{ $t('invite.notFound') }}</v-card-text>
          <v-card-text class="text-center text-body-2">{{ error }}</v-card-text>
          <v-card-actions class="justify-center">
            <v-btn color="primary" to="/auth/login">{{ $t('invite.goToLogin') }}</v-btn>
          </v-card-actions>
        </v-card>

        <!-- Invalid invite -->
        <v-card v-else-if="inviteInfo && !inviteInfo.isValid" elevation="8" class="pa-6">
          <v-card-title class="text-center">
            <v-icon color="warning" size="48">mdi-link-off</v-icon>
          </v-card-title>
          <v-card-text class="text-center text-h6">{{ $t('invite.unavailable') }}</v-card-text>
          <v-card-text class="text-center">
            <v-chip :color="statusColor(inviteInfo.status)" variant="tonal" class="mb-2">
              {{ inviteInfo.status }}
            </v-chip>
            <div class="text-body-2">{{ $t('invite.noLongerValid') }}</div>
          </v-card-text>
          <v-card-actions class="justify-center">
            <v-btn color="primary" to="/auth/login">{{ $t('invite.goToLogin') }}</v-btn>
          </v-card-actions>
        </v-card>

        <!-- Valid invite -->
        <v-card v-else-if="inviteInfo" elevation="8" class="pa-6">
          <v-card-title class="text-center text-h5">{{ $t('invite.title') }}</v-card-title>
          <v-card-text class="text-center">
            <div class="text-h6 mb-2">{{ inviteInfo.orgName }}</div>
            <div class="text-body-2 mb-4">
              <v-icon size="small" class="mr-1">mdi-account-outline</v-icon>
              {{ $t('invite.invitedBy', { name: inviteInfo.inviterName }) }}
            </div>

            <!-- Not signed in -->
            <template v-if="!isAuth">
              <div class="text-body-2 mb-4">{{ $t('invite.signInOrRegister') }}</div>
              <v-btn color="primary" block size="large" class="mb-2" :to="'/auth/login?invite=' + code">
                {{ $t('invite.loginAndJoin') }}
              </v-btn>
              <v-btn variant="outlined" block :to="'/auth/register?invite=' + code">
                {{ $t('invite.registerToJoin') }}
              </v-btn>
            </template>

            <!-- Signed in, but as an account not yet linked to a person: it can only sign in again. -->
            <template v-else-if="!signedInAs">
              <v-alert type="info" variant="tonal" class="mb-4 text-left">{{ $t('invite.signInAgain') }}</v-alert>
              <v-btn color="primary" variant="outlined" block @click="signOutAndLogin">{{ $t('invite.signOutAndLogin') }}</v-btn>
            </template>

            <!-- Signed in as a person: joining is one click, in this tab. -->
            <template v-else>
              <v-btn color="primary" block size="large" :loading="joining" data-testid="invite-join" @click="join">
                {{ $t('invite.joinAs', { org: inviteInfo.orgName, email: signedInAs }) }}
              </v-btn>
              <v-alert v-if="joinError" type="error" variant="tonal" density="compact" class="mt-4 text-left">
                {{ joinError }}
                <div v-if="joinCode === 'own_password_required'" class="mt-1">
                  <router-link v-if="hasOrgSession()" :to="{ name: 'account' }">{{ $t('identity.toAccount') }}</router-link>
                  <router-link v-else :to="{ name: 'auth.forgot-password' }">{{ $t('auth.forgotPassword') }}</router-link>
                </div>
                <div v-else-if="joinCode === 'already_member'" class="mt-2">
                  <v-btn size="small" color="primary" variant="tonal" @click="openOrg">{{ $t('invite.openOrg', { org: inviteInfo.orgName }) }}</v-btn>
                </div>
                <div v-else-if="joinCode === 'invite_for_other_email' || joinCode === 'not_a_person'" class="mt-2">
                  <v-btn size="small" variant="tonal" @click="signOutAndLogin">{{ $t('invite.signOutAndLogin') }}</v-btn>
                </div>
              </v-alert>
            </template>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { goTo } from 'ui-shared/nav/navigate'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInviteStore } from '../../store/invite.store'
import { useAppStore } from '../../store/app.store'
import { claims, hasOrgSession } from 'ui-shared/session/session'
import { acceptInvite, fetchMyOrgs, refusalCode, switchOrg } from 'ui-shared/session/useOrgSession'

/**
 * An invitation to an org. Signed out: sign in (or register) and come back here. Signed in as a
 * person (multi-org sign-in, Phase 4): join it with one click, as yourself; the server checks the
 * invitation is for your address and that your password is your own (rule 3).
 */

const route = useRoute()
const router = useRouter()
const { t, te } = useI18n()
const inviteStore = useInviteStore()
const appStore = useAppStore()

const code = computed(() => route.params.code as string)
const loading = ref(true)
const error = ref('')
const inviteInfo = computed(() => inviteStore.inviteInfo)
const isAuth = computed(() => appStore.isAuth)
/** The address the person signed in with, when the session names a person (a linked account). */
const signedInAs = computed(() => {
  const c = claims()
  return c?.iid && typeof c.email === 'string' ? c.email : ''
})
const joining = ref(false)
const joinError = ref('')
const joinCode = ref('')

function statusColor(status: string) {
  const map: Record<string, string> = { active: 'success', revoked: 'error', exhausted: 'warning', expired: 'grey' }
  return map[status] || 'grey'
}

/** A full load, so every store in the portal starts from the session in the org just entered. */
function enterApps() {
  sessionStorage.removeItem('lgr_invite_code')
  goTo('/apps')
}

async function join() {
  joining.value = true
  joinError.value = ''
  joinCode.value = ''
  try {
    await acceptInvite(code.value)
    enterApps()
  } catch (err) {
    const refusal = refusalCode(err)
    joinCode.value = refusal
    joinError.value = refusal && te(`identity.errors.${refusal}`)
      ? t(`identity.errors.${refusal}`)
      : (err as any)?.response?.data?.message || t('invite.joinFailed')
    joining.value = false
  }
}

/** Already a member: enter that org instead of joining it again. */
async function openOrg() {
  try {
    const { orgs } = await fetchMyOrgs()
    const target = orgs.find(o => o.slug === inviteInfo.value?.orgSlug)
    if (!target) return
    if (!target.current) await switchOrg(target.orgId)
    enterApps()
  } catch (err) {
    joinError.value = (err as any)?.response?.data?.message || t('orgSwitcher.failed')
  }
}

async function signOutAndLogin() {
  sessionStorage.setItem('lgr_invite_code', code.value)
  await appStore.logout()
  router.push(`/auth/login?invite=${code.value}`)
}

onMounted(async () => {
  sessionStorage.setItem('lgr_invite_code', code.value)
  try {
    await inviteStore.fetchInviteInfo(code.value)
  } catch {
    error.value = inviteStore.error || t('invite.notFound')
  } finally {
    loading.value = false
  }
})
</script>
