<template>
  <!-- FR-05 (#12): hover-opens on true-hover desktops; tap unchanged. -->
  <v-menu :open-on-hover="hoverEnabled" :open-on-click="true" :open-delay="openDelay" :close-delay="closeDelay">
    <template #activator="{ props }">
      <v-btn v-bind="props" :icon="compact" variant="text">
        <v-avatar size="32" color="primary">
          <span class="text-caption text-white">{{ initials }}</span>
        </v-avatar>
        <span v-if="!compact" class="ml-2">{{ fullName }}</span>
      </v-btn>
    </template>
    <v-list density="compact">
      <v-list-item prepend-icon="mdi-account" :title="$t('account.menu')" @click="$emit('profile')" />
      <v-divider />
      <v-list-item prepend-icon="mdi-logout" :title="$t('auth.logout')" @click="$emit('logout')" />
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useHoverMenus } from 'ui-shared/composables/useHoverMenus'
import type { ShellUser } from './types'

const { hoverEnabled, openDelay, closeDelay } = useHoverMenus()

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
