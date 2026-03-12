<template>
  <v-menu>
    <template #activator="{ props }">
      <v-btn v-bind="props" :icon="compact" variant="text">
        <v-avatar size="32" color="primary">
          <span class="text-caption text-white">{{ initials }}</span>
        </v-avatar>
        <span v-if="!compact" class="ml-2">{{ fullName }}</span>
      </v-btn>
    </template>
    <v-list density="compact">
      <v-list-item prepend-icon="mdi-account" title="Profile" @click="$emit('profile')" />
      <v-divider />
      <v-list-item prepend-icon="mdi-logout" :title="$t('auth.logout')" @click="$emit('logout')" />
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ShellUser } from './types'

const props = defineProps<{
  user: ShellUser | null
  compact?: boolean
}>()

defineEmits<{
  logout: []
  profile: []
}>()

const fullName = computed(() => {
  if (!props.user) return ''
  return `${props.user.firstName} ${props.user.lastName}`.trim()
})

const initials = computed(() => {
  if (!props.user) return ''
  return `${props.user.firstName?.[0] || ''}${props.user.lastName?.[0] || ''}`
})
</script>
