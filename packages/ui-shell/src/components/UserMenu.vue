<template>
  <v-menu>
    <template #activator="{ props }">
      <v-btn v-bind="props" variant="text">
        <v-avatar size="32" color="primary" class="mr-2">
          <span class="text-caption text-white">{{ initials }}</span>
        </v-avatar>
        {{ fullName }}
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
