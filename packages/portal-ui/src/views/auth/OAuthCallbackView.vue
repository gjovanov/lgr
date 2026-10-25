<template>
  <v-card elevation="8" class="pa-6 text-center">
    <v-progress-circular v-if="!error" indeterminate color="primary" size="64" />
    <div v-if="!error" class="mt-4 text-body-1">{{ $t('auth.completingSignIn') }}</div>
    <v-alert v-if="error" type="error" class="mt-4">
      {{ error }}
      <template #append>
        <v-btn variant="text" to="/auth/login">{{ $t('auth.activation.backToLogin') }}</v-btn>
      </template>
    </v-alert>
  </v-card>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { takeIdpResume } from './idp'

/**
 * The landing page of an OAuth sign-in.
 *
 * ⚠ It reads NOTHING from the URL. It used to take `?token=` and store it, which meant
 * `https://lgrai.app/auth/oauth-callback?token=<attacker's JWT>` signed the visitor into the
 * attacker's account and org — the same login fixation FR-14.24 closed for the cross-SPA
 * handoff, still open here precisely because this route had to be exempted from that gate.
 *
 * The credential is now the single-use, httpOnly `oauth_handoff` cookie the callback set, which
 * an attacker cannot write on our origin. So this page POSTs an empty body and lets the server
 * read it. A hand-crafted URL reaches the message below instead of a session.
 *
 * Where it goes next follows the password sign-in: an invitation waiting in this tab, the org
 * picker when the person has not entered an org (multi-org sign-in), else the app.
 */

const router = useRouter()
const appStore = useAppStore()
const { t } = useI18n()
const error = ref('')

onMounted(async () => {
  try {
    const answer = await appStore.completeOAuthLogin()
    // FR-20.39: back to a server's "Sign in with LGR" authorize page, when that is what sent us.
    const resume = takeIdpResume()
    if (resume) return router.push(resume)
    const invite = sessionStorage.getItem('lgr_invite_code')
    if (invite) router.push({ name: 'invite', params: { code: invite } })
    else if (answer.needsOrgChoice) router.push({ name: 'orgs' })
    else router.push('/dashboard')
  } catch (e: any) {
    // The server answers 400 with one message for every refusal — unknown, expired or already
    // redeemed — so there is nothing here to tell them apart with, by design.
    error.value = e?.response?.data?.message || t('auth.errors.oauth_failed')
  }
})
</script>
