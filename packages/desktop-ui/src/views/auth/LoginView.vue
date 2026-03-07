<template>
  <v-app>
    <v-main class="d-flex align-center justify-center" style="min-height: 100vh">
      <v-card width="420" class="pa-6">
        <v-card-title class="text-h5 text-center mb-4">LGR Desktop</v-card-title>

        <v-alert v-if="error" type="error" class="mb-4" density="compact" closable @click:close="error = ''">
          {{ error }}
        </v-alert>

        <v-form @submit.prevent="handleLogin">
          <v-text-field
            v-model="form.orgSlug"
            label="Organization"
            prepend-inner-icon="mdi-domain"
            variant="outlined"
            density="comfortable"
            class="mb-2"
            required
          />
          <v-text-field
            v-model="form.username"
            label="Username"
            prepend-inner-icon="mdi-account"
            variant="outlined"
            density="comfortable"
            class="mb-2"
            required
          />
          <v-text-field
            v-model="form.password"
            label="Password"
            prepend-inner-icon="mdi-lock"
            type="password"
            variant="outlined"
            density="comfortable"
            class="mb-4"
            required
          />
          <v-btn
            type="submit"
            color="primary"
            block
            size="large"
            :loading="loading"
          >
            Sign In
          </v-btn>
        </v-form>
      </v-card>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'

const router = useRouter()
const appStore = useAppStore()
const loading = ref(false)
const error = ref('')

const form = reactive({
  orgSlug: 'my-company',
  username: 'admin',
  password: '',
})

async function handleLogin() {
  loading.value = true
  error.value = ''
  try {
    await appStore.login(form.username, form.password, form.orgSlug)
    router.push('/')
  } catch (err: any) {
    error.value = err.response?.data?.message || err.message || 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>
