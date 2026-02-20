<template>
  <v-card elevation="8" class="pa-6 text-center">
    <v-progress-circular v-if="!error" indeterminate color="primary" size="64" />
    <div v-if="!error" class="mt-4 text-body-1">Completing login...</div>
    <v-alert v-if="error" type="error" class="mt-4">
      {{ error }}
      <template #append>
        <v-btn variant="text" to="/auth/login">Back to login</v-btn>
      </template>
    </v-alert>
  </v-card>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '../../store/app.store'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const error = ref('')

onMounted(async () => {
  const token = route.query.token as string
  if (!token) {
    error.value = 'No token received from OAuth provider'
    return
  }

  try {
    appStore.token = token
    localStorage.setItem('lgr_token', token)
    await appStore.fetchProfile()
    router.push('/dashboard')
  } catch (e: any) {
    error.value = 'Failed to complete OAuth login'
    appStore.token = ''
    localStorage.removeItem('lgr_token')
  }
})
</script>
