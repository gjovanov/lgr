<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center">
      <v-col cols="12" sm="8" md="5">
        <!-- Loading -->
        <v-card v-if="loading" elevation="8" class="pa-8 text-center">
          <v-progress-circular indeterminate color="primary" size="48" />
          <div class="mt-4 text-body-1">Loading invite...</div>
        </v-card>

        <!-- Error -->
        <v-card v-else-if="error" elevation="8" class="pa-6">
          <v-card-title class="text-center">
            <v-icon color="error" size="48">mdi-alert-circle-outline</v-icon>
          </v-card-title>
          <v-card-text class="text-center text-h6">Invite Not Found</v-card-text>
          <v-card-text class="text-center text-body-2">{{ error }}</v-card-text>
          <v-card-actions class="justify-center">
            <v-btn color="primary" to="/auth/login">Go to Login</v-btn>
          </v-card-actions>
        </v-card>

        <!-- Invalid invite -->
        <v-card v-else-if="inviteInfo && !inviteInfo.isValid" elevation="8" class="pa-6">
          <v-card-title class="text-center">
            <v-icon color="warning" size="48">mdi-link-off</v-icon>
          </v-card-title>
          <v-card-text class="text-center text-h6">Invite Unavailable</v-card-text>
          <v-card-text class="text-center">
            <v-chip :color="statusColor(inviteInfo.status)" variant="tonal" class="mb-2">
              {{ inviteInfo.status }}
            </v-chip>
            <div class="text-body-2">This invite is no longer valid.</div>
          </v-card-text>
          <v-card-actions class="justify-center">
            <v-btn color="primary" to="/auth/login">Go to Login</v-btn>
          </v-card-actions>
        </v-card>

        <!-- Valid invite -->
        <v-card v-else-if="inviteInfo" elevation="8" class="pa-6">
          <v-card-title class="text-center text-h5">You're Invited!</v-card-title>
          <v-card-text class="text-center">
            <div class="text-h6 mb-2">{{ inviteInfo.orgName }}</div>
            <div class="text-body-2 mb-4">
              <v-icon size="small" class="mr-1">mdi-account-outline</v-icon>
              Invited by {{ inviteInfo.inviterName }}
            </div>

            <!-- Not authenticated -->
            <template v-if="!isAuth">
              <div class="text-body-2 mb-4">Create an account to join this organization.</div>
              <v-btn
                color="primary"
                block
                size="large"
                class="mb-2"
                :to="'/auth/register?invite=' + code"
              >
                Register to Join
              </v-btn>
              <v-btn
                variant="outlined"
                block
                :to="'/auth/login?invite=' + code"
              >
                Login & Join
              </v-btn>
            </template>

            <!-- Already authenticated -->
            <template v-else>
              <v-alert type="info" variant="tonal" class="mb-4">
                You are already logged in. To join <strong>{{ inviteInfo.orgName }}</strong>,
                please log out and register a new account.
              </v-alert>
              <v-btn color="primary" variant="outlined" block @click="handleLogout">
                Log Out & Register
              </v-btn>
            </template>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInviteStore } from '../../store/invite.store'
import { useAppStore } from '../../store/app.store'

const route = useRoute()
const router = useRouter()
const inviteStore = useInviteStore()
const appStore = useAppStore()

const code = computed(() => route.params.code as string)
const loading = ref(true)
const error = ref('')
const inviteInfo = computed(() => inviteStore.inviteInfo)
const isAuth = computed(() => appStore.isAuth)

function statusColor(status: string) {
  const map: Record<string, string> = { active: 'success', revoked: 'error', exhausted: 'warning', expired: 'grey' }
  return map[status] || 'grey'
}

function handleLogout() {
  sessionStorage.setItem('lgr_invite_code', code.value)
  appStore.logout()
  router.push(`/auth/register?invite=${code.value}`)
}

onMounted(async () => {
  sessionStorage.setItem('lgr_invite_code', code.value)
  try {
    await inviteStore.fetchInviteInfo(code.value)
  } catch {
    error.value = inviteStore.error || 'Invite not found'
  } finally {
    loading.value = false
  }
})
</script>
